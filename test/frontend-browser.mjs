import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { WebSocketServer } from 'ws';
import desktopLaunch from '../scripts/desktop-launch.cjs';
import { createRuntimeConfig } from '../src/runtime-config.mjs';

if (process.env.VOICE_SUPERVISOR_DISABLE_GPU === '1') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,CalculateNativeWinOcclusion');
let server;
let restartedServer;
const preferenceDir = mkdtempSync(path.join(os.tmpdir(), 'invoke-browser-preferences-'));
let preferences = desktopLaunch.createPreferenceStore(preferenceDir);
ipcMain.on('preferences:get', (event, key) => { event.returnValue = preferences.getItem(key); });
ipcMain.on('preferences:set', (event, key, value) => {
  event.returnValue = false;
  try { preferences.setItem(key, value); event.returnValue = true; } catch {}
});
let browser;
let chatResponse;
let chatRequest;
let voiceServer;
let voiceSocket;
let voiceStartRequest;
let voiceConnections = 0;
let eventConnections = 0;
let eventResponse;
let setupReads = 0;
let setupWrites = 0;
let settingsWrites = 0;
let agencyChecks = 0;
let windowTheme;
const resetRequests = [];
ipcMain.handle('data-reset:info', () => ({ supported: true, path: 'C:\\Users\\fixture\\AppData\\Local\\VoiceSupervisor' }));
ipcMain.handle('data-reset:clear', (_event, confirmation) => { resetRequests.push(confirmation); return { started: true }; });
const calendarRequests = [];
const cancelRequests = [];
let configReads = 0;
let configHttpStatus = 200;
const configWrites = [];
let setupHttpStatus = 200;
const setupRequests = [];
const fixtureNotifications = [];
const voiceNotifications = [];
let notificationReadRace = false;
const fixtureTasks = [
  { id: 'finished-task', title: 'Completed coding work', state: 'completed', result: '**Ready for review**', createdAt: '2026-09-16T09:00:00Z' },
  { id: 'active-task', title: '<img src=x onerror=alert(1)> coding task', state: 'running', canMessage: true, canCancel: true, queued: 1, queuePaused: false, turns: [{ state: 'queued', message: 'If successful, summarize <img src=x onerror=alert(1)>.' }], createdAt: '2026-09-16T10:00:00Z' },
];
const setup = {
  platform: 'win32', supported: true, cacheDir: 'C:\\VoiceSupervisor\\cache', runtimeDir: 'C:\\VoiceSupervisor\\runtime',
  status: 'idle', stage: '', message: 'Ready to install',
  capabilities: { chat: { ready: false, message: 'Local chat is not ready.' }, voice: { ready: false, message: 'Local voice is not ready.' } },
  components: [
    { id: 'runtime', label: 'Local runtime', ready: false, sourceUrl: 'https://example.com/runtime' },
    { id: 'model', label: 'Voice model', ready: false, sourceUrl: 'javascript:alert(1)' },
  ],
  hardware: { logicalCpus: 8, memoryGiB: 32, warning: null },
};
const errors = [];
const settings = {};
const config = {
  local: { sttProvider: 'whisper' },
  providers: [{ id: 'local', label: 'Local', model: 'fixture', configured: true }, { id: 'openai', label: 'OpenAI', model: 'openai-fixture', configured: true }, { id: 'gemini', label: 'Google', model: 'google-fixture', configured: true }],
  voiceModes: [{ id: 'local', label: 'Local voice', configured: true }, { id: 'openai-realtime', label: 'OpenAI', model: 'gpt-realtime', configured: true }, { id: 'gemini-live', label: 'Google', model: 'gemini-live-fixture', configured: true }],
  defaults: { provider: 'local', voiceMode: 'local' },
  configuration: { fields: [
    ...createRuntimeConfig({ dataDir: preferenceDir, env: {} }).snapshot().fields.filter(field => field.key === 'LOCAL_ROUTER'),
    { key: 'OPENAI_BASE_URL', label: 'OpenAI URL', group: 'Fixture', type: 'url', secret: false, value: 'https://example.test' },
    { key: 'LLAMA_THREADS', label: 'Threads', group: 'Fixture', type: 'number', secret: false, value: '8', min: 1, max: 128, restartRequired: true },
    { key: 'OPENAI_API_KEY', label: 'OpenAI key', group: 'Fixture', type: 'password', secret: true, configured: true },
    { key: 'LOCAL_STT_PROVIDER', label: 'Local speech recognition', group: 'Local speech', type: 'select', value: 'whisper', options: [{ value: 'whisper', label: 'Whisper Small (INT8)' }, { value: 'moonshine', label: 'Moonshine Tiny (streaming)' }] },
    { key: 'AGENCY_WORK_DATA_ACCESS', label: 'Private work sources', description: 'Uses cloud services; questions and answers are saved and may be spoken.', group: 'Coding tools', type: 'select', value: 'disabled', options: [{ value: 'disabled', label: 'Off' }, { value: 'read-only', label: 'Read-only' }] },
  ] },
};

const evaluate = (callback, ...args) => browser.webContents.executeJavaScript(`(${callback})(${args.map(value => JSON.stringify(value)).join(',')})`, true);
const resizeWindow = (width, height) => {
  if (browser.isMinimized()) browser.restore();
  browser.setContentSize(width, height);
};
const click = selector => evaluate(value => {
  const button = document.querySelector(value);
  button.focus();
  button.click();
}, selector);
const settle = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  .then(() => Promise.all(document.getAnimations()
    .filter(animation => animation.playState === 'running' && !animation.pending
      && animation.effect.target?.checkVisibility() && Number.isFinite(animation.effect.getComputedTiming().endTime))
    .map(animation => animation.finished.catch(() => {})))));
const visit = async view => {
  if (await evaluate(() => document.getElementById('view-dialog').matches(':modal'))) await click('#close-view-btn');
  await click(`#${view}-tab`);
  await settle();
};
const press = async (key, modifiers = 0) => {
  const windowsVirtualKeyCode = { Tab: 9, Enter: 13, Escape: 27, Space: 32, ArrowUp: 38, ArrowDown: 40, a: 65 }[key];
  const event = { key: key === 'Space' ? ' ' : key, code: key === 'a' ? 'KeyA' : key, modifiers, windowsVirtualKeyCode };
  await browser.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  await browser.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  await settle();
};
const pointerClick = async selector => {
  const point = await evaluate(target => {
    const control = document.querySelector(target);
    control.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = control.getBoundingClientRect();
    const position = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const hit = document.elementFromPoint(position.x, position.y);
    return { ...position, reachable: control.contains(hit), hit: hit?.outerHTML.slice(0, 250), dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.id) };
  }, selector);
  assert.equal(point.reachable, true, `${selector} must receive pointer input: ${JSON.stringify(point)}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  await settle();
};
const typeText = async (selector, text) => {
  await pointerClick(selector);
  assert.equal(await evaluate(target => document.activeElement === document.querySelector(target), selector), true, `${selector} must retain focus`);
  await press('a', 2);
  for (const character of text) {
    await browser.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: character, code: character === ' ' ? 'Space' : '', text: character });
    await browser.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: character, code: character === ' ' ? 'Space' : '' });
  }
  assert.equal(await evaluate(target => document.querySelector(target).value, selector), text, `${selector} must accept keyboard entry including spaces`);
};
const checkEditableInputs = async scope => {
  const inputs = await evaluate(selector => [...document.querySelectorAll(`${selector} input, ${selector} textarea`)]
    .filter(input => !input.disabled && !input.readOnly && input.getClientRects().length && !['hidden', 'checkbox', 'radio'].includes(input.type))
    .map(input => {
      const style = getComputedStyle(input);
      const placeholder = getComputedStyle(input, '::placeholder');
      const field = input.closest('.form-group, .tool-field, .config-field');
      return {
        id: input.id, type: input.type, value: input.value,
        spacingMatches: style.paddingTop === '8px' && style.paddingBottom === '8px'
          && style.paddingLeft === '12px' && style.paddingRight === '12px'
          && style.borderRadius === '8px' && Number.parseFloat(style.minHeight) >= 44
          && (input.tagName === 'TEXTAREA' || input.getBoundingClientRect().height === 44)
          && (!field || getComputedStyle(field).rowGap === '8px'),
        fontMatches: style.fontSize === (innerWidth <= 760 ? '16px' : '15px')
          && style.fontFamily === getComputedStyle(document.body).fontFamily && style.fontWeight === '400'
          && placeholder.fontFamily === style.fontFamily && placeholder.fontSize === style.fontSize
          && placeholder.fontWeight === style.fontWeight,
      };
    }), scope);
  for (const input of inputs) {
    assert.equal(input.spacingMatches, true, `${input.id} must use shared field dimensions, padding and label spacing`);
    assert.equal(input.fontMatches, true, `${input.id} must use the responsive field type scale`);
    await typeText(`#${input.id}`, input.type === 'number' ? '12' : 'Editable field with spaces');
    await evaluate(({ id, value }) => { document.getElementById(id).value = value; }, input);
  }
  return inputs.length;
};
async function assertPainted(selector) {
  const bounds = await evaluate(target => {
    const box = document.querySelector(target).getBoundingClientRect();
    return { x: Math.ceil(box.left), y: Math.ceil(box.top), width: Math.floor(box.width), height: Math.floor(box.height) };
  }, selector);
  const pixels = (await browser.webContents.capturePage(bounds)).toBitmap();
  const shades = new Set();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    shades.add(`${pixels[offset] >> 4},${pixels[offset + 1] >> 4},${pixels[offset + 2] >> 4}`);
  }
  assert.ok(shades.size > 8, `${selector} should paint text and controls, not a blank surface`);
}
const choose = (selector, value) => evaluate((target, selection) => {
  const input = document.querySelector(target);
  input.value = selection;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, selector, value);
const waitFor = condition => browser.webContents.executeJavaScript(`new Promise((resolve, reject) => {
  const deadline = performance.now() + 15000;
  function check() {
    if ((${condition})()) return resolve(true);
    if (performance.now() > deadline) return reject(new Error('Timed out: ' + ${JSON.stringify(String(condition))}));
    requestAnimationFrame(check);
  }
  check();
})`);
const voice = async payload => {
  voiceSocket.send(JSON.stringify(payload));
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
async function screenshot(name) {
  if (!process.env.FRONTEND_SCREENSHOTS) return;
  await mkdir(process.env.FRONTEND_SCREENSHOTS, { recursive: true });
  const image = await browser.webContents.capturePage();
  await writeFile(path.join(process.env.FRONTEND_SCREENSHOTS, `${name}.png`), image.toPNG());
}

async function runBrowserChecks() {
try {
  console.log('Browser fixture: waiting for Electron');
  await app.whenReady();
  console.log('Browser fixture: starting local production fixture');
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith('/api/')) {
        if (request.url === '/api/events') {
          eventConnections++;
          eventResponse = response;
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write(': connected\n\n');
          return;
        }
        if (request.url === '/api/chat') {
          let body = '';
          for await (const chunk of request) body += chunk;
          chatRequest = JSON.parse(body);
          chatResponse = response;
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write(`data: ${JSON.stringify({ type: 'text', text: 'Streaming reply' })}\n\n`);
          return;
        }
        if (request.url === '/api/setup') {
          if (request.method === 'POST') {
            let body = '';
            for await (const chunk of request) body += chunk;
            setupWrites++;
            setupRequests.push(JSON.parse(body));
            Object.assign(setup, { status: 'running', stage: 'download', message: 'Downloading runtime', error: '', progress: { received: 1024 ** 3, total: 5 * 1024 ** 3 } });
          } else setupReads++;
          response.writeHead(setupHttpStatus, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(setupHttpStatus === 200 ? setup : { error: 'Setup service unavailable' }));
          return;
        }
        if (request.url === '/api/agency/check' && request.method === 'POST') {
          agencyChecks += 1;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ workDataAccess: 'disabled', results: [{ id: 'workiq', status: 'authentication_required', message: 'Sign in with Agency, then retry.' }], integrations: [{ id: 'workiq', label: 'WorkIQ', status: 'authentication_required', mode: 'agency', message: 'Sign in again. <img src=x onerror=alert(1)>' }] }));
          return;
        }
        if (request.url === '/api/settings' && request.method === 'POST') {
          let body = '';
          for await (const chunk of request) body += chunk;
          Object.assign(settings, JSON.parse(body));
          settingsWrites++;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(settings));
          return;
        }
        if (request.url === '/api/notifications/read' && request.method === 'POST') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const { ids } = JSON.parse(body);
          if (notificationReadRace) {
            notificationReadRace = false;
            fixtureNotifications.push({ id: 'race', taskId: 'finished-task', title: 'Arrived during read', text: 'Still unread', at: Date.now(), state: 'completed', read: false });
          }
          for (const item of fixtureNotifications) if (ids.includes(item.id)) item.read = true;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ notifications: fixtureNotifications }));
          return;
        }
        if (request.url === '/api/tools' && request.method === 'POST') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const input = JSON.parse(body);
          if (input.name === 'cancel_work') {
            cancelRequests.push(input.args.taskId);
            const task = fixtureTasks.find(item => item.id === input.args.taskId);
            Object.assign(task, { state: 'cancelled', canCancel: false, canMessage: true, deletable: true, queued: 0, result: 'Cancelled. Already completed changes were not undone.' });
            for (const turn of task.turns) turn.state = 'cancelled';
            eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings, notifications: fixtureNotifications } })}\n\n`);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ taskId: task.id, state: task.state }));
            return;
          }
          if (input.name === 'start_work') {
            calendarRequests.push(input);
            fixtureTasks.push({ id: 'calendar-task', title: 'Today\'s calendar', state: 'running', readOnly: true });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ taskId: 'calendar-task', state: 'running' }));
            return;
          }
          assert.equal(input.name, 'control_app');
          assert.equal(input.args.action, 'clear_notifications');
          fixtureNotifications.length = 0;
          eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings, notifications: fixtureNotifications } })}\n\n`);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ saved: true, action: 'clear_notifications' }));
          return;
        }
        if (request.url === '/api/config') {
          configReads++;
          if (request.method === 'POST') {
            let body = '';
            for await (const chunk of request) body += chunk;
            const values = JSON.parse(body).values;
            configWrites.push(values);
            if (configHttpStatus !== 200) {
              response.writeHead(configHttpStatus, { 'Content-Type': 'application/json' });
              response.end(JSON.stringify({ error: 'Could not save configuration.' }));
              return;
            }
            for (const field of config.configuration.fields) {
              if (field.key in values) field.value = values[field.key];
              if (field.key === 'LLAMA_THREADS') field.pendingRestart = field.value !== '8';
            }
            if (values.LOCAL_STT_PROVIDER) {
              config.local.sttProvider = values.LOCAL_STT_PROVIDER;
              setup.message = `${values.LOCAL_STT_PROVIDER} selected`;
            }
            if ('AGENCY_WORK_DATA_ACCESS' in values) assert.deepEqual(Object.keys(values), ['AGENCY_WORK_DATA_ACCESS']);
          }
        }
        const routes = {
          '/api/config': config,
          '/api/state': { areas: [{ id: 'fixture-area', name: 'Fixture repository', repoPath: 'C:\\fixture' }], tasks: fixtureTasks, notifications: fixtureNotifications, settings },
          '/api/areas/fixture-area/agents': [{ id: 'agent', name: 'Default agent' }],
          '/api/tools': [{ type: 'function', function: { name: 'list_work', description: 'List work', parameters: { type: 'object', properties: { query: { type: 'string' }, prompt: { type: 'string' } } } } }],
        };
        response.writeHead(request.url in routes ? 200 : 404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(routes[request.url] || { error: 'Fixture route unavailable' }));
        return;
      }
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      const target = path.resolve(root, filename);
      if (!target.startsWith(root)) { response.writeHead(403).end(); return; }
      const content = await readFile(pathname === '/capture-worklet.js' ? new URL('../public/capture-worklet.js', import.meta.url) : target);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };
      response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
      response.end(content);
    } catch (error) {
      response.writeHead(404).end(error.code || 'Fixture error');
    }
  });
  voiceServer = new WebSocketServer({ server, path: '/voice' });
  voiceServer.on('connection', socket => {
    voiceSocket = socket;
    voiceConnections++;
    socket.on('message', source => {
      const message = JSON.parse(source);
      if (message.type === 'start') {
        voiceStartRequest = message;
        socket.send(JSON.stringify({ type: 'ready' }));
      }
      if (message.type === 'notify') {
        voiceNotifications.push(message);
        socket.send(JSON.stringify({ type: 'notify_ack', notificationId: message.notificationId }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log('Browser fixture: loading UI');
  ipcMain.on('window:theme', (_event, colors) => {
    windowTheme = colors;
    browser.setTitleBarOverlay({ color: colors.background, symbolColor: colors.foreground, height: 32 });
  });
  browser = new BrowserWindow({ width: 1440, height: 960, show: true, titleBarStyle: 'hidden', titleBarOverlay: { height: 32 }, webPreferences: { preload: fileURLToPath(new URL('../desktop-preload.cjs', import.meta.url)), partition: `frontend-fixture-${process.pid}`, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  browser.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media'));
  console.log('Browser fixture: initializing renderer');
  await browser.loadURL('about:blank');
  browser.webContents.on('console-message', event => {
    if (event.level === 'error' && !event.message.includes('status of 503')) errors.push(event.message);
  });
  browser.webContents.debugger.attach('1.3');
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log('Browser fixture: navigating to production bundle');
  await browser.loadURL(url);
  console.log('Browser fixture: checking appearance');
  await waitFor(() => document.getElementById('route-status-badge').textContent.includes('Ready'));
  console.log('Browser fixture: route ready');
  assert.equal(await evaluate(() => ['end-call-btn', 'notifications-btn', 'notifications-read', 'notifications-clear'].every(id => document.getElementById(id).querySelector('svg'))), true, 'call and inbox buttons must render registered icons');
  const bellCentered = () => {
    const button = document.getElementById('notifications-btn').getBoundingClientRect();
    const icon = document.querySelector('#notifications-btn svg').getBoundingClientRect();
    return Math.abs(button.left + button.width / 2 - icon.left - icon.width / 2) < 1
      && Math.abs(button.top + button.height / 2 - icon.top - icon.height / 2) < 1;
  };
  assert.equal(await evaluate(bellCentered), true, 'empty inbox bell must be centered');
  assert.equal(await evaluate(() => document.querySelector('.sidebar-brand img').src.includes('copilot-icon') && document.querySelector('link[rel="icon"]').href.includes('copilot-icon')), true);

  assert.equal(await evaluate(() => document.querySelectorAll('.appearance-options input').length), 0);
  assert.equal(await evaluate(() => document.querySelector('.top-bar').getBoundingClientRect().width), 248);
  assert.equal(await evaluate(() => document.querySelectorAll('.theme-card-select').length), 6);
  assert.equal(await evaluate(() => [...document.querySelectorAll('.theme-card-select')].every(button =>
    button.textContent.trim() && button.getAttribute('aria-label') && button.title && button.querySelectorAll('img').length === 2 && !button.querySelector('button'))), true);
  await waitFor(() => document.getElementById('local-setup-prompt').open);
  assert.equal(setupReads, 1);
  assert.equal(setupWrites, 0);
  assert.equal(await evaluate(() => document.getElementById('local-setup-prompt').open), true);
  await click('#local-setup-start');
  await waitFor(() => document.body.dataset.view === 'settings' && document.activeElement.id === 'setup-consent');
  console.log('Browser fixture: settings ready');
  assert.equal(await evaluate(() => document.querySelector('[data-for="settings-default-backend"] [aria-checked="true"]').value), 'agency');
  assert.equal(settingsWrites, 1);
  await waitFor(() => document.getElementById('setup-status').textContent === 'idle');
  assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#config-fields input')].map(control => [control.type, getComputedStyle(control).borderRadius, control.value])), [
    ['url', '8px', 'https://example.test'], ['number', '8px', '8'], ['password', '8px', ''],
  ]);
  assert.equal(await evaluate(() => [...document.querySelectorAll('select')].every(select => {
    const style = getComputedStyle(select);
    return style.fontSize === '15px' && style.fontWeight === '400' && style.borderRadius === '8px'
      && style.fontFamily === getComputedStyle(document.body).fontFamily
      && Number.parseFloat(style.minHeight) >= 44
      && [...select.options].every(option => getComputedStyle(option).fontFamily === style.fontFamily && getComputedStyle(option).fontSize === style.fontSize);
  })), true);
  await pointerClick('[data-for="motion-preference"] button[value="full"]');
  await press('ArrowUp');
  assert.equal(await evaluate(() => document.documentElement.dataset.motion), 'reduce');
  assert.equal(await evaluate(() => document.activeElement.matches('[data-for="motion-preference"] [aria-checked="true"]')), true);
  assert.equal(await evaluate(() => [...document.querySelectorAll('[data-for="motion-preference"] button')].every(button => button.getBoundingClientRect().height >= 44)), true);
  await choose('#motion-preference', 'full');
  const toggles = await evaluate(() => [...document.querySelectorAll('#settings-view .toggle-control input:not(:disabled)')]
    .map(input => ({ id: input.id, checked: input.checked })));
  assert.ok(toggles.length >= 6);
  for (const toggle of toggles) {
    console.log(`Browser fixture: toggle ${toggle.id}`);
    const label = `.toggle-control[for="${toggle.id}"]`;
    await pointerClick(`${label} .toggle-track`);
    assert.equal(await evaluate(id => document.getElementById(id).checked, toggle.id), !toggle.checked);
    assert.equal(await evaluate(() => document.activeElement.id), toggle.id);
    const scroll = await evaluate(() => document.getElementById('settings-view').scrollTop);
    await press('Space');
    assert.equal(await evaluate(id => document.getElementById(id).checked, toggle.id), toggle.checked);
    assert.equal(await evaluate(() => document.getElementById('settings-view').scrollTop), scroll);
    assert.equal(await evaluate(id => {
      const input = document.getElementById(id).getBoundingClientRect();
      const label = document.getElementById(id).closest('label').getBoundingClientRect();
      return input.left >= label.left && input.right <= label.right && input.top >= label.top && input.bottom <= label.bottom
        && document.getElementById('view-dialog').scrollTop === 0
        && document.querySelector('.view-dialog-content').scrollTop === 0
        && document.getElementById('view-dialog').matches(':modal') && document.body.dataset.view === 'settings';
    }, toggle.id), true);
    console.log(`Browser fixture: capture ${toggle.id}`);
    await assertPainted(label);
  }
  await pointerClick('#config-section > summary');
  assert.equal(await checkEditableInputs('#config-fields'), 3);
  assert.equal(await evaluate(() => {
    const hint = document.querySelector('#config-section > .field-hint').getBoundingClientRect();
    const form = document.getElementById('config-form').getBoundingClientRect();
    const actions = document.querySelector('#config-form .settings-actions').getBoundingClientRect();
    const fields = document.getElementById('config-fields').getBoundingClientRect();
    return form.top - hint.bottom >= 16 && fields.top - actions.bottom >= 16;
  }), true, 'expanded Keys and config must space its contents, not only its summary');
  assert.equal(await evaluate(() => document.getElementById('config-local-stt-provider').value), 'whisper');
  await click('#setup-consent');
  await pointerClick('[data-for="config-local-stt-provider"] button[value="moonshine"]');
  await click('#config-save-btn');
  await waitFor(() => document.getElementById('config-feedback').textContent.includes('Saved.'));
  assert.deepEqual(configWrites.at(-1), { LOCAL_STT_PROVIDER: 'moonshine' });
  assert.equal(config.local.sttProvider, 'moonshine');
  assert.equal(await evaluate(() => document.getElementById('setup-consent').checked), false);
  assert.equal(await evaluate(() => document.getElementById('setup-message').textContent.includes('moonshine selected')), true);
  assert.equal(setupWrites, 0, 'saving speech selection must not download anything');
  await evaluate(() => document.querySelector('[data-for="config-local-stt-provider"]').scrollIntoView({ block: 'center' }));
  await settle();
  await assertPainted('[data-for="config-local-stt-provider"]');
  await screenshot('speech-selector-desktop');
  assert.equal(await evaluate(() => document.querySelectorAll('.config-restart').length), 0);
  assert.equal(await evaluate(() => document.getElementById('config-local-router').value), 'scored');
  const connectionsBeforeRouting = { voice: voiceConnections, events: eventConnections };
  await pointerClick('[data-for="config-local-router"] button[value="off"]');
  await click('#config-save-btn');
  await waitFor(() => document.getElementById('config-local-router').dataset.savedValue === 'off' && document.getElementById('config-feedback').textContent.includes('next turn'));
  assert.deepEqual(configWrites.at(-1), { LOCAL_ROUTER: 'off' });
  assert.equal(await evaluate(() => document.querySelector('[data-for="config-local-router"] [aria-checked="true"]').value), 'off');
  assert.equal(await evaluate(() => document.querySelector('#config-local-router').closest('.config-field').querySelector('.config-restart')), null);
  await click('#close-view-btn');
  await waitFor(() => document.body.dataset.view === 'home');
  await visit('settings');
  assert.equal(await evaluate(() => document.getElementById('config-local-router').value), 'off');
  assert.equal(await evaluate(() => document.getElementById('config-section').open), true);
  await pointerClick('[data-for="config-local-router"] button[value="scored"]');
  await click('#config-save-btn');
  await waitFor(() => document.getElementById('config-local-router').dataset.savedValue === 'scored' && document.getElementById('config-feedback').textContent.includes('next turn'));
  assert.deepEqual(configWrites.at(-1), { LOCAL_ROUTER: 'scored' });
  assert.deepEqual({ voice: voiceConnections, events: eventConnections }, connectionsBeforeRouting);
  assert.equal(setupWrites, 0, 'routing changes must not install or restart local models');
  assert.equal(await evaluate(() => document.getElementById('settings-idle-warning')), null);
  await typeText('#config-llama-threads', '9');
  await choose('#settings-idle-end', '30');
  await choose('#settings-default-backend', 'copilot');
  await click('#close-view-btn');
  await waitFor(() => document.getElementById('app-dialog').open);
  await click('[data-app-dialog-cancel]');
  await settle();
  assert.equal(await evaluate(() => document.body.dataset.view), 'settings');
  assert.equal(await evaluate(() => document.getElementById('config-llama-threads').value), '9');
  configHttpStatus = 503;
  await click('#close-view-btn');
  await waitFor(() => document.getElementById('app-dialog').open);
  await click('[data-app-dialog-accept]');
  await waitFor(() => document.getElementById('config-feedback').textContent.includes('Error:'));
  assert.equal(await evaluate(() => document.body.dataset.view), 'settings');
  configHttpStatus = 200;
  await click('#close-view-btn');
  await waitFor(() => document.getElementById('app-dialog').open);
  await click('[data-app-dialog-accept]');
  await waitFor(() => document.body.dataset.view === 'home');
  assert.deepEqual(configWrites.at(-1), { LLAMA_THREADS: '9' });
  assert.equal(settings.idleEndSeconds, 30);
  await visit('settings');
  assert.equal(await evaluate(() => document.querySelectorAll('.config-restart').length), 1);
  assert.equal(await evaluate(() => {
    const control = document.getElementById('config-llama-threads');
    const field = control.closest('.config-field');
    const label = field.querySelector('label').getBoundingClientRect();
    const notice = field.querySelector('.config-restart').getBoundingClientRect();
    const bounds = control.getBoundingClientRect();
    return Math.abs(bounds.top - label.bottom - 8) < 1 && notice.top - bounds.bottom >= 8;
  }), true, 'restart notices must not displace the label-to-control spacing');
  await typeText('#config-llama-threads', '8');
  await choose('#settings-idle-end', '60');
  await click('#close-view-btn');
  await waitFor(() => document.getElementById('app-dialog').open);
  await click('[data-app-dialog-accept]');
  await waitFor(() => document.body.dataset.view === 'home');
  await visit('settings');
  assert.equal(await evaluate(() => document.querySelectorAll('.config-restart').length), 0);
  const writesBeforeUnchangedExit = configWrites.length;
  await choose('#settings-idle-end', '0');
  await choose('#settings-idle-end', '60');
  await click('#close-view-btn');
  await waitFor(() => document.body.dataset.view === 'home');
  assert.equal(configWrites.length, writesBeforeUnchangedExit);
  assert.equal(await evaluate(() => document.getElementById('app-dialog').open), false);
  await visit('settings');
  await pointerClick('#config-section > summary');
  assert.equal(await evaluate(() => document.getElementById('setup-install-btn').disabled), true);
  assert.equal(await evaluate(() => document.getElementById('setup-cache').textContent), setup.cacheDir);
  assert.equal(await evaluate(() => document.querySelectorAll('#setup-components a[href]').length), 1);
  assert.equal(await evaluate(() => document.querySelector('#setup-components a[href]').rel), 'noopener noreferrer');
  assert.equal(await evaluate(() => document.querySelector('.setup-estimate').textContent.includes('7-8 GB') && document.querySelector('.setup-estimate').textContent.includes('18 GB')), true);
  await click('#setup-install-btn');
  assert.equal(setupWrites, 0);
  await click('#setup-consent');
  await click('#setup-install-btn');
  await click('#setup-install-btn');
  await waitFor(() => document.getElementById('setup-status').textContent === 'running');
  assert.deepEqual(setupRequests, [{ consent: true }]);
  assert.equal(await evaluate(() => document.getElementById('setup-progress').value / document.getElementById('setup-progress').max), 0.2);
  const readsBeforePoll = setupReads;
  await waitFor(() => document.getElementById('setup-progress-label').textContent.includes('1.0 GB'));
  await evaluate(() => new Promise(resolve => setTimeout(resolve, 2200)));
  assert.ok(setupReads > readsBeforePoll);
  await click('#close-view-btn');
  const readsWhileClosed = setupReads;
  await evaluate(() => new Promise(resolve => setTimeout(resolve, 2200)));
  assert.equal(setupReads, readsWhileClosed);
  Object.assign(setup, { status: 'error', stage: 'install', message: 'Installation stopped', error: 'Fixture download failed', capabilities: { chat: { ready: true, message: 'Local chat is ready.' }, voice: { ready: false, message: 'Kokoro installation failed.' } }, log: ['<script>not executable</script>'] });
  await visit('settings');
  await waitFor(() => document.getElementById('setup-status').textContent === 'Chat ready');
  assert.equal(await evaluate(() => document.getElementById('setup-install-label').textContent), 'Retry voice setup');
  assert.equal(await evaluate(() => document.querySelectorAll('#setup-log script').length), 0);
  setupHttpStatus = 503;
  await click('#setup-refresh-btn');
  await waitFor(() => document.getElementById('setup-error').textContent === 'Could not refresh setup status. Try again.');
  assert.equal(await evaluate(() => document.getElementById('setup-install-btn').disabled), true);
  setupHttpStatus = 200;
  await click('#setup-refresh-btn');
  await waitFor(() => !document.getElementById('setup-install-btn').disabled);
  setupHttpStatus = 503;
  await click('#setup-install-btn');
  await waitFor(() => document.getElementById('setup-error').textContent === 'Could not refresh setup status. Try again.');
  assert.equal(await evaluate(() => document.getElementById('setup-install-btn').disabled), true);
  setupHttpStatus = 200;
  await click('#setup-refresh-btn');
  await waitFor(() => document.getElementById('setup-install-label').textContent === 'Installing local AI');
  assert.equal(setupWrites, 2);
  await evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const readsWhileHidden = setupReads;
  await evaluate(() => new Promise(resolve => setTimeout(resolve, 2200)));
  assert.equal(setupReads, readsWhileHidden);
  const configReadsBeforeReady = configReads;
  Object.assign(setup, { status: 'ready', stage: 'complete', message: 'Installed', error: '', capabilities: { chat: { ready: true, message: 'Local chat is ready.' }, voice: { ready: true, message: 'Local voice is ready.' } } });
  await evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => document.getElementById('setup-status').textContent === 'ready');
  assert.equal(configReads, configReadsBeforeReady + 1);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').disabled), false);
  assert.equal(await evaluate(() => document.getElementById('setup-install-btn').disabled), true);
  setup.supported = false;
  await click('#setup-refresh-btn');
  await waitFor(() => document.getElementById('setup-status').textContent === 'Unsupported platform');
  assert.equal(await evaluate(() => document.getElementById('setup-install-btn').disabled), true);
  setup.supported = true;

  console.log('Browser fixture: desktop modal and resize');
  resizeWindow(1440, 960);
  await waitFor(() => innerWidth === 1440 && document.getElementById('view-dialog').matches(':modal'));
  await evaluate(() => { window.fixtureHome = document.getElementById('agent-sprite'); window.fixtureSettings = document.getElementById('settings-view'); });
  assert.equal(await evaluate(() => document.getElementById('view-dialog').matches(':modal') && !document.getElementById('voice-personality-app').hidden), true);
  assert.equal(await evaluate(() => {
    const dialog = document.getElementById('view-dialog').getBoundingClientRect();
    return Math.abs((dialog.left + dialog.right) / 2 - innerWidth / 2) < 1 && dialog.width >= 1200;
  }), true);
  await evaluate(() => document.getElementById('settings-save-btn').focus());
  await press('Tab');
  assert.equal(await evaluate(() => document.activeElement === document.querySelector('#settings-view > .settings-container > details:last-of-type > summary')), true);
  await press('Tab');
  assert.equal(await evaluate(() => document.activeElement.id), 'application-data-clear');
  await press('Tab');
  assert.equal(await evaluate(() => document.activeElement.id), 'close-view-btn');
  await press('Tab', 8);
  await press('Tab', 8);
  await press('Tab', 8);
  assert.equal(await evaluate(() => document.activeElement.id), 'settings-save-btn');
  await click('#settings-view > .settings-container > details:last-of-type > summary');
  await pointerClick('#agency-check-btn');
  await waitFor(() => !document.getElementById('agency-check-btn').disabled && document.getElementById('agency-check-feedback').textContent.includes('Private work sources are off'));
  assert.equal(agencyChecks, 1);
  assert.equal(await evaluate(() => Boolean(document.querySelector('#agency-check-btn svg'))), true);
  assert.equal(await evaluate(() => {
    const check = document.getElementById('agency-check-btn').getBoundingClientRect();
    const save = document.getElementById('private-work-save-btn').getBoundingClientRect();
    const feedback = document.getElementById('agency-check-feedback').getBoundingClientRect();
    return save.left - check.right >= 12 && feedback.top - Math.max(save.bottom, check.bottom) >= 16;
  }), true, 'integration actions and status must have distinct spacing');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.application-data')).borderTopWidth), '0px');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('#integrations-section a.btn')).textDecorationLine), 'none');
  assert.equal(await evaluate(() => document.querySelector('#integrations-table-body img') === null && document.getElementById('integrations-table-body').textContent.includes('<img src=x onerror=alert(1)>')), true);
  await click('#settings-view > .settings-container > details:last-of-type > summary');
  await evaluate(() => document.getElementById('home-tab').focus());
  assert.equal(await evaluate(() => document.getElementById('view-dialog').contains(document.activeElement)), true);
  await press('Escape');
  assert.equal(await evaluate(() => document.body.dataset.view), 'home');
  assert.equal(await evaluate(() => document.activeElement.id), 'settings-tab');
  await visit('settings');
  resizeWindow(390, 844);
  await waitFor(() => innerWidth === 390 && !document.getElementById('view-dialog').matches(':modal'));
  await settle();
  assert.equal(await evaluate(() => document.getElementById('view-dialog').matches(':modal')), false);
  assert.equal(await evaluate(() => document.getElementById('view-dialog').getAttribute('role')), 'region');
  assert.equal(await evaluate(() => document.getElementById('voice-personality-app').hidden
    && getComputedStyle(document.getElementById('view-dialog')).backgroundColor === 'rgba(0, 0, 0, 0)'), true);
  await visit('files');
  assert.equal(await evaluate(() => document.body.dataset.view), 'files');
  await visit('settings');
  resizeWindow(1440, 960);
  await waitFor(() => innerWidth === 1440 && document.getElementById('view-dialog').matches(':modal'));
  await settle();
  assert.equal(await evaluate(() => document.getElementById('view-dialog').matches(':modal')), true);
  assert.equal(await evaluate(() => window.fixtureHome === document.getElementById('agent-sprite') && window.fixtureSettings === document.getElementById('settings-view')), true);
  await click('[data-open-view="tool-lab"]');
  assert.equal(await evaluate(() => document.body.dataset.view === 'tool-lab' && document.activeElement.id === 'close-view-btn'), true);
  assert.equal(await checkEditableInputs('#tool-lab-view'), 2);
  for (const width of [820, 390, 320]) {
    resizeWindow(width, 844);
    await visit('workspace');
    if (width === 390 && await evaluate(() => document.getElementById('areas-disclosure').open)) await pointerClick('#areas-disclosure > summary');
    if (width === 390) {
      assert.equal(await evaluate(() => {
        const title = document.querySelector('.task-card .task-title').getBoundingClientRect();
        const actions = document.querySelector('.task-card .task-actions').getBoundingClientRect();
        return Math.abs(title.top - actions.top) < 2;
      }), true, 'mobile task actions stay aligned with long titles');
      await screenshot('tasks-mobile');
    }
    if (!await evaluate(() => document.getElementById('areas-disclosure').open)) await pointerClick('#areas-disclosure > summary');
    await pointerClick('#btn-new-area');
    await waitFor(() => document.getElementById('area-dialog').matches(':modal'));
    await choose('#area-agent-select', '__custom__');
    assert.equal(await checkEditableInputs('#area-dialog'), 6);
    await press('Tab');
    assert.equal(await evaluate(() => document.getElementById('area-dialog').contains(document.activeElement)), true);
    await press('Escape');
    await waitFor(() => !document.getElementById('area-dialog').open);
    assert.equal(await evaluate(() => document.body.dataset.view), 'workspace');
    await pointerClick('#btn-new-task');
    assert.ok(await checkEditableInputs('#new-task-dialog') >= 1);
    if (width === 390) await screenshot('new-task-mobile');
    await pointerClick('#task-dialog-close');
    await visit('settings');
    await pointerClick('#settings-route-btn');
    assert.equal(await checkEditableInputs('#route-config-dialog'), 0);
    assert.equal(await evaluate(() => document.querySelector('output#model-input')?.value), 'fixture');
    assert.deepEqual(await evaluate(() => ['stt-provider', 'provider-select', 'tts-provider'].map(id => [...document.getElementById(id).options].map(option => option.value))), Array.from({ length: 3 }, () => ['local', 'openai', 'gemini']));
    await pointerClick('#route-config-close');
    await pointerClick('#config-section > summary');
    assert.equal(await checkEditableInputs('#config-fields'), 3);
    await pointerClick('#config-section > summary');
    await pointerClick('#integrations-section > summary');
    assert.equal(await evaluate(() => {
      const check = document.getElementById('agency-check-btn').getBoundingClientRect();
      const save = document.getElementById('private-work-save-btn').getBoundingClientRect();
      const feedback = document.getElementById('agency-check-feedback').getBoundingClientRect();
      const section = document.getElementById('integrations-section');
      return (save.left - check.right >= 12 || save.top - check.bottom >= 12)
        && feedback.top - Math.max(save.bottom, check.bottom) >= 16
        && section.scrollWidth <= section.clientWidth;
    }), true, `integration actions must wrap without overlap at ${width}px`);
    await screenshot(`integrations-${width}`);
    await pointerClick('#integrations-section > summary');
    await pointerClick('.toggle-control[for="transparency-preference"] .toggle-track');
    await press('Space');
    await assertPainted('.toggle-control[for="transparency-preference"]');
  }
  resizeWindow(1440, 960);
  await settle();
  await visit('workspace');
  assert.equal(await evaluate(() => {
    const dialogHeader = document.querySelector('.view-dialog-header');
    const style = getComputedStyle(dialogHeader);
    return style.borderBottomWidth === '0px'
      && style.backgroundImage !== 'none'
      && style.backgroundSize.endsWith(' 1px')
      && style.backgroundSize !== 'auto';
  }), true, 'view titles use a subtle inset divider');
  assert.equal(await evaluate(() => {
    const disclosure = document.getElementById('areas-disclosure').getBoundingClientRect();
    const taskListElement = document.getElementById('tasks-list');
    const taskList = taskListElement.getBoundingClientRect();
    const taskContentLeft = taskList.left + parseFloat(getComputedStyle(taskListElement).paddingLeft);
    return Math.abs(disclosure.left - taskContentLeft) < 1
      && getComputedStyle(document.querySelector('.section-header')).borderBottomWidth === '0px';
  }), true, 'task chrome aligns with content without stacked rules');
  await screenshot('tasks-desktop');
  await pointerClick('#btn-new-task');
  assert.equal(await evaluate(() => {
    const field = getComputedStyle(document.getElementById('task-objective-input'));
    const option = getComputedStyle(document.querySelector('#new-task-dialog [data-for="task-backend-select"] button'));
    return field.fontFamily === option.fontFamily && field.fontSize === option.fontSize;
  }), true, 'new task fields share one type treatment');
  await screenshot('new-task-desktop');
  await pointerClick('#task-dialog-close');
  await visit('settings');
  const themeEventConnections = eventConnections;
  const themeBeforePreview = await evaluate(() => document.documentElement.dataset.appearance);
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="next"]');
  assert.equal(await evaluate(() => document.documentElement.dataset.appearance), themeBeforePreview);
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.wallpaper), 'skyline');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="next"]');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.wallpaper), 'white');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="next"]');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.wallpaper), 'black');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="next"]');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.wallpaper), 'observatory');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="previous"]');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="previous"]');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="previous"]');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.wallpaper), 'skyline');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="previous"]');
  assert.equal(await evaluate(() => {
    const cards = [...document.querySelectorAll('#settings-view .theme-card')].map(card => card.getBoundingClientRect());
    return cards.length === 3 && cards[0].right < cards[1].left && cards[1].right < cards[2].left;
  }), true, 'theme cards must fit in distinct desktop columns');
  await click('#settings-view button[data-appearance="baymax"]');
  assert.equal(await evaluate(() => document.querySelectorAll('select#theme-sprite, select#theme-wallpaper, [data-appearance="opal"]').length), 0);
  assert.equal(await evaluate(() => document.querySelectorAll('#settings-view [data-appearance]').length), 3);
  assert.equal(await evaluate(() => document.querySelectorAll('[data-theme-card="baymax"] [data-theme-control="swap"]').length), 0);
  assert.equal(await evaluate(() => {
    const face = document.querySelector('#settings-view .theme-card-face img');
    const bounds = face.getBoundingClientRect();
    return bounds.width / bounds.height > 1.4 && getComputedStyle(face).objectFit === 'fill';
  }), true, 'Baymax card must preview the oval face, not the circular source bitmap');
  await pointerClick('#settings-view [data-theme-card="baymax"] [data-theme-control="next"]');
  assert.equal(await evaluate(() => document.activeElement.matches('[data-theme-card="baymax"] [data-theme-control="next"]')), true);
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="baymax"]').dataset.wallpaper), 'garden');
  await visit('home');
  await waitFor(() => document.querySelector('#agent-sprite[data-kind="companion"] .sprite-image')?.complete);
  assert.equal(await evaluate(() => document.querySelectorAll('#agent-sprite img').length), 1);
  assert.equal(await evaluate(() => {
    const head = document.querySelector('.companion-head').getBoundingClientRect();
    const image = document.querySelector('.companion-head img').getBoundingClientRect();
    const eyes = document.querySelector('.companion-eyes').getBoundingClientRect();
    return Math.abs(head.left - image.left) < 1 && Math.abs(head.top - image.top) < 1
      && eyes.left > image.left && eyes.right < image.right;
  }), true, 'companion eyes must stay within the head artwork');
  assert.equal(await evaluate(async () => {
    const image = document.querySelector('.sprite-image');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 512, 512);
    return context.getImageData(0, 0, 1, 1).data[3] === 0 && context.getImageData(256, 256, 1, 1).data[3] > 240;
  }), true, 'sprite corners must have real transparency, not a checkerboard');
  await visit('settings');
  await click('#settings-view button[data-appearance="jarvis"]');
  await pointerClick('#settings-view [data-theme-card="jarvis"] [data-theme-control="swap"]');
  await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"] [data-theme-control="next"]').focus());
  await press('Space');
  assert.equal(await evaluate(() => document.activeElement.matches('[data-theme-card="jarvis"] [data-theme-control="next"]')), true);
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.wallpaper), 'skyline');
  await click('#settings-view button[data-appearance="baymax"]');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="baymax"]').dataset.sprite), 'face');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="baymax"]').dataset.wallpaper), 'garden');
  await click('#theme-new-chat');
  assert.equal(await evaluate(() => document.getElementById('conversation-dialog').open && document.activeElement.id === 'chat-input'), true);
  await click('#close-chat-btn');
  await visit('settings');
  await click('#settings-view button[data-appearance="jarvis"]');
  assert.equal(eventConnections, themeEventConnections, 'theme changes must reuse the SSE connection');
  assert.equal(await evaluate(() => document.querySelector('#workspace-tab svg').dataset.lucide), 'radar');
  assert.equal(await evaluate(() => document.querySelector('#settings-view button[data-appearance="jarvis"]').getAttribute('aria-pressed')), 'true');
  assert.equal(await evaluate(() => document.querySelectorAll('button[data-appearance][aria-pressed="true"]').length), 2);
  assert.equal(await evaluate(() => document.documentElement.hasAttribute('aria-pressed')), false);
  await pointerClick('.toggle-control[for="transparency-preference"] .toggle-track');
  assert.equal(await evaluate(() => document.documentElement.dataset.transparency), 'off');
  await choose('#motion-preference', 'reduce');
  await browser.loadURL(url);
  await waitFor(() => document.querySelector('.sprite-image') && document.getElementById('route-status-badge').textContent.includes('Ready'));
  assert.equal(await evaluate(() => document.getElementById('local-setup-prompt').open), false);
  assert.equal(await evaluate(() => document.documentElement.dataset.motion), 'reduce');
  assert.equal(await evaluate(() => document.querySelector('[data-for="settings-default-backend"] [aria-checked="true"]').value), 'copilot');
  assert.equal(await evaluate(() => document.documentElement.dataset.appearance), 'jarvis');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.sprite), 'palladium');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="jarvis"]').dataset.wallpaper), 'skyline');
  assert.equal(await evaluate(() => document.documentElement.dataset.transparency), 'off');
  assert.equal(await evaluate(() => document.getElementById('transparency-preference').checked), false);
  assert.equal(await evaluate(() => [...document.querySelectorAll('.voice-strip, .top-bar, .suggestion, .view-dialog-content')].every(element => {
    const style = getComputedStyle(element);
    return style.backdropFilter === 'none' && !style.backgroundColor.startsWith('rgba');
  })), true);
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName), 'none');
  await pointerClick('#sidebar-toggle');
  assert.equal(await evaluate(() => document.querySelector('.top-bar').getBoundingClientRect().width), 76);
  assert.equal(await evaluate(() => document.getElementById('sidebar-toggle').getAttribute('aria-expanded')), 'false');
  await browser.loadURL(url);
  await waitFor(() => document.getElementById('route-status-badge').textContent.includes('Ready'));
  assert.equal(await evaluate(() => document.documentElement.dataset.sidebar), 'collapsed');
  await pointerClick('#sidebar-toggle');
  assert.equal(await evaluate(() => document.querySelector('.top-bar').getBoundingClientRect().width), 248);
  await pointerClick('.assistant-appearance');
  assert.equal(await evaluate(() => document.getElementById('appearance-popover').matches(':popover-open')), true);
  await press('Escape');
  assert.equal(await evaluate(() => document.activeElement.classList.contains('assistant-appearance')), true);
  await pointerClick('.assistant-appearance');
  await pointerClick('#appearance-popover [data-theme-card="alpine"] [data-theme-control="next"]');
  assert.equal(await evaluate(() => document.getElementById('appearance-popover').matches(':popover-open')), true);
  assert.equal(await evaluate(() => document.documentElement.dataset.appearance), 'jarvis');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="alpine"]').dataset.wallpaper), 'garden');
  await pointerClick('#appearance-popover [data-appearance="jarvis"]');
  assert.equal(await evaluate(() => document.getElementById('appearance-popover').matches(':popover-open')), false);
  await choose('#motion-preference', 'system');
  await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName), 'none');
  await choose('#motion-preference', 'full');
  assert.notEqual(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName), 'none');
  await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  for (const [id, invocation] of [['alpine', 'sprite-invoke'], ['jarvis', 'reactor-invoke'], ['baymax', 'companion-invoke']]) {
    await evaluate(theme => window.dispatchEvent(new CustomEvent('voice-supervisor:theme', { detail: { id: theme } })), id);
    const motion = await evaluate(async () => {
      await new Promise(requestAnimationFrame);
      const sprite = document.getElementById('agent-sprite');
      const artwork = sprite.querySelector('.companion-sprite') || sprite.querySelector('.sprite-image');
      const animation = artwork.getAnimations()[0];
      const iterations = animation.effect.getTiming().iterations;
      animation.pause();
      animation.currentTime = 0;
      const start = getComputedStyle(artwork).transform;
      animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
      const middle = getComputedStyle(artwork).transform;
      animation.play();
      return { looping: iterations === Infinity, moving: start !== middle };
    });
    assert.deepEqual(motion, { looping: true, moving: true });
    for (const active of [true, false]) {
      const transition = await evaluate(async active => {
        const image = document.querySelector('#agent-sprite .sprite-image');
        window.dispatchEvent(new CustomEvent('voice-supervisor:agent-state', { detail: { state: 'idle', active } }));
        await new Promise(requestAnimationFrame);
        const sprite = document.getElementById('agent-sprite');
        const animation = sprite.getAnimations()[0];
        const result = { name: animation.animationName, direction: animation.effect.getTiming().direction, iterations: animation.effect.getTiming().iterations };
        await animation.finished;
        await new Promise(requestAnimationFrame);
        return { ...result, finished: sprite.dataset.transition === '', stableImage: image === sprite.querySelector('.sprite-image') };
      }, active);
      assert.deepEqual(transition, { name: invocation, direction: active ? 'normal' : 'reverse', iterations: 1, finished: true, stableImage: true });
    }
  }
  await evaluate(() => window.dispatchEvent(new CustomEvent('voice-supervisor:theme', { detail: { id: 'jarvis' } })));

  const stableEventConnections = eventConnections;
  await waitFor(() => document.querySelectorAll('.history-entry').length === 2);
  await click('.history-entry');
  assert.equal(await evaluate(() => document.getElementById('task-detail-dialog').open && document.getElementById('detail-content').textContent.includes('coding task')), true);
  assert.equal(await evaluate(() => document.getElementById('detail-content').textContent.includes('1 queued')), true);
  assert.equal(await evaluate(() => document.querySelector('#detail-content img') === null), true);
  assert.equal(await evaluate(() => [...document.querySelectorAll('#detail-content details')].every(details => !details.open)), true);
  await pointerClick('#detail-content details:last-child summary');
  assert.equal(await evaluate(() => document.querySelector('#detail-content details:last-child').open), true);
  await pointerClick('#detail-continue-task-btn');
  assert.equal(await checkEditableInputs('#continue-thread-dialog'), 1);
  await pointerClick('#continue-dialog-close');
  await pointerClick('.history-entry[data-task-id="finished-task"]');
  await pointerClick('#detail-continue-task-btn');
  assert.equal(await checkEditableInputs('#continue-thread-dialog'), 1);
  await pointerClick('#continue-dialog-close');
  await click('#history-compose-btn');
  await waitFor(() => document.getElementById('new-task-dialog').open);
  assert.equal(await evaluate(() => document.getElementById('new-task-dialog').open), true);
  assert.equal(await evaluate(() => document.querySelector('#new-task-dialog details').open), false);
  await click('#task-dialog-close');
  await click('#open-chat-btn');
  await settle();
  assert.equal(await evaluate(() => {
    const send = getComputedStyle(document.getElementById('btn-send-chat'));
    return send.backgroundColor !== 'rgba(0, 0, 0, 0)' && send.color !== send.backgroundColor;
  }), true, 'composer send action remains visually distinct');
  await assertPainted('#conversation-dialog');
  await screenshot('conversation-desktop');
  console.log('Browser fixture: checking typed chat');
  await typeText('#chat-input', '<img src=x onerror=alert(1)> hello');
  await click('#btn-send-chat');
  await waitFor(() => document.getElementById('caption-text').textContent === 'Streaming reply');
  assert.equal(await evaluate(() => document.getElementById('caption-announcement').textContent), '');
  assert.equal(chatRequest.provider, 'local');
  assert.deepEqual(chatRequest.messages, [{ role: 'user', content: '<img src=x onerror=alert(1)> hello' }]);
  chatResponse.end(`data: ${JSON.stringify({ type: 'tool', name: 'list_work', result: { text: '<img src=x onerror=alert(1)>' } })}\n\ndata: ${JSON.stringify({ type: 'text', text: ' **complete**' })}\n\ndata: {"type":"done"}\n\n`);
  await waitFor(() => document.querySelector('.chat-bubble.assistant strong')?.textContent === 'complete');
  assert.equal(await evaluate(() => {
    const activity = document.querySelector('.chat-bubble.tool');
    return activity.tagName === 'DETAILS' && !activity.open && activity.querySelector('pre').textContent.includes('<img') && !activity.querySelector('img');
  }), true);
  assert.equal(await evaluate(() => document.querySelectorAll('.chat-bubble.user img, .history-entry img, #caption-text img').length), 0);
  assert.equal(await evaluate(() => document.querySelector('.chat-bubble.assistant strong').textContent), 'complete');
  await click('#close-chat-btn');
  await visit('files');
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  await click('#close-view-btn');
  await click('.history-entry');
  assert.equal(await evaluate(() => document.getElementById('task-detail-dialog').open && !document.getElementById('conversation-dialog').open), true);
  await click('#detail-dialog-close');
  await visit('home');

  await pointerClick('#voice-options-btn');
  assert.equal(await evaluate(() => !document.getElementById('mute-mic-opt')
    && document.querySelector('[data-for="ptt-mode-opt"] [aria-checked="true"]').value === 'voice'
    && document.getElementById('ptt-btn').hidden), true);
  await pointerClick('#dock-route-btn');
  assert.equal(await evaluate(() => document.querySelector('[data-for="pipeline-mode"] [aria-checked="true"]').value), 'dedicated');
  assert.equal(await evaluate(() => [...document.querySelectorAll('#dedicated-pipeline [data-for] button')].every(button => button.querySelector('svg'))), true);
  await pointerClick('[data-for="pipeline-mode"] button[value="native"]');
  assert.equal(await evaluate(() => document.getElementById('dedicated-pipeline').hidden && !document.getElementById('native-pipeline').hidden), true);
  await pointerClick('[data-for="native-provider"] button[value="gemini-live"]');
  assert.equal(await evaluate(() => document.getElementById('voice-mode-select').value), 'gemini-live');
  assert.equal(await evaluate(() => {
    const actions = document.querySelector('#route-config-dialog .dialog-actions');
    return getComputedStyle(actions).borderTopWidth === '0px' && getComputedStyle(actions).marginTop === '0px';
  }), true);
  await screenshot('native-pipeline-desktop');
  await pointerClick('[data-for="pipeline-mode"] button[value="dedicated"]');
  await pointerClick('[data-for="provider-select"] button[value="openai"]');
  assert.equal(await evaluate(() => document.getElementById('model-input').value), 'openai-fixture');
  await pointerClick('[data-for="provider-select"] button[value="gemini"]');
  assert.equal(await evaluate(() => document.getElementById('model-input').value), 'google-fixture');
  await pointerClick('[data-for="provider-select"] button[value="local"]');
  assert.equal(await evaluate(() => document.getElementById('model-input').value), 'fixture');
  await pointerClick('[data-for="stt-provider"] button[value="gemini"]');
  await pointerClick('[data-for="tts-provider"] button[value="openai"]');
  assert.equal(await evaluate(() => document.getElementById('provider-select').value), 'local');
  assert.deepEqual(await evaluate(() => {
    const saved = JSON.parse(window.voiceSupervisorPreferences.getItem('voice-supervisor-pipeline-v1'));
    return [saved.sttProvider, saved.provider, saved.ttsProvider];
  }), ['gemini', 'local', 'openai']);
  await screenshot('dedicated-pipeline-desktop');
  await pointerClick('[data-for="stt-provider"] button[value="local"]');
  await pointerClick('[data-for="tts-provider"] button[value="local"]');
  await press('Escape');
  assert.equal(await evaluate(() => document.activeElement.id), 'voice-options-btn');
  await pointerClick('#voice-options-btn');
  assert.equal(await evaluate(() => document.getElementById('quiet-mode-btn').getAttribute('aria-pressed')), 'false');
  await pointerClick('#quiet-mode-btn');
  assert.equal(await evaluate(() => document.getElementById('quiet-mode-btn').getAttribute('aria-pressed')), 'true');
  await pointerClick('#quiet-mode-btn');

  await evaluate(() => { document.getElementById('provider-select').value = ''; });
  await click('#mic-toggle-btn');
  await waitFor(() => document.getElementById('app-dialog').open);
  assert.equal(await evaluate(() => {
    const dialog = document.getElementById('app-dialog');
    const header = getComputedStyle(dialog.querySelector('.dialog-header'));
    const actions = getComputedStyle(dialog.querySelector('.dialog-actions'));
    return dialog.matches(':modal') && dialog.textContent.includes('Selected route is not configured.')
      && header.backgroundImage === 'none' && actions.borderTopWidth === '0px';
  }), true);
  await settle();
  await screenshot('alert-desktop');
  await click('[data-app-dialog-accept]');
  await choose('#provider-select', 'local');

  const edgesAreOff = () => document.body.dataset.voiceActive === 'false'
    && ['::before', '::after'].every(pseudo => {
      const style = getComputedStyle(document.body, pseudo);
      return Number(style.opacity) === 0 && style.animationName === 'none';
    });
  assert.equal(await evaluate(edgesAreOff), true, 'no call means no edge glow');
  await evaluate(() => {
    window.fixtureCues = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.fixtureCues.push({ source: this.src, volume: this.volume, activity: document.body.dataset.voiceActivity }); return play.call(this); };
  });
  await click('#assistant-toggle-btn');
  console.log('Browser fixture: checking voice');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.deepEqual([voiceStartRequest.sttProvider, voiceStartRequest.ttsProvider], ['local', 'local']);
  assert.equal(voiceStartRequest.model, 'fixture');
  assert.equal(await evaluate(() => document.getElementById('agent-sprite').dataset.active), 'true');
  await pointerClick('#dock-mute-btn');
  assert.equal(await evaluate(() => document.getElementById('dock-mute-btn').getAttribute('aria-pressed') === 'true'
    && document.querySelector('.voice-strip').dataset.muted === 'true'), true);
  await pointerClick('#dock-mute-btn');
  assert.equal(await evaluate(() => document.getElementById('dock-mute-btn').getAttribute('aria-pressed')), 'false');
  assert.equal(await evaluate(() => /jarvis-bootup/.test(window.fixtureCues.at(-1)?.source)), true);
  const meterAudio = Buffer.alloc(24000 * 2);
  for (let sample = 0; sample < 24000; sample++) meterAudio.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 220 / 24000) * 4096), sample * 2);
  await voice({ type: 'audio', data: meterAudio.toString('base64'), mimeType: 'audio/pcm', sampleRate: 24000, responseId: 'meter-fixture' });
  await waitFor(() => Number(document.querySelector('.voice-strip').style.getPropertyValue('--cp-voice-level')) > .1);
  await voice({ type: 'interrupted' });
  assert.equal(await evaluate(() => Number(document.querySelector('.voice-strip').style.getPropertyValue('--cp-voice-level'))), 0);
  assert.equal(await evaluate(() => document.querySelectorAll('.voice-bars, #mic-canvas').length), 0);
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).visibility), 'visible');
  await evaluate(() => { window.fixtureSpriteImage = document.querySelector('.sprite-image'); });
  const callBreathing = await evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const breathing = document.getAnimations().find(animation => animation.animationName === 'voice-presence');
    if (!breathing) return { animation: getComputedStyle(document.body, '::before').animationName };
    breathing.pause();
    breathing.currentTime = 0;
    const low = Number(getComputedStyle(document.body, '::before').opacity);
    breathing.currentTime = 1600;
    const high = Number(getComputedStyle(document.body, '::before').opacity);
    breathing.play();
    return { active: document.body.dataset.voiceActive, low, high, looping: breathing.effect.getTiming().iterations === Infinity };
  });
  assert.ok(callBreathing.active === 'true' && callBreathing.high - callBreathing.low > .3
    && callBreathing.looping, `Connected-call edge glow must breathe continuously: ${JSON.stringify(callBreathing)}`);
  await voice({ type: 'transcript', role: 'user', text: 'Voice partial', partial: true });
  assert.equal(await evaluate(() => document.getElementById('user-caption-text').textContent), 'Voice partial');
  const shortCaption = await evaluate(() => {
    const bounds = document.getElementById('user-closed-caption').getBoundingClientRect();
    window.fixtureShortCaptionWidth = bounds.width;
    window.fixtureShortCaptionHeight = bounds.height;
    return bounds.toJSON();
  });
  assert.ok(shortCaption.height <= 50, `Expected a compact single-line caption, received ${shortCaption.height}px`);
  await voice({ type: 'transcript', role: 'user', text: 'Voice partial grows smoothly as each recognized word arrives', partial: true });
  await waitFor(() => document.getElementById('user-closed-caption').getBoundingClientRect().height > window.fixtureShortCaptionHeight);
  const growingCaption = await evaluate(() => document.getElementById('user-closed-caption').getBoundingClientRect().toJSON());
  assert.equal(growingCaption.width, shortCaption.width);
  assert.ok(growingCaption.height > shortCaption.height);
  assert.equal(await evaluate(() => {
    const user = getComputedStyle(document.getElementById('user-closed-caption'));
    const assistant = getComputedStyle(document.getElementById('closed-caption'));
    return user.backgroundImage === 'none' && assistant.backgroundImage === 'none' && user.backgroundColor !== assistant.backgroundColor;
  }), true);
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  await voice({ type: 'transcript', role: 'user', text: 'Voice final', partial: false });
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  assert.equal(await evaluate(() => document.getElementById('user-caption-text').getAttribute('aria-labelledby')), 'user-caption-speaker user-caption-content');
  await voice({ type: 'transcript', role: 'assistant', text: 'Agent reply', partial: true });
  assert.equal(await evaluate(() => document.querySelectorAll('.closed-caption:not([hidden])').length), 2);
  assert.equal(await evaluate(() => document.getElementById('user-caption-text').textContent), 'Voice final');
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  assert.equal(await evaluate(() => /jarvis-action/.test(window.fixtureCues.at(-1)?.source) && window.fixtureCues.at(-1)?.activity === 'tool'), true);
  assert.equal(await evaluate(() => document.body.dataset.voiceActivity === 'tool'
    && getComputedStyle(document.body, '::after').animationName === 'tool-presence'
    && Number(getComputedStyle(document.body, '::before').opacity) === 0), true);
  await waitFor(() => !document.body.hasAttribute('data-voice-activity'));
  assert.equal(await evaluate(() => getComputedStyle(document.body, '::before').animationName), 'voice-presence', 'tool pulse returns to call breathing');
  await voice({ type: 'state', state: 'speaking' });
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'speaking');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).visibility === 'visible'
    && document.querySelector('.sprite-image') === window.fixtureSpriteImage
    && getComputedStyle(document.getElementById('agent-sprite'), '::before').animationName === 'speaker-ripple'), true);
  await voice({ type: 'transcript', role: 'assistant', text: 'Agent reply', partial: false });
  await pointerClick('#voice-options-btn');
  await pointerClick('[data-for="ptt-mode-opt"] button[value="ptt"]');
  assert.equal(await evaluate(() => {
    const button = document.getElementById('ptt-btn');
    return !button.hidden && button.textContent.trim() === 'Push to talk';
  }), true);
  await pointerClick('#open-chat-btn');
  await typeText('#chat-input', 'Spaces remain editable during push to talk');
  await pointerClick('#close-chat-btn');
  await pointerClick('#voice-options-btn');
  await pointerClick('[data-for="ptt-mode-opt"] button[value="voice"]');
  await pointerClick('#voice-options-btn');
  await visit('settings');
  Object.assign(fixtureTasks[1], { state: 'completed', canCancel: false, result: '## Working changes' });
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings: {} } })}\n\n`);
  await waitFor(() => document.querySelector('.history-entry[data-task-id="active-task"]').dataset.state === 'completed');
  await click('#settings-view button[data-appearance="alpine"]');
  await click('#settings-view [data-theme-card="alpine"] [data-theme-control="swap"]');
  await click('#settings-view button[data-appearance="baymax"]');
  assert.equal(voiceConnections, 1, 'changing sprite structure must not reconnect an active call');
  assert.equal(await evaluate(() => /baymax-bootup/.test(window.fixtureCues.at(-1)?.source)), true);
  assert.ok(await evaluate(() => Math.abs(window.fixtureCues.at(-1).volume - Number(document.getElementById('theme-volume').value) / 100) < 0.000001));
  await click('#settings-view button[data-appearance="alpine"]');
  assert.equal(await evaluate(() => document.querySelector('#settings-view [data-theme-card="alpine"]').dataset.sprite), 'opal');
  assert.equal(await evaluate(() => document.documentElement.dataset.transparency), 'off');
  await choose('#motion-preference', 'reduce');
  assert.equal(voiceConnections, 1);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').getAttribute('aria-pressed')), 'true');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName === 'none'
    && getComputedStyle(document.getElementById('agent-sprite'), '::before').animationName === 'none'), true);
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  assert.equal(await evaluate(() => getComputedStyle(document.body, '::after').animationName === 'none'
    && Number(getComputedStyle(document.body, '::after').opacity) > 0
    && Number(getComputedStyle(document.body, '::before').opacity) === 0), true);
  await voice({ type: 'interrupted' });
  assert.equal(await evaluate(() => [...document.querySelectorAll('.closed-caption')].every(caption => caption.hidden)), true);
  assert.equal(await evaluate(() => document.querySelector('.caption-region').getBoundingClientRect().height < 1), true);
  await voice({ type: 'transcript', role: 'assistant', text: 'Last reply', partial: false });
  await click('#settings-view button[data-appearance="alpine"]');
  await pointerClick('.toggle-control[for="transparency-preference"] .toggle-track');
  assert.equal(await evaluate(() => document.documentElement.dataset.transparency), 'on');
  await click('#close-view-btn');
  await pointerClick('#voice-options-btn');
  assert.equal(await evaluate(() => {
    const style = getComputedStyle(document.getElementById('voice-options'));
    return style.backgroundColor === getComputedStyle(document.documentElement).getPropertyValue('--cp-panel-strong').trim()
      && style.backdropFilter === 'none';
  }), true);
  await pointerClick('#voice-options-btn');
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  await click('#end-call-btn');
  assert.equal(await evaluate(edgesAreOff), true, 'button hang-up cancels both glows during a tool pulse');
  assert.equal(await evaluate(() => /copilot-end-call/.test(window.fixtureCues.at(-1)?.source)), true);
  assert.equal(await evaluate(() => window.fixtureCues.filter(cue => cue.source.includes('end-call')).length), 1);
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').getAttribute('aria-pressed')), 'false');
  assert.equal(await evaluate(() => document.querySelector('.voice-strip').style.getPropertyValue('--cp-voice-level')), '0');
  assert.equal(await evaluate(() => document.getElementById('agent-sprite').dataset.active), 'false');
  assert.equal(await evaluate(() => {
    const wallpaper = getComputedStyle(document.documentElement, '::before');
    const sidebar = getComputedStyle(document.querySelector('.top-bar'));
    const alpha = Number(sidebar.backgroundColor.match(/[\d.]+/g).at(-1));
    return getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && wallpaper.left === '0px' && wallpaper.right === '0px' && wallpaper.zIndex === '-1' && alpha < .6;
  }), true);
  assert.equal(await evaluate(() => document.body.dataset.voiceActive === 'false'
    && !document.body.hasAttribute('data-voice-activity')
    && Number(getComputedStyle(document.body, '::before').opacity) === 0), true);
  await evaluate(() => { document.body.dataset.voiceActivity = 'tool'; });
  assert.equal(await evaluate(edgesAreOff), true, 'tool activity outside a call cannot relight the edges');
  await evaluate(() => { delete document.body.dataset.voiceActivity; });
  await visit('home');
  await click('#mic-toggle-btn');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.equal(voiceConnections, 2);

  for (const [width, height] of [[1440, 960], [820, 900], [390, 844], [320, 640], [900, 500]]) {
    console.log(`Browser fixture: checking ${width}x${height}`);
    resizeWindow(width, height);
    for (const view of ['home', 'workspace', 'calendar', 'files', 'settings']) {
      console.log(`Browser fixture: ${view}`);
      await visit(view);
      if (view === 'home') {
        assert.equal(await evaluate(() => {
          const centers = ['voice-options-btn', 'dock-mute-btn', 'mic-toggle-btn', 'end-call-btn', 'open-chat-btn'].map(id => {
            const box = document.getElementById(id).getBoundingClientRect();
            return box.left + box.width / 2;
          });
          const dock = document.querySelector('.voice-strip').getBoundingClientRect();
          return Math.abs(centers[2] - (dock.left + dock.right) / 2) < 1
            && Math.abs(centers[2] - centers[1] - (centers[3] - centers[2])) < 1
            && Math.abs(centers[2] - centers[0] - (centers[4] - centers[2])) < 1;
        }), true, 'dock utility buttons must mirror around the microphone');
        assert.equal(await evaluate(() => {
          const surface = document.querySelector('.app-main').getBoundingClientRect();
          const dock = document.querySelector('.voice-strip').getBoundingClientRect();
          const group = document.querySelector('.suggestions').getBoundingClientRect();
          const buttons = [...document.querySelectorAll('.suggestion')];
          const widths = buttons.map(button => button.getBoundingClientRect().width);
          const materialStyles = [document.querySelector('.voice-strip'), ...buttons].map(element => getComputedStyle(element));
          const materialAlpha = Number(materialStyles[0].backgroundColor.match(/[\d.]+/g).at(-1));
          return Math.max(...widths) - Math.min(...widths) < 1
            && Math.abs((group.left + group.right - dock.left - dock.right) / 2) < 1
            && materialAlpha > .5 && materialAlpha < .9
            && materialStyles.every(style => style.backgroundColor === materialStyles[0].backgroundColor && style.backdropFilter !== 'none')
            && buttons.every(button => {
              const bounds = button.getBoundingClientRect();
              return bounds.top >= surface.top && bounds.bottom <= surface.bottom;
            });
        }), true, 'quick actions must be equally sized, centered, and fully visible above the dock');
      }
      const contentBefore = await evaluate(() => document.querySelector('.page-views').getBoundingClientRect().toJSON());
      const longCaption = 'Supervisor a designated work area. '.repeat(24);
      await voice({ type: 'transcript', role: 'user', text: longCaption, partial: false });
      await voice({ type: 'transcript', role: 'assistant', text: longCaption, partial: true });
      await waitFor(() => [...document.querySelectorAll('.caption-text')].every(text => !text.getAnimations().some(animation => animation.playState === 'running')));
      assert.deepEqual(await evaluate(() => document.querySelector('.page-views').getBoundingClientRect().toJSON()), contentBefore);
      assert.equal(await evaluate(() => document.getElementById('caption-text').textContent), longCaption.trim());
      assert.equal(await evaluate(() => [...document.querySelectorAll('.caption-text')].every(text =>
        getComputedStyle(text).textAlign === 'left'
        && text.style.height === ''
        && text.closest('.closed-caption').style.width === '')), true,
      'Caption text must be left aligned and use CSS-driven dimensions');
      const layout = await evaluate(() => {
        const surface = document.querySelector('.app-main').getBoundingClientRect();
        const dock = document.querySelector('.voice-strip').getBoundingClientRect();
        const captions = [...document.querySelectorAll('.closed-caption:not([hidden])')].map(caption => caption.getBoundingClientRect());
        const region = document.querySelector('.caption-region').getBoundingClientRect();
        const rootStyle = getComputedStyle(document.documentElement);
        const stackGap = Number.parseFloat(rootStyle.getPropertyValue('--cp-caption-stack-gap'));
        const captionPadding = Number.parseFloat(rootStyle.getPropertyValue('--cp-caption-padding')) * 2 + 2;
        const text = document.getElementById('caption-text');
        const firstWord = document.createRange();
        firstWord.setStart(text.firstElementChild.firstChild, 0);
        firstWord.setEnd(text.firstElementChild.firstChild, 10);
        const firstWordBounds = firstWord.getBoundingClientRect();
        return {
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          surfaceVisible: surface.width > 0 && surface.height > 0 && surface.left >= 0 && surface.right <= innerWidth,
          dockClear: surface.bottom <= dock.top,
          freeFloating: getComputedStyle(document.querySelector('.app-main')).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('.app-main')).boxShadow === 'none',
          captionFits: captions.length === 2 && captions.every(caption => caption.top >= 12 && caption.bottom < dock.top && caption.left >= surface.left && caption.right <= surface.right),
          captionCentered: Math.abs((region.left + region.right - dock.left - dock.right) / 2) < 1,
          captionStacked: Math.abs(captions[1].top - captions[0].bottom - stackGap) < 1,
          captionCardsCentered: Math.abs((captions[0].left + captions[0].right) - (captions[1].left + captions[1].right)) < 1,
          speakerColors: getComputedStyle(document.getElementById('user-closed-caption')).backgroundColor !== getComputedStyle(document.getElementById('closed-caption')).backgroundColor,
          premiumCaptionStyle: captions.every((_, index) => {
            const caption = document.querySelectorAll('.closed-caption:not([hidden])')[index];
            const style = getComputedStyle(caption);
            const textStyle = getComputedStyle(caption.querySelector('.caption-text'));
            return Number.parseFloat(style.borderRadius) === 12
              && style.paddingTop === style.paddingBottom && style.paddingRight === style.paddingLeft
              && style.backdropFilter !== 'none' && Number.parseInt(textStyle.fontWeight, 10) === 400;
          }),
          titlesHidden: [...document.querySelectorAll('.caption-speaker')].every(label => getComputedStyle(label).position === 'absolute' && label.getBoundingClientRect().height <= 1),
          compactCaption: captions.every(caption => caption.height <= Math.min(126, innerHeight * .16) + captionPadding),
          captionScrollable: text.scrollHeight > text.clientHeight && text.clientHeight <= Math.min(126, innerHeight * .16) + 1 && getComputedStyle(text).overflowY === 'auto',
          captionChromeOverlaid: Number.parseFloat(getComputedStyle(text).paddingRight) === 0
            && getComputedStyle(text).scrollbarWidth === 'none'
            && getComputedStyle(document.getElementById('dismiss-caption-btn')).position === 'absolute',
          captionStartVisible: firstWordBounds.left >= text.getBoundingClientRect().left && firstWordBounds.right <= text.getBoundingClientRect().right,
          modalCorrect: document.getElementById('view-dialog').matches(':modal') === (innerWidth > 760 && document.body.dataset.view !== 'home'),
          spriteCentered: document.getElementById('voice-personality-app').hidden || Math.abs((document.getElementById('agent-sprite').getBoundingClientRect().left + document.getElementById('agent-sprite').getBoundingClientRect().right - dock.left - dock.right) / 2) < 1,
        };
      });
      assert.deepEqual(layout, { noOverflow: true, surfaceVisible: true, dockClear: true, freeFloating: true, captionFits: true, captionCentered: true, captionStacked: true, captionCardsCentered: true, speakerColors: true, premiumCaptionStyle: true, titlesHidden: true, compactCaption: true, captionScrollable: true, captionChromeOverlaid: true, captionStartVisible: true, modalCorrect: true, spriteCentered: true }, `${width}x${height} ${view}`);
      if (view === 'settings') {
        assert.equal(await evaluate(() => {
          const settings = document.getElementById('settings-view');
          settings.scrollTop = settings.scrollHeight;
          const dialog = document.getElementById('view-dialog').getBoundingClientRect();
          const materialStyle = getComputedStyle(innerWidth <= 760 ? settings : document.querySelector('.view-dialog-content'));
          const alpha = Number(materialStyle.backgroundColor.match(/[\d.]+/g).at(-1));
          return settings.scrollHeight > settings.clientHeight
            && settings.getBoundingClientRect().bottom <= dialog.bottom
            && dialog.bottom <= document.querySelector('.voice-strip').getBoundingClientRect().top
            && alpha > .5 && alpha < .9 && materialStyle.backdropFilter !== 'none';
        }), true);
      }
      if ((width === 1440 || width === 390) && ['home', 'settings'].includes(view)) await screenshot(`${view}-${width}`);
    }
  }
  assert.equal(await evaluate(() => [...document.querySelectorAll('.appearance-options img')].every(image => image.complete && image.naturalWidth > 0)), true);
  assert.equal(voiceConnections, 2);
  assert.equal(eventConnections, stableEventConnections);
  await visit('home');
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  await voice({ type: 'end_call' });
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'idle');
  assert.equal(await evaluate(edgesAreOff), true, 'agent hang-up cancels both glows during a tool pulse');
  assert.equal(await evaluate(() => document.getElementById('end-call-btn').disabled
    && document.getElementById('mic-toggle-btn').getAttribute('aria-pressed') === 'false'), true);
  assert.equal(await evaluate(() => window.fixtureCues.filter(cue => cue.source.includes('end-call')).length), 2, 'agent and button hang-up play exactly once');

  await evaluate(() => {
    window.fixtureRealNow = Date.now;
    window.fixtureClock = Date.now();
    Date.now = () => window.fixtureClock;
  });
  await click('#mic-toggle-btn');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  await click('#dock-mute-btn');
  await evaluate(() => { window.fixtureClock += 40000; });
  assert.equal(await evaluate(() => document.getElementById('idle-call-notice')), null);
  assert.equal(voiceNotifications.filter(item => item.text.startsWith('Are you still there?')).length, 0);
  await voice({ type: 'transcript', role: 'user', text: 'Yes, I am here.', partial: false });
  await voice({ type: 'state', state: 'listening' });
  await evaluate(() => { window.fixtureClock += 60000; });
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'idle');
  assert.equal(await evaluate(() => window.fixtureCues.filter(cue => cue.source.includes('end-call')).length), 3, 'idle hang-up uses the same end cue');
  assert.equal(await evaluate(edgesAreOff), true, 'idle hang-up clears both glows');
  await evaluate(() => { Date.now = window.fixtureRealNow; });

  await click('#mic-toggle-btn');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.equal(await evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--cp-danger)';
    document.body.append(probe);
    const matches = getComputedStyle(probe).color === getComputedStyle(document.getElementById('end-call-btn')).color;
    probe.remove();
    return matches;
  }), true, 'active hang-up uses the danger color');
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  voiceSocket.close();
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'idle');
  assert.equal(await evaluate(edgesAreOff), true, 'socket disconnect cancels both glows during a tool pulse');

  fixtureNotifications.push(...['first', 'second'].map(id => ({ id, taskId: 'finished-task', title: `<img src=x> ${id}`, text: 'Task finished', state: 'completed', at: Date.now(), read: false })));
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings, notifications: fixtureNotifications } })}\n\n`);
  for (const notification of fixtureNotifications) eventResponse.write(`data: ${JSON.stringify({ type: 'notification', notification })}\n\n`);
  await waitFor(() => document.getElementById('notifications-count').textContent === '2');
  assert.equal(await evaluate(bellCentered), true, 'unread count must not move the bell');
  await pointerClick('#notifications-btn');
  assert.equal(await evaluate(() => document.querySelectorAll('#notifications-list .notification-item').length), 2);
  assert.equal(await evaluate(() => document.querySelectorAll('#notifications-list img').length), 0);
  assert.equal(await evaluate(() => [...document.querySelectorAll('.chat-bubble.system')].filter(item => item.textContent.includes('[Notification]')).length), 0, 'inbox updates do not clutter chat');
  assert.equal(await evaluate(() => [...document.querySelectorAll('.notification-item strong')].every(item => item.textContent.endsWith(': completed'))), true);
  assert.equal(await evaluate(() => document.querySelectorAll('.notification-item span').length), 0);
  await screenshot('notification-inbox');
  notificationReadRace = true;
  await pointerClick('#notifications-read');
  await waitFor(() => document.getElementById('notifications-count').textContent === '1');
  assert.equal(fixtureNotifications.at(-1).read, false);
  await pointerClick('#notifications-clear');
  await waitFor(() => document.querySelector('#notifications-list').textContent.includes('No notifications'));
  assert.equal(fixtureNotifications.length, 0);
  settings.appearanceTheme = 'jarvis';
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings, notifications: fixtureNotifications } })}\n\n`);
  await waitFor(() => document.querySelector('button[data-appearance="jarvis"]').getAttribute('aria-pressed') === 'true');
  await press('Escape');
  console.log('Browser fixture: keyboard and reset');
  await evaluate(() => document.getElementById('settings-tab').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  assert.equal(await evaluate(() => document.body.dataset.view), 'home');
  await click('#open-chat-btn');
  console.log('Browser fixture: clearing history');
  await click('#btn-clear-chat');
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  assert.equal(await evaluate(() => document.getElementById('history-empty').hidden), true);
  settings.defaultBackend = 'agency';
  Object.assign(fixtureTasks[1], { state: 'running', canCancel: true });
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings, notifications: fixtureNotifications } })}\n\n`);
  await visit('workspace');
  assert.equal(await evaluate(() => Boolean(document.querySelector('.task-actions button[title="Stop task and discard queued messages"] svg'))), true);
  await click('.task-card .task-title');
  assert.equal(await evaluate(() => Boolean(document.querySelector('#detail-cancel-task-btn svg'))), true);
  await pointerClick('#detail-cancel-task-btn');
  await waitFor(() => document.getElementById('task-detail-dialog').dataset.taskState === 'cancelled');
  assert.deepEqual(cancelRequests, ['active-task']);
  assert.equal(await evaluate(() => document.getElementById('detail-cancel-task-btn').checkVisibility()), false);
  Object.assign(fixtureTasks[1], { canMessage: false, deletable: false });
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings, notifications: fixtureNotifications } })}\n\n`);
  await waitFor(() => !document.getElementById('detail-continue-task-btn').checkVisibility());
  Object.assign(fixtureTasks[1], { canMessage: true, deletable: true });
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings, notifications: fixtureNotifications } })}\n\n`);
  await waitFor(() => document.getElementById('detail-continue-task-btn').checkVisibility() && document.getElementById('detail-delete-task-btn').checkVisibility());
  assert.match(await evaluate(() => document.getElementById('task-detail-dialog').textContent), /changes were not undone/);
  await screenshot('cancelled-task');
  await press('Escape');
  settings.agencySetupPrompted = false;
  settings.localSetupPrompted = true;
  setup.status = 'ready';
  setup.hardware.warning = null;
  const previousChecks = agencyChecks;
  await browser.loadURL(url);
  await waitFor(() => document.getElementById('app-dialog').open);
  assert.equal(agencyChecks, previousChecks + 1);
  assert.match(await evaluate(() => document.querySelector('[data-app-dialog-message]').textContent), /Sign in with Agency/);
  assert.equal(await evaluate(() => document.querySelector('[data-app-dialog-cancel]').textContent), 'Later');
  await click('[data-app-dialog-cancel]');
  await waitFor(() => !document.getElementById('app-dialog').open);
  await visit('calendar');
  assert.equal(await evaluate(() => document.querySelector('#calendar-view a').href), 'https://outlook.office.com/calendar/');
  await pointerClick('#calendar-check-btn');
  assert.equal(calendarRequests.length, 0, 'opening consent must not read private work sources');
  assert.equal(await evaluate(() => document.getElementById('integrations-section').open && document.activeElement.closest('[data-for="config-agency-work-data-access"]') !== null), true);
  assert.equal(await evaluate(() => document.querySelectorAll('[data-config-key="AGENCY_WORK_DATA_ACCESS"]').length), 1);
  assert.equal(await evaluate(() => Boolean(document.querySelector('#integrations-section a.btn svg'))), true);
  assert.match(await evaluate(() => document.getElementById('config-agency-work-data-access-hint').textContent), /cloud services/);
  await pointerClick('[data-for="config-agency-work-data-access"] button[value="read-only"]');
  await pointerClick('#private-work-save-btn');
  await waitFor(() => document.getElementById('private-work-feedback').textContent.includes('Access saved'));
  await visit('calendar');
  await screenshot('calendar-connected');
  await pointerClick('#calendar-check-btn');
  await waitFor(() => document.getElementById('task-detail-dialog').open);
  assert.equal(calendarRequests.length, 1);
  assert.equal(calendarRequests[0].args.backend, 'agency');
  assert.equal(calendarRequests[0].args.readOnly, true);
  assert.match(calendarRequests[0].args.objective, /work-account timezone/);
  assert.deepEqual(windowTheme, await evaluate(() => ({ background: document.documentElement.style.getPropertyValue('--cp-bg'), foreground: document.documentElement.style.getPropertyValue('--cp-text') })), 'native controls follow the active theme');
  await press('Escape');
  await visit('settings');
  await pointerClick('#application-data-clear');
  assert.equal(await evaluate(() => Boolean(document.querySelector('#application-data-title svg') && document.querySelector('#application-data-clear svg'))), true);
  await waitFor(() => document.getElementById('app-dialog').open);
  assert.equal(await evaluate(() => document.activeElement.hasAttribute('data-app-dialog-cancel')), true);
  assert.match(await evaluate(() => document.querySelector('[data-app-dialog-message]').textContent), /cannot be undone/);
  await screenshot('clear-data-confirmation');
  await click('[data-app-dialog-cancel]');
  await waitFor(() => !document.getElementById('application-data-clear').disabled);
  assert.deepEqual(resetRequests, []);
  await pointerClick('#application-data-clear');
  await waitFor(() => document.getElementById('app-dialog').open);
  await click('[data-app-dialog-accept]');
  await waitFor(() => document.getElementById('application-data-feedback').textContent.includes('Closing Invoke'));
  assert.deepEqual(resetRequests, ['DELETE_ALL_APP_DATA']);
  await visit('settings');
  await pointerClick('#settings-view button[data-appearance="baymax"]');
  await pointerClick('#settings-view [data-theme-card="baymax"] [data-theme-control="next"]');
  await evaluate(() => {
    const volume = document.getElementById('theme-volume');
    volume.value = '45';
    volume.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await choose('#settings-default-backend', 'agency');
  await click('#settings-save-btn');
  await waitFor(() => document.getElementById('settings-feedback').textContent.includes('Settings saved'));
  const restoredPreferences = await evaluate(() => ({
    theme: window.getThemeSessionOptions().theme,
    wallpaper: document.querySelector('#settings-view [data-theme-card="baymax"]').dataset.wallpaper,
    volume: document.getElementById('theme-volume').value,
    route: ['provider-select', 'voice-mode-select', 'stt-provider', 'tts-provider', 'native-provider'].map(id => document.getElementById(id).value),
    config: [...document.querySelectorAll('[data-config-key]')].map(control => [control.dataset.configKey, control.value]),
  }));
  preferences = desktopLaunch.createPreferenceStore(preferenceDir);
  restartedServer = createServer(server.listeners('request')[0]);
  await new Promise(resolve => restartedServer.listen(0, '127.0.0.1', resolve));
  const restartedUrl = `http://127.0.0.1:${restartedServer.address().port}`;
  assert.notEqual(restartedUrl, url);
  await browser.loadURL(restartedUrl);
  await waitFor(() => document.getElementById('route-status-badge').textContent.includes('Ready'));
  await waitFor(() => document.getElementById('app-dialog').open);
  await click('[data-app-dialog-cancel]');
  await visit('settings');
  assert.equal(await evaluate(() => localStorage.length), 0);
  assert.deepEqual(await evaluate(() => ({
    theme: window.getThemeSessionOptions().theme,
    wallpaper: document.querySelector('#settings-view [data-theme-card="baymax"]').dataset.wallpaper,
    volume: document.getElementById('theme-volume').value,
    route: ['provider-select', 'voice-mode-select', 'stt-provider', 'tts-provider', 'native-provider'].map(id => document.getElementById(id).value),
    config: [...document.querySelectorAll('[data-config-key]')].map(control => [control.dataset.configKey, control.value]),
  })), restoredPreferences);
  assert.equal(await evaluate(() => document.querySelector('[data-for="settings-default-backend"] [aria-checked="true"]').value), 'agency');
  assert.deepEqual(errors, []);
  console.log('Frontend browser checks passed: real toggle/input events and painted surfaces, two overlay captions, persisted transparency, setup lifecycle, unchanged voice/SSE ownership, themes and five viewports.');
} catch (error) {
  console.error(error.stack);
  console.error('Browser console:', JSON.stringify(errors));
  if (browser && !browser.isDestroyed()) console.error('Theme state:', await evaluate(() => ({
    live: window.getThemeSessionOptions?.(),
    controls: [...document.querySelectorAll('[data-appearance]')].map(button => [button.dataset.appearance, button.getAttribute('aria-pressed')]),
  })));
  if (browser && !browser.isDestroyed()) console.error('Browser viewport:', {
    contentSize: browser.getContentSize(), maximized: browser.isMaximized(), minimized: browser.isMinimized(),
    renderer: await evaluate(() => ({ width: innerWidth, height: innerHeight, desktop: matchMedia('(min-width: 761px)').matches })),
  });
  if (browser && !browser.isDestroyed()) console.error(await evaluate(() => ({ state: document.getElementById('agent-sprite')?.dataset.state, route: document.getElementById('route-status-badge')?.textContent, view: document.body.dataset.view, promptOpen: document.getElementById('local-setup-prompt')?.open, viewOpen: document.getElementById('view-dialog')?.open, focus: document.activeElement?.id, setupStatus: document.getElementById('setup-status')?.textContent, setupError: document.getElementById('setup-error')?.textContent, consent: document.getElementById('setup-consent')?.checked, installDisabled: document.getElementById('setup-install-btn')?.disabled, messages: document.getElementById('chat-messages')?.textContent })));
  console.error({ setupReads, setupWrites, settingsWrites });
  process.exitCode = 1;
} finally {
  chatResponse?.end();
  browser?.destroy();
  voiceSocket?.terminate();
  voiceServer?.close();
  server?.closeAllConnections();
  server?.close();
  restartedServer?.closeAllConnections();
  restartedServer?.close();
  rmSync(preferenceDir, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}
}

void runBrowserChecks();