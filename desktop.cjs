/**
 * Electron desktop wrapper for Voice Work Supervisor.
 * Spawns the supervisor server as a child process and wraps the web UI securely.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

let mainWindow = null;
let serverUrl = null;
let serverOrigin = null;

// Spawn the server using process.execPath with ELECTRON_RUN_AS_NODE=1
const child = spawn(
  process.execPath,
  ['--env-file-if-exists=.env', 'src/server.mjs'],
  {
    cwd: __dirname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  }
);

function killChild() {
  if (child && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

child.on('error', err => {
  console.error(`[desktop] Failed to spawn supervisor server: ${err.message}`);
  app.quit();
});

child.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    console.error(`[desktop] Supervisor server exited with code ${code} (${signal || 'none'})`);
  }
  app.quit();
});

child.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  const text = chunk.toString();
  const match = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/);
  if (match && !serverUrl) {
    serverUrl = match[0];
    try {
      serverOrigin = new URL(serverUrl).origin;
    } catch {
      serverOrigin = serverUrl;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(serverUrl);
    }
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Voice Work Supervisor',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (serverUrl) {
    mainWindow.loadURL(serverUrl);
  }

  // Restrict navigation: only app same-origin is allowed
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const target = new URL(navigationUrl);
      if (!serverOrigin || target.origin !== serverOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  // Block popup windows and external navigation
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

app.whenReady().then(() => {
  // Enforce permissions: only microphone/media allowed, and only for the local app origin
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    try {
      const requestingOrigin = new URL(details.requestingUrl || webContents.getURL()).origin;
      if (serverOrigin && requestingOrigin === serverOrigin && (permission === 'media' || permission === 'microphone')) {
        return callback(true);
      }
    } catch {}
    return callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (serverOrigin && requestingOrigin === serverOrigin && (permission === 'media' || permission === 'microphone')) {
      return true;
    }
    return false;
  });

  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', killChild);
app.on('will-quit', killChild);
process.on('exit', killChild);
process.on('SIGINT', () => {
  killChild();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killChild();
  process.exit(0);
});
