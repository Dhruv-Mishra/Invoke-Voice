import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAgencyMcp, AGENCY_MCP_SERVERS } from '../src/agency-mcp.mjs';
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

test('Agency proxies start once, publish only loopback endpoints and stop with their owner', async () => {
  const { children, spawnImpl } = fixture();
  const mcp = createAgencyMcp({ env: { AGENCY_CLI: 'agency-test' }, spawnImpl });
  const start = mcp.start();
  assert.equal(mcp.start(), start);
  assert.equal(children.length, 3);
  children.forEach((child, index) => {
    assert.deepEqual(child.args, ['mcp', '--transport', 'http', '--port', '0', AGENCY_MCP_SERVERS[index]]);
    assert.equal(child.executable, 'agency-test');
    child.stdout.write('http://evil.test:1234/\n999999\n');
    child.stdout.write(`12${index}`);
    child.stdout.write('34\r\n');
  });
  await start;
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

test('shared MCP launch preserves read filters and avoids duplicate coding proxies', () => {
  const mcpServers = Object.fromEntries(AGENCY_MCP_SERVERS.map((name, index) => [name, { type: 'http', url: `http://127.0.0.1:${12000 + index}/`, tools: ['*'] }]));
  const task = { id: 'task', dataDir: 'C:\\data', worktree: 'C:\\worktree', backend: 'agency', sessionId: 'session', model: 'test', context: 'default' };
  const area = { allowPublish: false };
  const coding = sessionLaunch(task, area, {}, { mcpServers });
  assert.deepEqual(coding.args.slice(0, 5), ['copilot', '--hub', '--no-default-mcps', '--mcp', 'msft-learn']);
  const config = launch => JSON.parse(launch.args[launch.args.indexOf('--additional-mcp-config') + 1]).mcpServers;
  assert.deepEqual(config(coding), mcpServers);
  const read = sessionLaunch({ ...task, readOnly: true, directory: 'C:\\read', agencyProfile: 'voice-read-session', agencyReadPolicy: 'read-only-v1' }, area, { AGENCY_WORK_DATA_ACCESS: 'read-only' }, { mcpServers });
  assert.deepEqual(Object.keys(config(read)), ['voice-workiq', 'voice-teams']);
  assert.deepEqual(config(read)['voice-workiq'].tools, ['retrieve', 'fetch', 'search_paths', 'get_schema']);
  const disabled = sessionLaunch({ ...task, readOnly: true, directory: 'C:\\read', agencyProfile: 'voice-read-session', agencyReadPolicy: 'disabled-v1' }, area, {}, { mcpServers });
  assert.equal(disabled.args.includes('--additional-mcp-config'), false);
});