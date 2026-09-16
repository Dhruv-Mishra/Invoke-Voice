import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Supervisor, tools } from './supervisor.mjs';
import { createVSCodeBridge } from './vscode-bridge.mjs';
import { providerProfiles, streamReply } from './llm.mjs';
import { createRealtimeVoice, DEFAULT_GEMINI_LIVE_MODEL } from './realtime.mjs';
import { createLocalVoice, localConfiguration, warmLocalVoice } from './local-voice.mjs';
import { createLocalSetup } from './local-setup.mjs';
import { createRuntimeConfig } from './runtime-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(root, 'public');
const frontendDir = path.join(root, 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function resolveStaticFile(pathname, targetDistDir, targetPublicDir) {
  const decoded = decodeURIComponent(pathname.replace(/\0/g, ''));
  const safePath = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, '');

  if (safePath === '/' || safePath === '\\' || safePath === '/index.html' || safePath === '\\index.html') {
    const indexPath = path.join(targetDistDir, 'index.html');
    if (existsSync(indexPath)) return indexPath;
    const fallbackPath = path.join(targetPublicDir, 'index.html');
    if (existsSync(fallbackPath)) return fallbackPath;
    return null;
  }

  if (safePath.startsWith('/assets/') || safePath.startsWith('\\assets\\')) {
    const assetFile = path.join(targetDistDir, 'assets', path.basename(safePath));
    if (existsSync(assetFile) && statSync(assetFile).isFile()) return assetFile;
  }

  const distCandidate = path.join(targetDistDir, safePath.replace(/^[/\\]+/, ''));
  if (distCandidate.startsWith(targetDistDir) && existsSync(distCandidate) && statSync(distCandidate).isFile()) {
    return distCandidate;
  }

  const publicCandidate = path.join(targetPublicDir, safePath.replace(/^[/\\]+/, ''));
  if (publicCandidate.startsWith(targetPublicDir) && existsSync(publicCandidate) && statSync(publicCandidate).isFile()) {
    return publicCandidate;
  }

  return null;
}

export async function startSupervisor(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SUPERVISOR_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VoiceSupervisor'));
  const inbox = path.join(dataDir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const runtimeConfig = createRuntimeConfig({ dataDir });
  const supervisor = options.supervisor || new Supervisor({ dataDir, bridge: createVSCodeBridge(dataDir) });
  const setup = options.setup || createLocalSetup();
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
    const voiceMode = process.env.DEFAULT_VOICE_MODE || 'local';
    const provider = process.env.DEFAULT_PROVIDER || 'local';
    const settings = supervisor.snapshot().settings;
    const configuredModels = (process.env.COPILOT_MODELS || '').split(',').map(value => value.trim()).filter(Boolean);
    const modelIds = [...new Set(['auto', 'gpt-5.6-sol', 'gpt-5.6-luna', ...configuredModels, settings.copilotModel])];
    return { defaults: { provider, voiceMode, codingBackend: settings.defaultBackend, copilotModel: settings.copilotModel, copilotContext: settings.copilotContext }, codingBackends: [
      { id: 'copilot', label: 'Copilot CLI', description: 'Direct GitHub Copilot CLI', capabilities: { followUp: true, passiveStatus: true, openWorktree: true, cancel: false, hub: false } },
      { id: 'agency', label: 'Agency', description: 'Agency-managed Copilot session with Hub reporting', capabilities: { followUp: true, passiveStatus: true, openWorktree: true, cancel: false, hub: true } },
    ], copilotModels: modelIds.map(id => ({ id, label: id === 'auto' ? 'Auto' : id === 'gpt-5.6-sol' ? 'GPT-5.6 Sol' : id === 'gpt-5.6-luna' ? 'GPT-5.6 Luna' : id })), copilotContexts: [
      { id: 'default', label: 'Short (default)' },
      { id: 'long_context', label: 'Long (up to 1M tokens)' },
    ], integrations: [
      { id: 'azure-devops', label: 'Azure DevOps MCP', status: 'planned', mode: 'read-only first' },
      { id: 'teams', label: 'Teams MCP', status: 'planned', mode: 'confirm sends' },
      { id: 'zvec-grep', label: 'zvec-grep MCP', status: 'workspace_configured', mode: 'search_only' },
    ], providers: providerProfiles(), voiceModes: [
      { id: 'gemini-live', label: 'Gemini Live', configured: Boolean(process.env.GEMINI_API_KEY), model: process.env.GEMINI_LIVE_MODEL || DEFAULT_GEMINI_LIVE_MODEL },
      { id: 'openai-realtime', label: 'OpenAI Realtime', configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime' },
      { id: 'local', label: 'Moonshine + Ling + Kokoro', configured: localConfiguration().configured },
    ], local: localConfiguration(), configuration: runtimeConfig.snapshot(), dataDir };
  }

  const mode = options.mode || (options.debug ? 'debug' : (process.env.SUPERVISOR_MODE || 'release'));
  const isDebug = mode === 'debug';

  let viteDevServer = null;

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!allowed(request)) return json(response, 403, { error: 'Local same-origin access only' });
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/setup') return json(response, 200, setup.snapshot());
      if (request.method === 'POST' && url.pathname === '/api/setup') {
        if (voiceOwner) return json(response, 409, { error: 'End the active voice call before running local setup.' });
        const input = await body(request);
        return json(response, 202, setup.start(input));
      }
      if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, config());
      if (request.method === 'POST' && url.pathname === '/api/config') {
        if (voiceOwner) return json(response, 409, { error: 'End the active voice call before changing application configuration.' });
        const configuration = runtimeConfig.update(await body(request));
        return json(response, 200, { ...config(), configuration });
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, supervisor.snapshot());
      if (request.method === 'GET' && url.pathname === '/api/tools') return json(response, 200, tools);
      const areaAgents = url.pathname.match(/^\/api\/areas\/([^/]+)\/agents$/);
      if (request.method === 'GET' && areaAgents) return json(response, 200, supervisor.listAgents(decodeURIComponent(areaAgents[1])));
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        clients.add(response);
        sse(response, { type: 'state', state: supervisor.snapshot() });
        response.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/areas') return json(response, 200, await supervisor.registerArea(await body(request)));
      if (request.method === 'POST' && url.pathname === '/api/settings') return json(response, 200, supervisor.updateSettings(await body(request)));
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
      const taskDelete = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === 'DELETE' && taskDelete) return json(response, 200, supervisor.deleteTask(decodeURIComponent(taskDelete[1])));
      const areaDelete = url.pathname.match(/^\/api\/areas\/([^/]+)$/);
      if (request.method === 'DELETE' && areaDelete) return json(response, 200, supervisor.deleteArea(decodeURIComponent(areaDelete[1])));

      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found' });
      if (request.method !== 'GET') return json(response, 404, { error: 'Not found' });

      if (isDebug && viteDevServer) {
        viteDevServer.middlewares(request, response, () => {
          if (!response.headersSent) json(response, 404, { error: 'Not found' });
        });
        return;
      }

      const file = resolveStaticFile(url.pathname, frontendDir, publicDir);
      if (!file) return json(response, 404, { error: 'Not found' });
      const contentType = getMimeType(file);
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Length': statSync(file).size });
      createReadStream(file).pipe(response);
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
  });

  const websocket = new WebSocketServer({ noServer: true, maxPayload: 100000 });
  let voiceOwner = null;
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/voice') {
      if (!allowed(request)) return socket.destroy();
      websocket.handleUpgrade(request, socket, head, client => websocket.emit('connection', client));
      return;
    }
    if (!viteDevServer) {
      socket.destroy();
    }
  });
  websocket.on('connection', socket => {
    let session;
    let starting = false;
    let cancelled = false;
    const send = event => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
    socket.on('message', async raw => {
      try {
        const message = JSON.parse(raw);
        if (message.type === 'start') {
          if (session || starting) return;
          if (message.mode === 'local' && setup.snapshot().status === 'running') throw new Error('Local setup is still running. Wait for setup to finish before starting a local call.');
          if (voiceOwner && voiceOwner !== socket) throw new Error('A voice session is already active in another window');
          voiceOwner = socket;
          starting = true;
          cancelled = false;
          const options = { mode: message.mode, provider: message.provider, model: message.model, allowCloud: message.allowCloud === true, send, callTool: supervisor.callTool.bind(supervisor) };
          session = message.mode === 'local' ? await createLocalVoice(options) : await createRealtimeVoice(options);
          starting = false;
          if (cancelled || socket.readyState !== 1) { session.close(); if (voiceOwner === socket) voiceOwner = null; }
        } else if (message.type === 'stop') { session?.close(); socket.close(); }
        else if (message.type === 'audio') {
          if (typeof message.data !== 'string' || message.data.length > 40000 || Buffer.from(message.data, 'base64').length % 2) throw new Error('Invalid PCM frame');
          session?.audio(message.data);
        } else if (['commit', 'interrupt'].includes(message.type)) session?.[message.type]();
          else if (message.type === 'playback_done') session?.playbackDone?.(String(message.responseId || ''), ['played', 'interrupted', 'failed'].includes(message.outcome) ? message.outcome : 'failed');
          else if (message.type === 'notify') session?.notify(String(message.text || '').slice(0, 1800), String(message.notificationId || '').slice(0, 100));
      } catch (error) { starting = false; send({ type: 'error', message: error.message, fatal: true }); session?.close(); if (voiceOwner === socket) voiceOwner = null; socket.close(); }
    });
    socket.on('close', () => { cancelled = true; session?.close(); if (voiceOwner === socket) voiceOwner = null; });
    socket.on('error', () => { cancelled = true; session?.close(); if (voiceOwner === socket) voiceOwner = null; });
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

  if (isDebug) {
    const { createServer: createViteServer } = await import('vite');
    viteDevServer = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
      root: publicDir,
      appType: 'spa',
    });
  }

  const basePort = options.port !== undefined ? Number(options.port) : Number(process.env.PORT || 4317);
  let port = basePort;
  const host = options.host || '127.0.0.1';

  await new Promise((resolve, reject) => {
    const onError = error => {
      if (error.code === 'EADDRINUSE' && options.port === undefined && port < basePort + 10) {
        port += 1;
        server.listen(port, host);
      } else {
        server.removeListener('error', onError);
        reject(error);
      }
    };
    server.on('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const actualPort = server.address().port;
  console.log(`Voice Work Supervisor (${mode}): http://${host}:${actualPort}`);
  if (process.send) process.send({ type: 'supervisor-ready', url: `http://${host}:${actualPort}` });

  if (process.env.SUPERVISOR_DESKTOP === '1') setup.resume?.();
  if (setup.snapshot().status !== 'running' && options.prewarm !== false && (process.env.DEFAULT_VOICE_MODE || 'local') === 'local' && process.env.PREWARM_LOCAL_VOICE !== '0') {
    void warmLocalVoice().then(warmed => { if (warmed) console.log('Local speech models are warm.'); }).catch(error => console.warn(`Local voice warmup deferred: ${error.message}`));
  }

  const close = async () => {
    clearInterval(observer);
    await setup.close();
    for (const client of websocket.clients) {
      try { client.close(); } catch {}
    }
    try { websocket.close(); } catch {}
    for (const client of clients) {
      try { client.end(); } catch {}
    }
    clients.clear();
    if (viteDevServer) {
      await viteDevServer.waitForRequestsIdle();
      try { await viteDevServer.close(); } catch {}
      viteDevServer = null;
    }
    await new Promise(resolve => server.close(resolve));
  };

  return {
    server,
    websocket,
    supervisor,
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}`,
    mode,
    viteDevServer,
    close,
  };
}

export { tools, Supervisor };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { parseStartupArgs } = await import('../scripts/start.mjs');
  const args = parseStartupArgs();
  const instance = await startSupervisor(args);
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('disconnect', shutdown);
  process.on('message', message => { if (message?.type === 'shutdown') void shutdown(); });
}