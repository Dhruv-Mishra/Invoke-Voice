import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { createAgencyMcp, AGENCY_MCP_SERVERS, probeAgencyMcp } from '../src/agency-mcp.mjs';
import { createDirectWorkTools } from '../src/direct-work-tools.mjs';
import { compactToolResult } from '../src/llm.mjs';
import { voiceTools, voiceToolsFor } from '../src/supervisor/contract.mjs';
import { sessionLaunch } from '../src/vscode-bridge.mjs';

function fixture() {
  const children = [];
  const spawnImpl = (executable, args, options) => {
    const child = Object.assign(new EventEmitter(), { executable, args, options, pid: 100 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => { child.signalCode = 'SIGTERM'; child.stdout.end(); child.stderr.end(); child.emit('close', null, 'SIGTERM'); };
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

test('MCP diagnostics use only bounded catalog requests and distinguish authentication and missing tools', async context => {
  const methods = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/auth') { response.writeHead(401).end(); return; }
    if (request.url === '/stall') return;
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    methods.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [{ name: 'retrieve', inputSchema: { type: 'object' } }] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await probeAgencyMcp(url, ['retrieve'])).status, 'ready');
  const missing = await probeAgencyMcp(url, ['fetch']);
  assert.equal(missing.status, 'tools_missing');
  assert.deepEqual(missing.missing, ['fetch']);
  assert.equal((await probeAgencyMcp(`${url}/auth`)).status, 'authentication_required');
  assert.equal((await probeAgencyMcp(`${url}/stall`, [], { timeoutMs: 50 })).status, 'unavailable');
  assert.ok(methods.every(method => ['initialize', 'notifications/initialized', 'tools/list'].includes(method)));
  await assert.rejects(probeAgencyMcp('https://untrusted.test'), /owned loopback/);
});

test('Agency proxies start once, publish only loopback endpoints and stop with their owner', async () => {
  const { children, spawnImpl } = fixture();
  const mcp = createAgencyMcp({ env: { AGENCY_CLI: 'agency-test' }, spawnImpl });
  const start = mcp.start();
  const concurrent = mcp.start();
  assert.equal(children.length, 3);
  children.forEach((child, index) => {
    assert.deepEqual(child.args, ['mcp', '--transport', 'http', '--port', '0', AGENCY_MCP_SERVERS[index]]);
    assert.equal(child.executable, 'agency-test');
    child.stdout.write('http://evil.test:1234/\n999999\n');
    child.stdout.write(`12${index}`);
    child.stdout.write('34\r\n');
  });
  await start;
  await concurrent;
  assert.deepEqual(Object.keys(mcp.configuration()), AGENCY_MCP_SERVERS);
  assert.equal(mcp.configuration().workiq.url, 'http://127.0.0.1:12134/');
  assert.ok(mcp.snapshot().every(entry => entry.status === 'listening'));
  children[0].kill();
  assert.equal(mcp.configuration().bluebird, undefined);
  assert.equal(mcp.snapshot()[0].status, 'unavailable');
  await mcp.close();
  assert.deepEqual(mcp.configuration(), {});
  await mcp.start();
  assert.equal(children.length, 3);
});

test('missing or stalled Agency never blocks startup and shutdown during startup settles', async () => {
  const { children, spawnImpl } = fixture();
  const mcp = createAgencyMcp({ spawnImpl, startupMs: 10 });
  const pending = mcp.start();
  children[0].emit('error', new Error('ENOENT'));
  await pending;
  assert.deepEqual(mcp.configuration(), {});
  assert.ok(mcp.snapshot().every(entry => entry.status === 'unavailable'));
  await mcp.close();
  const fresh = fixture();
  const closing = createAgencyMcp({ spawnImpl: fresh.spawnImpl });
  const start = closing.start();
  await closing.close();
  await start;
  assert.ok(closing.snapshot().every(entry => entry.status === 'stopped'));
  const absent = createAgencyMcp({ spawnImpl: () => { throw new Error('Missing'); } });
  await absent.start();
  await absent.close();
});

test('Agency retries failed proxies and reports catalog readiness without reading business data', async () => {
  const { children, spawnImpl } = fixture();
  const probes = [];
  const mcp = createAgencyMcp({ spawnImpl, probeImpl: async (url, required) => {
    probes.push({ url, required });
    return { status: 'ready', message: 'Catalog verified.', toolCount: required.length };
  } });
  const first = mcp.start();
  children[0].emit('error', new Error('ENOENT'));
  children[1].stdout.write('12001\n');
  children[2].stdout.write('12002\n');
  await first;
  const retry = mcp.start();
  assert.equal(children.length, 4);
  assert.equal(children[3].args.at(-1), 'bluebird');
  children[3].stdout.write('12003\n');
  await retry;
  const results = await mcp.check();
  assert.ok(results.every(result => result.status === 'ready'));
  assert.ok(mcp.snapshot().every(result => result.status === 'ready'));
  assert.deepEqual(probes.find(probe => probe.url.includes('12001')).required, ['retrieve', 'fetch', 'search_paths', 'get_schema']);
  assert.deepEqual(Object.keys(mcp.configuration()).sort(), [...AGENCY_MCP_SERVERS].sort());
  assert.throws(() => mcp.start(['untrusted']), /Unknown Agency/);
  await mcp.close();
});

test('direct voice tools load approved schemas on demand and reject unapproved calls', async context => {
  const methods = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (!body) { response.writeHead(200).end(); return; }
    const message = JSON.parse(body);
    methods.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'retrieve', description: 'Search work data', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, { name: 'fetch', description: 'Fetch work data', inputSchema: { type: 'object', description: 'x'.repeat(6000) } }, { name: 'ask', description: 'Delegate work', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'Found the requested item.' }] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const { children, spawnImpl } = fixture();
  const mcp = createAgencyMcp({ spawnImpl });
  context.after(() => mcp.close());
  const env = { AGENCY_WORK_DATA_ACCESS: 'read-only', VOICE_DIRECT_MCP_ACCESS: 'read-only' };
  const direct = createDirectWorkTools(mcp, env);
  const discovery = direct.call('find_work_tools', { source: 'workiq' });
  children[0].stdout.write(`${server.address().port}\n`);
  const discovered = await discovery;
  assert.deepEqual(discovered.tools.map(tool => tool.name), ['retrieve']);
  assert.equal(discovered.hasMore, true);
  assert.ok(JSON.stringify(discovered).length < 6000);
  const compact = compactToolResult({ source: 'workiq', tools: [discovered.tools[0], { ...discovered.tools[0], name: 'fetch' }], hasMore: false }, 240);
  assert.equal(Array.isArray(compact.tools), true);
  assert.equal(compact.preview, undefined);
  assert.equal(compact.hasMore, true);
  assert.ok(compact.tools.every(tool => tool.inputSchema));
  assert.deepEqual(await direct.call('call_work_tool', { source: 'workiq', name: 'retrieve', arguments: { query: 'status' } }), { content: [{ type: 'text', text: 'Found the requested item.' }] });
  await assert.rejects(direct.call('call_work_tool', { source: 'workiq', name: 'ask', arguments: {} }), /not approved/);
  assert.deepEqual(methods.filter(method => method === 'tools/call'), ['tools/call']);
  assert.deepEqual(voiceToolsFor({}), voiceTools);
  assert.equal(voiceToolsFor(env).length, voiceTools.length + 2);
  env.VOICE_DIRECT_MCP_ACCESS = 'disabled';
  await assert.rejects(direct.call('find_work_tools', { source: 'workiq' }), /disabled/);
});

test('shared MCP launch preserves read filters and avoids duplicate coding proxies', () => {
  const mcpServers = Object.fromEntries(AGENCY_MCP_SERVERS.map((name, index) => [name, { type: 'http', url: `http://127.0.0.1:${12000 + index}/`, tools: ['*'] }]));
  const task = { id: 'task', dataDir: 'C:\\data', worktree: 'C:\\worktree', backend: 'agency', sessionId: 'session', model: 'test', context: 'default' };
  const area = { allowPublish: false };
  const coding = sessionLaunch(task, area, {}, { mcpServers });
  assert.deepEqual(coding.args.slice(0, 7), ['copilot', '--hub', '--profile-only', `invoke-work-${task.sessionId}`, '--no-default-mcps', '--mcp', 'msft-learn']);
  const config = launch => JSON.parse(launch.args[launch.args.indexOf('--additional-mcp-config') + 1]).mcpServers;
  assert.deepEqual(config(coding), mcpServers);
  const read = sessionLaunch({ ...task, readOnly: true, directory: 'C:\\read', agencyProfile: 'voice-read-session', agencyReadPolicy: 'read-only-v1' }, area, { AGENCY_WORK_DATA_ACCESS: 'read-only' }, { mcpServers });
  assert.deepEqual(Object.keys(config(read)), ['voice-workiq', 'voice-teams']);
  assert.deepEqual(config(read)['voice-workiq'].tools, ['retrieve', 'fetch', 'search_paths', 'get_schema']);
  const disabled = sessionLaunch({ ...task, readOnly: true, directory: 'C:\\read', agencyProfile: 'voice-read-session', agencyReadPolicy: 'disabled-v1' }, area, {}, { mcpServers });
  assert.equal(disabled.args.includes('--additional-mcp-config'), false);
});