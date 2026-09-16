import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { WebSocketServer } from 'ws';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
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
  components: [
    { id: 'runtime', label: 'Local runtime', ready: false, sourceUrl: 'https://example.com/runtime' },
    { id: 'model', label: 'Voice model', ready: false, sourceUrl: 'javascript:alert(1)' },
  ],
};
const errors = [];
const config = {
  providers: [{ id: 'local', label: 'Local', model: 'fixture', configured: true }],
  voiceModes: [{ id: 'local', label: 'Local voice', configured: true }],
  defaults: { provider: 'local', voiceMode: 'local' },
};

const evaluate = (callback, ...args) => browser.webContents.executeJavaScript(`(${callback})(${args.map(value => JSON.stringify(value)).join(',')})`, true);
const click = selector => evaluate(value => {
  const button = document.querySelector(value);
  button.focus();
  button.click();
}, selector);
const settle = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const visit = async view => {
  if (await evaluate(() => document.getElementById('view-dialog').matches(':modal'))) await click('#close-view-btn');
  await click(`#${view}-tab`);
  await settle();
};
const press = async (key, modifiers = 0) => {
  const windowsVirtualKeyCode = key === 'Tab' ? 9 : 27;
  await browser.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, modifiers, windowsVirtualKeyCode });
  await browser.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers, windowsVirtualKeyCode });
  await settle();
};
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
        if (request.url === '/api/config') configReads++;
        const routes = {
          '/api/config': config,
          '/api/state': { areas: [{ id: 'fixture-area', name: 'Fixture repository', repoPath: 'C:\\fixture' }], tasks: fixtureTasks, settings: {} },
          '/api/areas/fixture-area/agents': [{ id: 'agent', name: 'Default agent' }],
          '/api/tools': [{ type: 'function', function: { name: 'list_work', description: 'List work', parameters: { type: 'object', properties: {} } } }],
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
  browser = new BrowserWindow({ width: 1440, height: 960, show: true, webPreferences: { partition: `frontend-fixture-${process.pid}`, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
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

  assert.equal(await evaluate(() => document.querySelectorAll('.appearance-options input').length), 0);
  assert.equal(await evaluate(() => document.querySelector('.top-bar').getBoundingClientRect().width), 288);
  assert.equal(setupReads, 0);
  assert.equal(setupWrites, 0);
  await visit('settings');
  await waitFor(() => document.getElementById('setup-status').textContent === 'idle');
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
  Object.assign(setup, { status: 'error', stage: 'install', message: 'Installation stopped', error: 'Fixture download failed', log: ['<script>not executable</script>'] });
  await visit('settings');
  await waitFor(() => document.getElementById('setup-status').textContent === 'error');
  assert.equal(await evaluate(() => document.getElementById('setup-install-label').textContent), 'Retry installation');
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
  await waitFor(() => document.getElementById('setup-status').textContent === 'running');
  assert.equal(setupWrites, 2);
  await evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const readsWhileHidden = setupReads;
  await evaluate(() => new Promise(resolve => setTimeout(resolve, 2200)));
  assert.equal(setupReads, readsWhileHidden);
  const configReadsBeforeReady = configReads;
  Object.assign(setup, { status: 'ready', stage: 'complete', message: 'Installed', error: '' });
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
  assert.equal(await evaluate(() => document.activeElement.id), 'close-view-btn');
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
  await visit('settings');
  await click('button[data-appearance="jarvis"]');
  assert.equal(await evaluate(() => document.querySelector('button[data-appearance="jarvis"]').getAttribute('aria-pressed')), 'true');
  assert.equal(await evaluate(() => document.querySelectorAll('button[data-appearance][aria-pressed="true"]').length), 1);
  assert.equal(await evaluate(() => document.documentElement.hasAttribute('aria-pressed')), false);
  await choose('#motion-preference', 'reduce');
  await browser.loadURL(url);
  await waitFor(() => document.querySelector('.sprite-image') && document.getElementById('route-status-badge').textContent.includes('Ready'));
  assert.equal(await evaluate(() => document.documentElement.dataset.motion), 'reduce');
  assert.equal(await evaluate(() => document.documentElement.dataset.appearance), 'jarvis');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName), 'none');
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
  await click('#detail-dialog-close');
  await click('#history-compose-btn');
  await waitFor(() => document.getElementById('new-task-dialog').open);
  assert.equal(await evaluate(() => document.getElementById('new-task-dialog').open), true);
  await click('#task-dialog-close');
  await click('#open-chat-btn');
  console.log('Browser fixture: checking typed chat');
  await evaluate(() => { document.getElementById('chat-input').value = '<img src=x onerror=alert(1)> hello'; });
  await click('#btn-send-chat');
  await waitFor(() => document.getElementById('caption-text').textContent === 'Streaming reply');
  assert.equal(await evaluate(() => document.getElementById('caption-announcement').textContent), '');
  assert.equal(chatRequest.provider, 'local');
  assert.deepEqual(chatRequest.messages, [{ role: 'user', content: '<img src=x onerror=alert(1)> hello' }]);
  chatResponse.end(`data: ${JSON.stringify({ type: 'text', text: ' **complete**' })}\n\ndata: {"type":"done"}\n\n`);
  await waitFor(() => document.querySelector('.chat-bubble.assistant strong')?.textContent === 'complete');
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

  await click('#mic-toggle-btn');
  console.log('Browser fixture: checking voice');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.equal(await evaluate(() => document.querySelectorAll('.voice-bars span').length), 9);
  assert.equal(await evaluate(() => document.body.dataset.voiceActive === 'true'
    && !document.getElementById('mic-canvas').hidden
    && Number(getComputedStyle(document.body, '::before').opacity) > 0), true);
  await voice({ type: 'transcript', role: 'user', text: 'Voice partial', partial: true });
  assert.equal(await evaluate(() => document.getElementById('caption-text').textContent), 'Voice partial');
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  await voice({ type: 'transcript', role: 'user', text: 'Voice final', partial: false });
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  await voice({ type: 'transcript', role: 'assistant', text: 'Agent reply', partial: true });
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  assert.equal(await evaluate(() => document.body.dataset.voiceActivity === 'tool'
    && getComputedStyle(document.body, '::after').animationName === 'tool-presence'), true);
  await voice({ type: 'state', state: 'speaking' });
  await waitFor(() => document.querySelectorAll('.voice-bars span').length === 0);
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).visibility === 'visible'
    && getComputedStyle(document.getElementById('agent-sprite'), '::before').animationName === 'speaker-ripple'), true);
  await voice({ type: 'transcript', role: 'assistant', text: 'Agent reply', partial: false });
  await visit('settings');
  Object.assign(fixtureTasks[1], { state: 'completed', result: '## Working changes' });
  eventResponse.write(`data: ${JSON.stringify({ type: 'state', state: { areas: [], tasks: fixtureTasks, settings: {} } })}\n\n`);
  await waitFor(() => document.querySelector('.history-entry[data-task-id="active-task"]').dataset.state === 'completed');
  await click('button[data-appearance="opal"]');
  await choose('#motion-preference', 'reduce');
  assert.equal(voiceConnections, 1);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').getAttribute('aria-pressed')), 'true');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.sprite-image')).animationName === 'none'
    && getComputedStyle(document.getElementById('agent-sprite'), '::before').animationName === 'none'), true);
  await voice({ type: 'tool', name: 'list_work', result: { ok: true } });
  assert.equal(await evaluate(() => getComputedStyle(document.body, '::after').animationName === 'none'
    && Number(getComputedStyle(document.body, '::after').opacity) > 0), true);
  await voice({ type: 'interrupted' });
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  assert.equal(await evaluate(() => document.querySelector('.caption-region').getBoundingClientRect().height < 1), true);
  await voice({ type: 'transcript', role: 'assistant', text: 'Last reply', partial: false });
  await click('button[data-appearance="alpine"]');
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
      await voice({ type: 'transcript', role: view === 'home' ? 'user' : 'assistant', text: 'A long caption stays readable across pages. '.repeat(12), partial: true });
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await evaluate(() => {
        const surface = document.querySelector('.app-main').getBoundingClientRect();
        const dock = document.querySelector('.voice-strip').getBoundingClientRect();
        const caption = document.getElementById('closed-caption').getBoundingClientRect();
        const content = document.querySelector('.page-views').getBoundingClientRect();
        return {
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          surfaceVisible: surface.width > 0 && surface.height > 0 && surface.left >= 0 && surface.right <= innerWidth,
          dockClear: surface.bottom <= dock.top,
          freeFloating: getComputedStyle(document.querySelector('.app-main')).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.querySelector('.app-main')).boxShadow === 'none',
          captionFits: caption.top >= content.bottom && caption.bottom <= surface.bottom && caption.left >= surface.left && caption.right <= surface.right,
          modalCorrect: document.getElementById('view-dialog').matches(':modal') === (innerWidth > 760 && document.body.dataset.view !== 'home'),
          spriteCentered: document.getElementById('voice-personality-app').hidden || Math.abs((document.getElementById('agent-sprite').getBoundingClientRect().left + document.getElementById('agent-sprite').getBoundingClientRect().right - dock.left - dock.right) / 2) < 1,
        };
      });
      assert.deepEqual(layout, { noOverflow: true, surfaceVisible: true, dockClear: true, freeFloating: true, captionFits: true, modalCorrect: true, spriteCentered: true }, `${width}x${height} ${view}`);
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
  console.log('Frontend browser checks passed: setup consent/progress/retry/visibility, persistent task history, modal focus/resize, unchanged voice/SSE ownership, themes and five viewports.');
} catch (error) {
  console.error(error.stack);
  console.error('Browser console:', JSON.stringify(errors));
  if (browser && !browser.isDestroyed()) console.error(await evaluate(() => ({ state: document.getElementById('agent-sprite')?.dataset.state, route: document.getElementById('route-status-badge')?.textContent, messages: document.getElementById('chat-messages')?.textContent })));
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