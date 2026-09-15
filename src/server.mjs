import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Supervisor } from './supervisor.mjs';
import { createVSCodeBridge } from './vscode-bridge.mjs';
import { providerProfiles, streamReply } from './llm.mjs';
import { createRealtimeVoice } from './realtime.mjs';
import { createLocalVoice, localConfiguration } from './local-voice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.resolve(process.env.SUPERVISOR_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VoiceSupervisor'));
const inbox = path.join(dataDir, 'inbox');
mkdirSync(inbox, { recursive: true });
const supervisor = new Supervisor({ dataDir, bridge: createVSCodeBridge(dataDir) });
const clients = new Set();
const json = (response, status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); };
const sse = (response, payload) => { if (!response.destroyed) response.write(`data: ${JSON.stringify(payload)}\n\n`); };
function allowed(request) {
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
  return !request.headers.origin || request.headers.origin === `http://${host}`;
}
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 100000) throw new Error('Request too large'); }
  return JSON.parse(raw);
}
function config() {
  return { defaults: { provider: process.env.DEFAULT_PROVIDER || 'gemini', voiceMode: 'gemini-live' }, providers: providerProfiles(), voiceModes: [
    { id: 'gemini-live', label: 'Gemini Live', configured: Boolean(process.env.GEMINI_API_KEY), model: process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview' },
    { id: 'openai-realtime', label: 'OpenAI Realtime', configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime' },
    { id: 'local', label: 'Moonshine + Ling + Kokoro', configured: localConfiguration().configured },
  ], local: localConfiguration(), dataDir };
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!allowed(request)) return json(response, 403, { error: 'Local same-origin access only' });
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, config());
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, supervisor.snapshot());
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(response);
      sse(response, { type: 'state', state: supervisor.snapshot() });
      response.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/areas') return json(response, 200, await supervisor.registerArea(await body(request)));
    if (request.method === 'POST' && url.pathname === '/api/tools') {
      const input = await body(request);
      return json(response, 200, await supervisor.callTool(input.name, input.args, { requestId: input.requestId }));
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const input = await body(request);
      const controller = new AbortController();
      response.on('close', () => controller.abort());
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      try {
        for await (const event of streamReply({ provider: input.provider, model: input.model, messages: input.messages, requestId: input.requestId || randomUUID(), signal: controller.signal, callTool: supervisor.callTool.bind(supervisor) })) sse(response, event);
      } catch (error) { if (!controller.signal.aborted) sse(response, { type: 'error', message: error.message }); }
      response.end();
      return;
    }
    if (request.method !== 'GET') return json(response, 404, { error: 'Not found' });
    const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/capture-worklet.js': 'capture-worklet.js' };
    const file = url.pathname === '/vendor/lucide.js' ? path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.js') : files[url.pathname] && path.join(publicDir, files[url.pathname]);
    if (!file || !existsSync(file)) return json(response, 404, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': statSync(file).size });
    createReadStream(file).pipe(response);
  } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
});

const websocket = new WebSocketServer({ noServer: true, maxPayload: 100000 });
let voiceOwner = null;
server.on('upgrade', (request, socket, head) => {
  if (!allowed(request) || request.url !== '/voice') return socket.destroy();
  websocket.handleUpgrade(request, socket, head, client => websocket.emit('connection', client));
});
websocket.on('connection', socket => {
  let session;
  let starting = false;
  const send = event => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
  socket.on('message', async raw => {
    try {
      const message = JSON.parse(raw);
      if (message.type === 'start') {
        if (session || starting) return;
        if (voiceOwner && voiceOwner !== socket) throw new Error('A voice session is already active in another window');
        voiceOwner = socket;
        starting = true;
        const options = { mode: message.mode, provider: message.provider, model: message.model, allowCloud: message.allowCloud === true, send, callTool: supervisor.callTool.bind(supervisor) };
        session = message.mode === 'local' ? await createLocalVoice(options) : await createRealtimeVoice(options);
        starting = false;
        if (socket.readyState !== 1) { session.close(); if (voiceOwner === socket) voiceOwner = null; }
      } else if (message.type === 'stop') { session?.close(); socket.close(); }
      else if (message.type === 'audio') {
        if (typeof message.data !== 'string' || message.data.length > 40000 || Buffer.from(message.data, 'base64').length % 2) throw new Error('Invalid PCM frame');
        session?.audio(message.data);
      } else if (['commit', 'interrupt'].includes(message.type)) session?.[message.type]();
      else if (message.type === 'notify') session?.notify(String(message.text || '').slice(0, 1800));
    } catch (error) { send({ type: 'error', message: error.message, fatal: true }); session?.close(); socket.close(); }
  });
  socket.on('close', () => { session?.close(); if (voiceOwner === socket) voiceOwner = null; });
  socket.on('error', () => { session?.close(); if (voiceOwner === socket) voiceOwner = null; });
});
supervisor.on('change', state => { for (const client of clients) sse(client, { type: 'state', state }); });
supervisor.on('notification', notification => { for (const client of clients) sse(client, { type: 'notification', notification }); });
const observer = setInterval(() => {
  for (const name of readdirSync(inbox).filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(inbox, name);
    try { supervisor.observe(JSON.parse(readFileSync(file, 'utf8'))); unlinkSync(file); }
    catch { /* Leave unreadable observations for inspection. */ }
  }
}, 750);
observer.unref();
let port = Number(process.env.PORT || 4317);
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < Number(process.env.PORT || 4317) + 10) { port += 1; server.listen(port, '127.0.0.1'); }
  else { console.error(error.message); process.exitCode = 1; }
});
server.listen(port, '127.0.0.1', () => console.log(`Voice Work Supervisor: http://127.0.0.1:${port}`));