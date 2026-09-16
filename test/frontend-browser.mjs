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
const errors = [];
const config = {
  providers: [{ id: 'local', label: 'Local', model: 'fixture', configured: true }],
  voiceModes: [{ id: 'local', label: 'Local voice', configured: true }],
  defaults: { provider: 'local', voiceMode: 'local' },
};

const evaluate = (callback, ...args) => browser.webContents.executeJavaScript(`(${callback})(${args.map(value => JSON.stringify(value)).join(',')})`, true);
const click = selector => evaluate(value => document.querySelector(value).click(), selector);
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
        const routes = {
          '/api/config': config,
          '/api/state': { areas: [], tasks: [], settings: {} },
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
    if (event.level === 'error') errors.push(event.message);
  });
  browser.webContents.debugger.attach('1.3');
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log('Browser fixture: navigating to production bundle');
  await browser.loadURL(url);
  console.log('Browser fixture: checking appearance');
  await waitFor(() => document.getElementById('route-status-badge').textContent.includes('Ready'));

  assert.equal(await evaluate(() => document.querySelectorAll('.appearance-options input').length), 0);
  assert.equal(await evaluate(() => document.querySelector('.top-bar').getBoundingClientRect().width), 288);
  await click('#settings-tab');
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

  await click('#history-compose-btn');
  console.log('Browser fixture: checking typed chat');
  await evaluate(() => { document.getElementById('chat-input').value = '<img src=x onerror=alert(1)> hello'; });
  await click('#btn-send-chat');
  await waitFor(() => document.getElementById('caption-text').textContent === 'Streaming reply');
  assert.equal(await evaluate(() => document.getElementById('caption-announcement').textContent), '');
  assert.equal(chatRequest.provider, 'local');
  assert.deepEqual(chatRequest.messages, [{ role: 'user', content: '<img src=x onerror=alert(1)> hello' }]);
  chatResponse.end(`data: ${JSON.stringify({ type: 'text', text: ' **complete**' })}\n\ndata: {"type":"done"}\n\n`);
  await waitFor(() => document.querySelectorAll('.history-entry').length === 2);
  assert.equal(await evaluate(() => document.querySelectorAll('.chat-bubble.user img, .history-entry img, #caption-text img').length), 0);
  assert.equal(await evaluate(() => document.querySelector('.chat-bubble.assistant strong').textContent), 'complete');
  await click('#close-chat-btn');
  await click('#files-tab');
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  await click('.history-entry');
  assert.equal(await evaluate(() => document.getElementById('conversation-dialog').open && document.activeElement.classList.contains('chat-bubble')), true);
  await click('#close-chat-btn');
  await click('#home-tab');

  await click('#mic-toggle-btn');
  console.log('Browser fixture: checking voice');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.equal(await evaluate(() => document.querySelectorAll('.voice-bars span').length), 9);
  await voice({ type: 'transcript', role: 'user', text: 'Voice partial', partial: true });
  assert.equal(await evaluate(() => document.getElementById('caption-text').textContent), 'Voice partial');
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 2);
  await voice({ type: 'transcript', role: 'user', text: 'Voice final', partial: false });
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 3);
  await voice({ type: 'transcript', role: 'assistant', text: 'Agent reply', partial: true });
  await voice({ type: 'state', state: 'speaking' });
  await waitFor(() => document.querySelectorAll('.voice-bars span').length === 9);
  await voice({ type: 'transcript', role: 'assistant', text: 'Agent reply', partial: false });
  await click('#settings-tab');
  await click('button[data-appearance="opal"]');
  await choose('#motion-preference', 'reduce');
  assert.equal(voiceConnections, 1);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').getAttribute('aria-pressed')), 'true');
  assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.voice-bars span')).animationName), 'none');
  await voice({ type: 'interrupted' });
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  await voice({ type: 'transcript', role: 'assistant', text: 'Last reply', partial: false });
  await click('#mic-toggle-btn');
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  assert.equal(await evaluate(() => document.getElementById('mic-toggle-btn').getAttribute('aria-pressed')), 'false');
  await click('button[data-appearance="alpine"]');
  await click('#home-tab');
  await click('#mic-toggle-btn');
  await waitFor(() => document.getElementById('agent-sprite').dataset.state === 'listening');
  assert.equal(voiceConnections, 2);

  for (const [width, height] of [[1440, 960], [820, 900], [390, 844], [320, 640], [900, 500]]) {
    console.log(`Browser fixture: checking ${width}x${height}`);
    browser.setContentSize(width, height);
    for (const view of ['home', 'workspace', 'calendar', 'files', 'settings']) {
      console.log(`Browser fixture: ${view}`);
      await click(`#${view}-tab`);
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
          rounded: parseFloat(getComputedStyle(document.querySelector('.app-main')).borderRadius) >= 20,
          captionFits: caption.top >= content.bottom && caption.bottom <= surface.bottom && caption.left >= surface.left && caption.right <= surface.right,
        };
      });
      assert.deepEqual(layout, { noOverflow: true, surfaceVisible: true, dockClear: true, rounded: true, captionFits: true }, `${width}x${height} ${view}`);
      if ((width === 1440 || width === 390) && ['home', 'settings'].includes(view)) await screenshot(`${view}-${width}`);
    }
  }
  assert.equal(await evaluate(() => [...document.querySelectorAll('.appearance-option img')].every(image => image.complete && image.naturalWidth > 0)), true);
  await click('#mic-toggle-btn');
  console.log('Browser fixture: keyboard and reset');
  await evaluate(() => document.getElementById('settings-tab').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  assert.equal(await evaluate(() => document.body.dataset.view), 'home');
  await click('#open-chat-btn');
  console.log('Browser fixture: clearing history');
  await click('#btn-clear-chat');
  assert.equal(await evaluate(() => document.querySelectorAll('.history-entry').length), 0);
  assert.equal(await evaluate(() => document.getElementById('closed-caption').hidden), true);
  assert.equal(await evaluate(() => document.getElementById('history-empty').hidden), false);
  assert.deepEqual(errors, []);
  console.log('Frontend browser checks passed: chat/SSE, voice captions, history, themes, motion, keyboard navigation and five viewports.');
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