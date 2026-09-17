import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { WebSocketServer } from 'ws';

if (process.env.VOICE_SUPERVISOR_DISABLE_GPU === '1') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,CalculateNativeWinOcclusion');
let server;
let browser;
let chatResponse;
let chatRequest;
let voiceServer;
let voiceSocket;
let voiceConnections = 0;
let eventConnections = 0;
let eventResponse;
let setupReads = 0;
let setupWrites = 0;
let settingsWrites = 0;
let configReads = 0;
let setupHttpStatus = 200;
const setupRequests = [];
const fixtureTasks = [
  { id: 'finished-task', title: 'Completed coding work', state: 'completed', result: '**Ready for review**', createdAt: '2026-09-16T09:00:00Z' },
  { id: 'active-task', title: '<img src=x onerror=alert(1)> coding task', state: 'running', createdAt: '2026-09-16T10:00:00Z' },
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
  providers: [{ id: 'local', label: 'Local', model: 'fixture', configured: true }],
  voiceModes: [{ id: 'local', label: 'Local voice', configured: true }],
  defaults: { provider: 'local', voiceMode: 'local' },
  configuration: { fields: [
    { key: 'CUSTOM_BASE_URL', label: 'Custom URL', group: 'Fixture', type: 'url', secret: false, value: 'https://example.test' },
    { key: 'LLAMA_THREADS', label: 'Threads', group: 'Fixture', type: 'number', secret: false, value: '8', min: 1, max: 128 },
    { key: 'CUSTOM_API_KEY', label: 'Custom key', group: 'Fixture', type: 'password', secret: true, configured: true },
  ] },
};

const evaluate = (callback, ...args) => browser.webContents.executeJavaScript(`(${callback})(${args.map(value => JSON.stringify(value)).join(',')})`, true);
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
    return { ...position, reachable: control.contains(document.elementFromPoint(position.x, position.y)) };
  }, selector);
  assert.equal(point.reachable, true, `${selector} must receive pointer input`);
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
        if (request.url === '/api/settings' && request.method === 'POST') {
          let body = '';
          for await (const chunk of request) body += chunk;
          Object.assign(settings, JSON.parse(body));
          settingsWrites++;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(settings));
          return;
        }
        if (request.url === '/api/config') configReads++;
        const routes = {
          '/api/config': config,
          '/api/state': { areas: [{ id: 'fixture-area', name: 'Fixture repository', repoPath: 'C:\\fixture' }], tasks: fixtureTasks, settings },
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
      if (JSON.parse(source).type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log('Browser fixture: loading UI');
  browser = new BrowserWindow({ width: 1440, height: 960, show: true, titleBarStyle: 'hidden', titleBarOverlay: { height: 32 }, webPreferences: { partition: `frontend-fixture-${process.pid}`, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
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

  assert.equal(await evaluate(() => document.querySelectorAll('.appearance-options input').length), 0);
  assert.equal(await evaluate(() => document.querySelector('.top-bar').getBoundingClientRect().width), 248);
  assert.equal(await evaluate(() => [...document.querySelectorAll('.appearance-option')].every(button =>
    !button.textContent.trim() && button.getAttribute('aria-label') && button.title && button.querySelector('img'))), true);
  await waitFor(() => document.getElementById('local-setup-prompt').open);
  assert.equal(setupReads, 1);
  assert.equal(setupWrites, 0);
  assert.equal(await evaluate(() => document.getElementById('local-setup-prompt').open), true);
  await click('#local-setup-start');
  await waitFor(() => document.body.dataset.view === 'settings' && document.activeElement.id === 'setup-consent');
  console.log('Browser fixture: settings ready');
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
  await pointerClick('#motion-preference');
  assert.equal(await evaluate(() => document.getElementById('motion-preference').matches(':open')), true);
  assert.equal(await evaluate(() => {
    const select = document.getElementById('motion-preference');
    if (!CSS.supports('appearance', 'base-select')) return true;
    const menu = getComputedStyle(select, '::picker(select)');
    return menu.fontFamily === getComputedStyle(select).fontFamily && menu.fontSize === '15px' && menu.borderRadius === '8px'
      && [...select.options].every(option => option.getBoundingClientRect().height >= 44);
  }), true);
  await press('Escape');
  assert.equal(await evaluate(() => document.activeElement.id === 'motion-preference' && !document.activeElement.matches(':open')), true);
  await pointerClick('#motion-preference');
  await press('ArrowUp');
  await press('Enter');
  assert.equal(await evaluate(() => document.documentElement.dataset.motion), 'reduce');
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
  await pointerClick('#config-section > summary');
  assert.equal(await evaluate(() => document.getElementById('setup-install-btn').disabled), true);
  assert.equal(await evaluate(() => document.getElementById('setup-cache').textContent), setup.cacheDir);
  assert.equal(await evaluate(() => document.querySelectorAll('#setup-components a[href]').length), 1);
  assert.equal(await evaluate(() => document.querySelector('#setup-components a[href]').rel), 'noopener noreferrer');
  assert.equal(await evaluate(() => document.querySelector('.setup-estimate').textContent.includes('5-6 GB') && document.querySelector('.setup-estimate').textContent.includes('12 GB')), true);
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
  await waitFor(() => document.getElementById('setup-error').textContent.includes('Setup service unavailable'));
  assert.equal(await evaluate(() => document.getElementById('setup-install-btn').disabled), true);
  setupHttpStatus = 200;
  await click('#setup-refresh-btn');
  await waitFor(() => !document.getElementById('setup-install-btn').disabled);
  setupHttpStatus = 503;
  await click('#setup-install-btn');
  await waitFor(() => document.getElementById('setup-error').textContent.includes('Setup service unavailable'));
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
  await evaluate(() => { window.fixtureHome = document.getElementById('agent-sprite'); window.fixtureSettings = document.getElementById('settings-view'); });
  assert.equal(await evaluate(() => document.getElementById('view-dialog').matches(':modal') && !document.getElementById('voice-personality-app').hidden), true);
  assert.equal(await evaluate(() => {
    const dialog = document.getElementById('view-dialog').getBoundingClientRect();
    return Math.abs((dialog.left + dialog.right) / 2 - innerWidth / 2) < 1 && dialog.width >= 1200;
  }), true);
  await evaluate(() => document.getElementById('settings-save-btn').focus());
  await press('Tab');
  assert.equal(await evaluate(() => document.activeElement === document.querySelector('#settings-view > .settings-container > details:last-child > summary')), true);
  await press('Tab');
  assert.equal(await evaluate(() => document.activeElement.id), 'close-view-btn');
  await press('Tab', 8);
  await press('Tab', 8);
  assert.equal(await evaluate(() => document.activeElement.id), 'settings-save-btn');
  await evaluate(() => document.getElementById('home-tab').focus());
  assert.equal(await evaluate(() => document.getElementById('view-dialog').contains(document.activeElement)), true);
  await press('Escape');
  assert.equal(await evaluate(() => document.body.dataset.view), 'home');
  assert.equal(await evaluate(() => document.activeElement.id), 'settings-tab');
  await visit('settings');
  browser.setContentSize(390, 844);
  await settle();
  assert.equal(await evaluate(() => document.getElementById('view-dialog').matches(':modal')), false);
  assert.equal(await evaluate(() => document.getElementById('view-dialog').getAttribute('role')), 'region');
  assert.equal(await evaluate(() => document.getElementById('voice-personality-app').hidden
    && getComputedStyle(document.getElementById('view-dialog')).backgroundColor === 'rgba(0, 0, 0, 0)'), true);
  await visit('files');
  assert.equal(await evaluate(() => document.body.dataset.view), 'files');
  await visit('settings');
  browser.setContentSize(1440, 960);
  await settle();
  assert.equal(await evaluate(() => document.getElementById('view-dialog').matches(':modal')), true);
  assert.equal(await evaluate(() => window.fixtureHome === document.getElementById('agent-sprite') && window.fixtureSettings === document.getElementById('settings-view')), true);
  await click('[data-open-view="tool-lab"]');
  assert.equal(await evaluate(() => document.body.dataset.view === 'tool-lab' && document.activeElement.id === 'close-view-btn'), true);
  assert.equal(await checkEditableInputs('#tool-lab-view'), 2);
  for (const width of [820, 390]) {
    browser.setContentSize(width, 844);
    await visit('workspace');
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
    await pointerClick('#task-dialog-close');
    await visit('settings');
    await pointerClick('#settings-route-btn');
    assert.equal(await checkEditableInputs('#route-config-dialog'), 1);
    await pointerClick('#route-config-close');
    await pointerClick('#config-section > summary');
    assert.equal(await checkEditableInputs('#config-fields'), 3);
    await pointerClick('#config-section > summary');
    await pointerClick('.toggle-control[for="transparency-preference"] .toggle-track');
    await press('Space');
    await assertPainted('.toggle-control[for="transparency-preference"]');
  }
  browser.setContentSize(1440, 960);
  await settle();
  await visit('settings');
  await click('#settings-view button[data-appearance="jarvis"]');
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
  assert.equal(await evaluate(() => document.documentElement.dataset.appearance), 'jarvis');
  assert.equal(await evaluate(() => document.documentElement.dataset.transparency), 'off');
  assert.equal(await evaluate(() => document.getElementById('transparency-preference').checked), false);
  assert.equal(await evaluate(() => [...document.querySelectorAll('.voice-strip, .top-bar')].every(element => {
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
  await pointerClick('#appearance-popover [data-appearance="jarvis"]');
  assert.equal(await evaluate(() => document.getElementById('appearance-popover').matches(':popover-open')), false);
  await choose('#motion-preference', 'system');
  await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName), 'none');
  await choose('#motion-preference', 'full');
  assert.notEqual(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName), 'none');
  await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

  const stableEventConnections = eventConnections;
  await waitFor(() => document.querySelectorAll('.history-entry').length === 2);
  await click('.history-entry');
  assert.equal(await evaluate(() => document.getElementById('task-detail-dialog').open && document.getElementById('detail-content').textContent.includes('coding task')), true);
  assert.equal(await evaluate(() => [...document.querySelectorAll('#detail-content details')].every(details => !details.open)), true);
  await pointerClick('#detail-content details:last-child summary');
  assert.equal(await evaluate(() => document.querySelector('#detail-content details:last-child').open), true);
  await click('#detail-dialog-close');
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
  await pointerClick('#dock-route-btn');
  await press('Escape');
  assert.equal(await evaluate(() => document.activeElement.id), 'voice-options-btn');
  await pointerClick('#voice-options-btn');
  assert.equal(await evaluate(() => document.getElementById('quiet-mode-btn').getAttribute('aria-pressed')), 'false');
  await pointerClick('#quiet-mode-btn');
  assert.equal(await evaluate(() => document.getElementById('quiet-mode-btn').getAttribute('aria-pressed')), 'true');
  await pointerClick('#quiet-mode-btn');

  await click('#assistant-toggle-btn');
  console.log('Browser fixture: checking voice');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.equal(await evaluate(() => document.querySelectorAll('.voice-bars, #mic-canvas').length), 0);
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).visibility), 'visible');
  await evaluate(() => { window.fixtureSpriteImage = document.querySelector('.sprite-image'); });
  assert.equal(await evaluate(() => document.body.dataset.voiceActive === 'true'
    && Number(getComputedStyle(document.body, '::before').opacity) >= 0.75), true);
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
  assert.equal(await evaluate(() => document.body.dataset.voiceActivity === 'tool'
    && getComputedStyle(document.body, '::after').animationName === 'tool-presence'), true);
  await voice({ type: 'state', state: 'speaking' });
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'speaking');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).visibility === 'visible'
    && document.querySelector('.sprite-image') === window.fixtureSpriteImage
    && getComputedStyle(document.getElementById('agent-sprite'), '::before').animationName === 'speaker-ripple'), true);
  await voice({ type: 'transcript', role: 'assistant', text: 'Agent reply', partial: false });
  await pointerClick('#voice-options-btn');
  await pointerClick('#ptt-mode-opt + .toggle-track');
  await pointerClick('#open-chat-btn');
  await typeText('#chat-input', 'Spaces remain editable during push to talk');
  await pointerClick('#close-chat-btn');
  await pointerClick('#voice-options-btn');
  await pointerClick('#ptt-mode-opt + .toggle-track');
  await pointerClick('#voice-options-btn');
  await visit('settings');
  Object.assign(fixtureTasks[1], { state: 'completed', result: '## Working changes' });
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings: {} } })}\n\n`);
  await waitFor(() => document.querySelector('.history-entry[data-task-id="active-task"]').dataset.state === 'completed');
  await click('#settings-view button[data-appearance="opal"]');
  assert.equal(await evaluate(() => document.documentElement.dataset.transparency), 'off');
  await choose('#motion-preference', 'reduce');
  assert.equal(voiceConnections, 1);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').getAttribute('aria-pressed')), 'true');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName === 'none'
    && getComputedStyle(document.getElementById('agent-sprite'), '::before').animationName === 'none'), true);
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  assert.equal(await evaluate(() => getComputedStyle(document.body, '::after').animationName === 'none'
    && Number(getComputedStyle(document.body, '::after').opacity) > 0), true);
  await voice({ type: 'interrupted' });
  assert.equal(await evaluate(() => [...document.querySelectorAll('.closed-caption')].every(caption => caption.hidden)), true);
  assert.equal(await evaluate(() => document.querySelector('.caption-region').getBoundingClientRect().height < 1), true);
  await voice({ type: 'transcript', role: 'assistant', text: 'Last reply', partial: false });
  await click('#settings-view button[data-appearance="alpine"]');
  await pointerClick('.toggle-control[for="transparency-preference"] .toggle-track');
  assert.equal(await evaluate(() => document.documentElement.dataset.transparency), 'on');
  await click('#close-view-btn');
  await click('#mic-toggle-btn');
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').getAttribute('aria-pressed')), 'false');
  assert.equal(await evaluate(() => document.body.dataset.voiceActive === 'false'
    && !document.body.hasAttribute('data-voice-activity')
    && Number(getComputedStyle(document.body, '::before').opacity) === 0), true);
  await visit('home');
  await click('#mic-toggle-btn');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.equal(voiceConnections, 2);

  for (const [width, height] of [[1440, 960], [820, 900], [390, 844], [320, 640], [900, 500]]) {
    console.log(`Browser fixture: checking ${width}x${height}`);
    browser.setContentSize(width, height);
    for (const view of ['home', 'workspace', 'calendar', 'files', 'settings']) {
      console.log(`Browser fixture: ${view}`);
      await visit(view);
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
          return settings.scrollHeight > settings.clientHeight && settings.getBoundingClientRect().bottom <= dialog.bottom && dialog.bottom <= document.querySelector('.voice-strip').getBoundingClientRect().top;
        }), true);
      }
      if ((width === 1440 || width === 390) && ['home', 'settings'].includes(view)) await screenshot(`${view}-${width}`);
    }
  }
  assert.equal(await evaluate(() => [...document.querySelectorAll('.appearance-option img')].every(image => image.complete && image.naturalWidth > 0)), true);
  assert.equal(voiceConnections, 2);
  assert.equal(eventConnections, stableEventConnections);
  await visit('home');
  await click('#mic-toggle-btn');
  console.log('Browser fixture: keyboard and reset');
  await evaluate(() => document.getElementById('settings-tab').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  assert.equal(await evaluate(() => document.body.dataset.view), 'home');
  await click('#open-chat-btn');
  console.log('Browser fixture: clearing history');
  await click('#btn-clear-chat');
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  assert.equal(await evaluate(() => document.getElementById('history-empty').hidden), true);
  assert.deepEqual(errors, []);
  console.log('Frontend browser checks passed: real toggle/input events and painted surfaces, two overlay captions, persisted transparency, setup lifecycle, unchanged voice/SSE ownership, themes and five viewports.');
} catch (error) {
  console.error(error.stack);
  console.error('Browser console:', JSON.stringify(errors));
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
  app.exit(process.exitCode || 0);
}
}

void runBrowserChecks();