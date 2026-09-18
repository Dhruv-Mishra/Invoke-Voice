const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session, dialog, shell, ipcMain } = require('electron');
const { serverLaunch, allowedExternal } = require('./scripts/desktop-launch.cjs');
const { checkForUpdate, downloadUpdate, publicUpdate } = require('./desktop-update.cjs');

if (process.env.VOICE_SUPERVISOR_DISABLE_GPU === '1') app.disableHardwareAcceleration();

let mainWindow = null;
let serverOrigin = null;
let child;
let closing = false;
let stopped = false;
let failed = false;
let startupTimer;
let logDescriptor;
let pendingUpdate;
let installingUpdate = false;
const ownedChildren = new Set();
const dataDir = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'VoiceSupervisor');
const logFile = path.join(dataDir, 'logs', 'desktop.log');
let dataPathError = false;
try {
  fs.mkdirSync(path.join(dataDir, 'desktop'), { recursive: true });
  app.setPath('userData', path.join(dataDir, 'desktop'));
} catch { dataPathError = true; }

function fail(message) {
  if (failed || closing) return;
  failed = true;
  clearTimeout(startupTimer);
  dialog.showErrorBox('Voice Work Supervisor could not start', `${message}\n\nClose and reopen the app. Check security software and the local log:\n${logFile}`);
  app.quit();
}

function external(value) {
  if (allowedExternal(value)) void shell.openExternal(value).catch(() => {});
}

function trustedRenderer(event) {
  try {
    return event.sender === mainWindow?.webContents && serverOrigin && new URL(event.senderFrame.url).origin === serverOrigin;
  } catch { return false; }
}

function logDesktopError(label, error) {
  try { fs.writeSync(logDescriptor, `${label}: ${error?.stack || error}\n`); } catch {}
}

ipcMain.handle('updates:check', async event => {
  if (!trustedRenderer(event)) return { supported: false, error: 'Update requests are available only from the local application.' };
  if (!app.isPackaged) return { supported: false, currentVersion: app.getVersion() };
  try {
    pendingUpdate = await checkForUpdate(app.getVersion(), { edition: require('./package.json').distributionEdition || 'bundled' });
    return { supported: true, ...publicUpdate(pendingUpdate) };
  } catch (error) {
    logDesktopError('Update check failed', error);
    return { supported: true, error: 'Could not check GitHub Releases. Check your network or proxy access and try again.' };
  }
});

ipcMain.handle('updates:install', async event => {
  if (!trustedRenderer(event) || !app.isPackaged) return { started: false, error: 'Updates can be installed only from the installed desktop application.' };
  if (installingUpdate) return { started: false, error: 'An update is already being prepared.' };
  if (!pendingUpdate?.available) return { started: false, error: 'Check for updates before installing.' };
  installingUpdate = true;
  try {
    const installer = await downloadUpdate(pendingUpdate, path.join(app.getPath('temp'), 'VoiceSupervisor', 'updates'));
    const installerChild = spawn(installer, [], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    await new Promise((resolve, reject) => {
      installerChild.once('spawn', resolve);
      installerChild.once('error', reject);
    });
    installerChild.unref();
    setImmediate(() => { void stop(); });
    return { started: true };
  } catch (error) {
    installingUpdate = false;
    logDesktopError('Update installation failed', error);
    return { started: false, error: 'The update could not be verified or started. Check GitHub access and available disk space, then try again.' };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Voice Work Supervisor',
    icon: path.join(__dirname, 'build', 'copilot.png'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7f6',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f7f6', symbolColor: '#202624', height: 32 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'desktop-preload.cjs'),
    },
  });

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const target = new URL(navigationUrl);
      if (!serverOrigin || target.origin !== serverOrigin) {
        event.preventDefault();
        external(navigationUrl);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    try { fs.writeSync(logDescriptor, `Renderer stopped: ${details.reason}; exit code ${details.exitCode}.\n`); } catch {}
    fail(`The app window stopped unexpectedly (${details.reason}).`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

async function launch() {
  if (dataPathError) { fail('The app cannot access its per-user data directory.'); return; }
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  logDescriptor = fs.openSync(logFile, 'w');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (details.mediaTypes?.includes('video')) return callback(false);
    try {
      const requestingOrigin = new URL(details.requestingUrl || webContents.getURL()).origin;
      if (serverOrigin && requestingOrigin === serverOrigin && (permission === 'media' || permission === 'microphone' || permission === 'notifications')) {
        return callback(true);
      }
    } catch {}
    return callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (serverOrigin && requestingOrigin === serverOrigin && (permission === 'media' || permission === 'microphone' || permission === 'notifications')) {
      return true;
    }
    return false;
  });

  createWindow();
  const spec = serverLaunch({ executable: process.execPath, appRoot: __dirname, resourcesPath: process.resourcesPath, packaged: app.isPackaged, dataDir });
  child = spawn(spec.executable, spec.args, { ...spec.options, stdio: ['ignore', logDescriptor, logDescriptor, 'ipc'] });
  startupTimer = setTimeout(() => fail('The local server did not start within 45 seconds.'), 45000);
  child.once('error', () => fail('The bundled local server could not be launched.'));
  child.once('exit', code => { if (!closing) fail(`The local server stopped (code ${code}).`); });
  child.on('message', message => {
    if (message?.type === 'owned-child' && Number.isSafeInteger(message.pid) && message.pid > 0) {
      if (message.active) ownedChildren.add(message.pid); else ownedChildren.delete(message.pid);
    }
    if (message?.type !== 'supervisor-ready' || serverOrigin || closing) return;
    try {
      const url = new URL(message.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Invalid local URL');
      serverOrigin = url.origin;
      clearTimeout(startupTimer);
      mainWindow.loadURL(serverOrigin).then(() => { if (!closing) mainWindow.show(); }).catch(() => fail('The local app page could not be loaded.'));
    } catch { fail('The local server returned an invalid address.'); }
  });
}

async function killTree(pid) {
  if (process.platform !== 'win32') { try { process.kill(pid); } catch {} return; }
  await new Promise(resolve => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('exit', resolve);
    killer.once('error', resolve);
  });
}

async function stop() {
  closing = true;
  clearTimeout(startupTimer);
  if (child?.connected) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.send({ type: 'shutdown' }, () => {});
    });
  }
  if (child?.pid && child.exitCode === null) await killTree(child.pid);
  for (const pid of ownedChildren) await killTree(pid);
  if (logDescriptor !== undefined) fs.closeSync(logDescriptor);
  stopped = true;
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(launch).catch(() => fail('The app could not initialize its writable data folder or window.'));
}
app.on('before-quit', event => {
  if (stopped || (!child && logDescriptor === undefined)) return;
  event.preventDefault();
  if (!closing) void stop();
});
process.once('SIGINT', () => app.quit());
process.once('SIGTERM', () => app.quit());
