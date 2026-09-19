import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { ensureLocalLLM, localLlmArguments, parseStartupArgs } from '../scripts/start.mjs';
import { voiceTools } from '../src/supervisor/contract.mjs';
import { createRuntimeConfig, localThreadDefault } from '../src/runtime-config.mjs';
import { voiceInstructions } from '../src/llm.mjs';
import { tools } from '../src/supervisor/contract.mjs';
import { createVoiceToolCaller, startSupervisor } from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Agency connection checks respect consent, reject remote origins and never change configuration', async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-agency-status-'));
  const saved = process.env.AGENCY_WORK_DATA_ACCESS;
  process.env.AGENCY_WORK_DATA_ACCESS = 'disabled';
  const checks = [];
  const app = await startSupervisor({ dataDir, port: 0, prewarm: false, agencyMcp: {
    snapshot: () => [], close: async () => {},
    check: async names => { checks.push(names); return names.map(id => ({ id, status: 'ready' })); },
  } });
  context.after(async () => {
    await app.close();
    if (saved === undefined) delete process.env.AGENCY_WORK_DATA_ACCESS;
    else process.env.AGENCY_WORK_DATA_ACCESS = saved;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const check = (body = {}, origin = app.url) => fetch(`${app.url}/api/agency/check`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await check({}, 'https://untrusted.test')).status, 403);
  assert.equal(checks.length, 0);
  const disabled = await (await check()).json();
  assert.equal(disabled.workDataAccess, 'disabled');
  assert.deepEqual(checks[0], ['bluebird', 'workiq', 'teams', 'msft-learn']);
  assert.equal((await check({ AGENCY_WORK_DATA_ACCESS: 'read-only' })).status, 400);
  assert.equal(process.env.AGENCY_WORK_DATA_ACCESS, 'disabled');
  const save = await fetch(`${app.url}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url }, body: JSON.stringify({ values: { AGENCY_WORK_DATA_ACCESS: 'read-only' } }) });
  assert.equal(save.status, 200);
  const enabled = await (await check()).json();
  assert.equal(enabled.workDataAccess, 'read-only');
  assert.deepEqual(checks[1], ['bluebird', 'workiq', 'teams', 'msft-learn', 'calendar', 'm365-user']);
  const revoke = await fetch(`${app.url}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url }, body: JSON.stringify({ values: { AGENCY_WORK_DATA_ACCESS: 'disabled' } }) });
  assert.equal(revoke.status, 200);
  assert.equal((await (await check()).json()).workDataAccess, 'disabled');
});

test('voice notifications persist acceptance and never replay across sessions', async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-notification-ack-'));
  const supervisor = new Supervisor({ dataDir, bridge: {} });
  supervisor.updateSettings({ greetOnConnect: false });
  supervisor.publishNotification({ id: 'failed-task', title: 'Failed task', state: 'agent_failed' }, 'Task failed.');
  const notificationId = supervisor.snapshot().notifications[0].id;
  const delivered = [];
  let accept = false;
  let attempted;
  const app = await startSupervisor({ dataDir, port: 0, prewarm: false, supervisor,
    createRealtimeVoice: async ({ send }) => {
      send({ type: 'ready' });
      return { close() {}, notify(text, id) { attempted?.(); if (!accept) return false; delivered.push(id); return true; } };
    },
  });
  const sockets = [];
  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const connect = async () => {
    const socket = new WebSocket(`${app.url.replace('http:', 'ws:')}/voice`);
    sockets.push(socket);
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'start', mode: 'openai-realtime' }));
    assert.equal(JSON.parse((await ready)[0]).type, 'ready');
    return socket;
  };
  const notify = socket => socket.send(JSON.stringify({ type: 'notify', notificationId, text: 'Failed task: failed' }));
  const socket = await connect();
  const rejected = new Promise(resolve => { attempted = resolve; });
  notify(socket);
  await rejected;
  assert.equal(supervisor.snapshot().notifications[0].read, false);
  accept = true;
  const acknowledged = once(socket, 'message');
  notify(socket);
  assert.deepEqual(JSON.parse((await acknowledged)[0]), { type: 'notify_ack', notificationId });
  assert.equal(supervisor.snapshot().notifications[0].read, true);
  assert.equal(new Supervisor({ dataDir, bridge: {} }).snapshot().notifications[0].read, true);
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  const nextSocket = await connect();
  const duplicate = once(nextSocket, 'message');
  notify(nextSocket);
  assert.equal(JSON.parse((await duplicate)[0]).type, 'notify_ack');
  assert.deepEqual(delivered, [notificationId]);
});

test('voice tool bridge ends calls locally and delegates supervisor tools', async () => {
  const events = [];
  const calls = [];
  const callTool = createVoiceToolCaller({
    callTool(name, args, context) {
      calls.push({ name, args, context });
      return { delegated: true };
    },
  }, event => events.push(event));

  assert.deepEqual(await callTool('end_call', {}, { requestId: 'voice-end' }), { ended: true });
  assert.deepEqual(events, [{ type: 'end_call' }]);
  assert.deepEqual(await callTool('list_work', { query: 'docs' }, { requestId: 'voice-list' }), { delegated: true });
  assert.deepEqual(calls, [{ name: 'list_work', args: { query: 'docs' }, context: { requestId: 'voice-list' } }]);
});

test('local runtime defaults match displayed settings and honor explicit overrides', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-runtime-defaults-'));
  try {
    const defaults = Object.fromEntries(createRuntimeConfig({ dataDir, env: {} }).snapshot().fields.map(field => [field.key, field.value]));
    const paths = { ling: 'ling.gguf' };
    const url = new URL('http://127.0.0.1:43210/v1');
    const args = localLlmArguments(paths, url, {});
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value('--ctx-size'), '4096');
    assert.equal(value('--parallel'), '1');
    assert.equal(value('--threads'), localThreadDefault(8));
    assert.equal(value('--threads-batch'), value('--threads'));
    assert.equal(defaults.LLAMA_CONTEXT, value('--ctx-size'));
    assert.equal(defaults.LLAMA_PARALLEL, value('--parallel'));
    assert.equal(defaults.LLAMA_THREADS, value('--threads'));
    assert.equal(defaults.CRISPASR_THREADS, localThreadDefault(12));
    for (const [key, flag] of [['LLAMA_GPU_LAYERS', '--gpu-layers'], ['LLAMA_FLASH_ATTN', '--flash-attn'], ['LLAMA_CACHE_TYPE_K', '--cache-type-k'], ['LLAMA_CACHE_TYPE_V', '--cache-type-v']]) {
      assert.equal(defaults[key], value(flag));
    }
    const legacy = createRuntimeConfig({ dataDir, env: { LOCAL_THREADS: '2' } }).snapshot().fields;
    assert.equal(legacy.find(field => field.key === 'CRISPASR_THREADS').value, '2');
    assert.equal(localThreadDefault(8, 1), '1');
    assert.equal(localThreadDefault(8, 4), '3');
    assert.equal(localThreadDefault(8, 32), '8');
    assert.equal(localThreadDefault(4, 32), '4');
    const explicit = localLlmArguments(paths, url, { LLAMA_THREADS: '12', LLAMA_CONTEXT: '8192', LLAMA_PARALLEL: '2', LLAMA_GPU_LAYERS: '0', LLAMA_FLASH_ATTN: 'off', LLAMA_CACHE_TYPE_K: 'q8_0', LLAMA_CACHE_TYPE_V: 'q8_0' });
    assert.equal(explicit[explicit.indexOf('--threads') + 1], '12');
    assert.equal(explicit[explicit.indexOf('--ctx-size') + 1], '8192');
    assert.equal(explicit[explicit.indexOf('--parallel') + 1], '2');
    assert.equal(explicit[explicit.indexOf('--gpu-layers') + 1], '0');
    assert.equal(explicit[explicit.indexOf('--flash-attn') + 1], 'off');
    assert.equal(explicit[explicit.indexOf('--cache-type-k') + 1], 'q8_0');
    assert.equal(explicit[explicit.indexOf('--cache-type-v') + 1], 'q8_0');
    const env = {};
    const config = createRuntimeConfig({ dataDir, env });
    for (const values of [{ LLAMA_GPU_LAYERS: '-1' }, { LLAMA_GPU_LAYERS: 'all' }, { LLAMA_FLASH_ATTN: 'invalid' }, { LLAMA_CACHE_TYPE_V: 'unknown' }]) {
      assert.throws(() => config.update({ values }), /unsupported|must be/);
    }
    const values = { LLAMA_GPU_LAYERS: '24', LLAMA_CACHE_TYPE_K: 'q8_0', LLAMA_CACHE_TYPE_V: 'f16', LLAMA_FLASH_ATTN: 'on' };
    const changed = config.update({ values });
    for (const key of Object.keys(values)) {
      assert.equal(env[key], undefined);
      assert.equal(changed.fields.find(field => field.key === key).pendingRestart, values[key] !== defaults[key]);
    }
    createRuntimeConfig({ dataDir, env });
    for (const [key, value] of Object.entries(values)) assert.equal(env[key], value);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('local warmup caches the real tool prefix and accepts bounded completions without visible text', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-runtime-warm-'));
  const modelPath = path.join(dataDir, 'fixture.gguf');
  writeFileSync(modelPath, 'fixture');
  const requests = [];
  let healthChecks = 0;
  let result = { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      healthChecks += 1;
      response.end('{}');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { LOCAL_LLM_PATH: modelPath, LOCAL_LLM_URL: url };
  try {
    const runtime = await ensureLocalLLM({ env, requireWarm: true });
    assert.equal(runtime.owned, false);
    assert.equal(runtime.llama, null);
    assert.equal(healthChecks, 2);
    assert.deepEqual(requests[0].messages[0], { role: 'system', content: voiceInstructions });
    assert.deepEqual(requests[0].tools, voiceTools);
    assert.equal(requests[0].chat_template_kwargs.enable_thinking, false);
    assert.equal(requests[0].tool_choice, 'auto');
    assert.equal(requests[0].cache_prompt, true);
    assert.equal(requests[0].max_tokens, 1);
    const checked = await ensureLocalLLM({ env, checkOnly: true });
    assert.equal(checked.checked, true);
    assert.equal(checked.text, '');
    result = { choices: [] };
    await assert.rejects(ensureLocalLLM({ env, requireWarm: true }), /invalid completion/);
    await assert.rejects(ensureLocalLLM({ env, checkOnly: true }), /invalid completion/);
    assert.equal(server.listening, true);
    assert.equal(env.LOCAL_LLM_URL, url);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('parseStartupArgs supports intuitive debug, release, local, and port flags', () => {
  // Defaults
  const def = parseStartupArgs([], {});
  assert.equal(def.mode, 'release');
  assert.equal(def.isDebug, false);
  assert.equal(def.isRelease, true);
  assert.equal(def.isLocal, false);
  assert.equal(def.isCheck, false);
  assert.equal(def.port, 4317);

  // User's npm start -debug example (npm config environment variable)
  const npmDebug = parseStartupArgs([], { npm_config_debug: 'true' });
  assert.equal(npmDebug.mode, 'debug');
  assert.equal(npmDebug.isDebug, true);

  // Command-line debug flags
  for (const flag of ['-debug', '--debug', 'debug', '-d']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.mode, 'debug', `flag ${flag} should trigger debug mode`);
    assert.equal(parsed.isDebug, true);
  }

  // Environment debug flags
  assert.equal(parseStartupArgs([], { DEBUG: '1' }).mode, 'debug');
  assert.equal(parseStartupArgs([], { SUPERVISOR_DEBUG: '1' }).mode, 'debug');
  assert.equal(parseStartupArgs([], { SUPERVISOR_MODE: 'debug' }).mode, 'debug');
  assert.equal(parseStartupArgs([], { NODE_ENV: 'development' }).mode, 'debug');

  // Command-line release flags
  for (const flag of ['-release', '--release', 'release', '-r']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.mode, 'release', `flag ${flag} should trigger release mode`);
    assert.equal(parsed.isRelease, true);
  }

  // Explicit release flag overrides ambient debug env
  assert.equal(parseStartupArgs(['--release'], { DEBUG: '1' }).mode, 'release');
  assert.equal(parseStartupArgs(['-release'], { npm_config_debug: 'true' }).mode, 'release');

  // Local voice flags
  for (const flag of ['-local', '--local', 'local', '-l']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.isLocal, true, `flag ${flag} should trigger local mode`);
  }
  assert.equal(parseStartupArgs([], { npm_config_local: 'true' }).isLocal, true);
  assert.equal(parseStartupArgs([], { SUPERVISOR_LOCAL: '1' }).isLocal, true);

  // Local check flags
  for (const flag of ['-check', '--check', 'check']) {
    const parsed = parseStartupArgs([flag], {});
    assert.equal(parsed.isCheck, true, `flag ${flag} should trigger check mode`);
  }
  assert.equal(parseStartupArgs([], { npm_config_check: 'true' }).isCheck, true);

  // Port parsing
  assert.equal(parseStartupArgs(['--port', '5050'], {}).port, 5050);
  assert.equal(parseStartupArgs(['-port', '5051'], {}).port, 5051);
  assert.equal(parseStartupArgs(['-p', '5052'], {}).port, 5052);
  assert.equal(parseStartupArgs(['--port=5053'], {}).port, 5053);
  assert.equal(parseStartupArgs([], { PORT: '5054' }).port, 5054);

  // Combined debug and local flags
  const combined = parseStartupArgs(['-debug', '-local', '--port', '4900'], {});
  assert.equal(combined.mode, 'debug');
  assert.equal(combined.isLocal, true);
  assert.equal(combined.port, 4900);
});

test('release mode serves built frontend assets with accurate MIME types and owns lifecycle', async () => {
  const supervisor = await startSupervisor({ port: 0, mode: 'release', prewarm: false });
  assert.ok(supervisor.port > 0);
  const baseUrl = supervisor.url;

  try {
    // Root HTML
      const indexRes = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers.get('content-type')?.includes('text/html'));
    const indexHtml = await indexRes.text();
      assert.ok(indexHtml.includes('<title>Invoke</title>'));

    // Capture worklet from public dir
    const workletRes = await fetch(`${baseUrl}/capture-worklet.js`);
    assert.equal(workletRes.status, 200);
    assert.ok(workletRes.headers.get('content-type')?.includes('text/javascript'));

    // Discover built assets in dist/assets
    const assetsDir = path.join(root, 'dist', 'assets');
    const assetFiles = readdirSync(assetsDir);
    const cssFile = assetFiles.find(f => f.endsWith('.css'));
    const jsFile = assetFiles.find(f => f.endsWith('.js'));
    const webpFile = assetFiles.find(f => f.endsWith('.webp'));

    if (cssFile) {
      const cssRes = await fetch(`${baseUrl}/assets/${cssFile}`);
      assert.equal(cssRes.status, 200);
      assert.ok(cssRes.headers.get('content-type')?.includes('text/css'));
    }

    if (jsFile) {
      const jsRes = await fetch(`${baseUrl}/assets/${jsFile}`);
      assert.equal(jsRes.status, 200);
      assert.ok(jsRes.headers.get('content-type')?.includes('text/javascript'));
    }

    if (webpFile) {
      const webpRes = await fetch(`${baseUrl}/assets/${webpFile}`);
      assert.equal(webpRes.status, 200);
      assert.ok(webpRes.headers.get('content-type')?.includes('image/webp'));
    }

    // Backend API endpoints
    const configRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(configRes.status, 200);
    assert.ok(configRes.headers.get('content-type')?.includes('application/json'));
    const configData = await configRes.json();
    assert.ok(configData.providers);

    // Unmatched API endpoint returns 404 JSON
    const notFoundApi = await fetch(`${baseUrl}/api/nonexistent`);
    assert.equal(notFoundApi.status, 404);
    assert.deepEqual(await notFoundApi.json(), { error: 'Not found' });

    // Path traversal is blocked
    const traversal = await fetch(`${baseUrl}/..%2fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await supervisor.close();
  }
});

test('inbox polling survives a missing directory and resumes after restoration', async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-inbox-'));
  const inbox = path.join(dataDir, 'inbox');
  const supervisor = new Supervisor({ dataDir });
  const observations = [];
  context.mock.method(supervisor, 'observe', observation => observations.push(observation));
  context.mock.timers.enable({ apis: ['setInterval'] });
  const app = await startSupervisor({ dataDir, supervisor, port: 0, mode: 'release', prewarm: false });
  try {
    rmSync(inbox, { recursive: true });
    context.mock.timers.tick(1500);
    assert.deepEqual(observations, []);
    assert.equal((await fetch(`${app.url}/api/config`)).status, 200);
    mkdirSync(inbox);
    writeFileSync(path.join(inbox, 'observation.json'), JSON.stringify({ taskId: 'fixture' }));
    context.mock.timers.tick(750);
    assert.deepEqual(observations, [{ taskId: 'fixture' }]);
    assert.deepEqual(readdirSync(inbox), []);
  } finally {
    await app.close();
    context.mock.timers.reset();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shutdown aborts active chat streams', { timeout: 5000 }, async () => {
  let acceptProviderRequest;
  const providerRequested = new Promise(resolve => { acceptProviderRequest = resolve; });
  const provider = http.createServer((request, response) => {
    acceptProviderRequest();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));

  const previousUrl = process.env.LOCAL_LLM_URL;
  process.env.LOCAL_LLM_URL = `http://127.0.0.1:${provider.address().port}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-close-'));
  const app = await startSupervisor({ dataDir, port: 0, mode: 'release', prewarm: false });
  const chat = fetch(`${app.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'local', messages: [{ role: 'user', content: 'hello' }] }),
  });

  try {
    await providerRequested;
    const chatResponse = await chat;
    assert.equal(chatResponse.headers.get('content-type'), 'text/event-stream');
    await app.close();
    await chatResponse.text();
    assert.equal(app.server.listening, false);
  } finally {
    if (previousUrl === undefined) delete process.env.LOCAL_LLM_URL;
    else process.env.LOCAL_LLM_URL = previousUrl;
    await app.close();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('debug mode closes before any frontend requests', { timeout: 15000 }, async () => {
  const supervisor = await startSupervisor({ port: 0, mode: 'debug', prewarm: false });
  await supervisor.close();
  assert.equal(supervisor.server.listening, false);
});

test('debug mode serves same-origin routes and closes during cold dependency optimization', { timeout: 15000 }, async () => {
  const supervisor = await startSupervisor({ port: 0, mode: 'debug', prewarm: false });
  assert.ok(supervisor.port > 0);
  assert.ok(supervisor.viteDevServer, 'Vite dev server should be instantiated in debug mode');
  const baseUrl = supervisor.url;

  try {
    await supervisor.viteDevServer.restart(true);

    // In debug mode, GET / transforms index.html and injects Vite HMR client
    const indexRes = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers.get('content-type')?.includes('text/html'));
    const indexHtml = await indexRes.text();
    assert.ok(indexHtml.includes('/@vite/client'), 'Debug HTML must include Vite client script');
    assert.ok(indexHtml.includes('<title>Invoke</title>'));

    // Direct module serving from source
    const mainRes = await fetch(`${baseUrl}/main.js`, { signal: AbortSignal.timeout(5000) });
    assert.equal(mainRes.status, 200);
    assert.ok(mainRes.headers.get('content-type')?.includes('text/javascript'));
    await mainRes.text();

    // Static image serving through Vite
    const iconRes = await fetch(`${baseUrl}/copilot-icon.webp`, { signal: AbortSignal.timeout(5000) });
    assert.equal(iconRes.status, 200);
    assert.ok(iconRes.headers.get('content-type')?.includes('image/webp'));
    await iconRes.arrayBuffer();

    // Backend API is served directly on the same origin/port without proxy drift
    const configRes = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(5000) });
    assert.equal(configRes.status, 200);
    const configData = await configRes.json();
    assert.ok(configData.providers);

    // WebSocket /voice connects directly to backend on the same server
    const ws = new WebSocket(`ws://127.0.0.1:${supervisor.port}/voice`);
    const connected = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 5000);
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve(true);
      });
      ws.once('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    assert.equal(connected, true);
    ws.close();
  } finally {
    await supervisor.close();
  }
  assert.equal(supervisor.server.listening, false);
});
