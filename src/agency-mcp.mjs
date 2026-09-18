import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agencyReadPolicy } from './agency-read.mjs';

export const AGENCY_MCP_SERVERS = ['bluebird', 'workiq', 'teams'];
const readTools = agencyReadPolicy({ AGENCY_WORK_DATA_ACCESS: 'read-only' }).tools;
const knownServers = new Set([...AGENCY_MCP_SERVERS, ...Object.keys(readTools).map(name => name.slice(6))]);

export async function probeAgencyMcp(url, requiredTools = [], { timeoutMs = 30000 } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) throw new Error('Agency diagnostics require an owned loopback endpoint.');
  const client = new Client({ name: 'voice-supervisor-setup', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { redirect: 'error' } });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    const tools = new Set();
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: timeoutMs });
      for (const tool of result.tools) tools.add(tool.name);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor || !tools.size) return { status: 'unavailable', message: cursor ? 'Tool catalog exceeded the setup limit.' : 'Agency returned an empty tool catalog. Check sign-in and retry setup.' };
    const missing = requiredTools.filter(name => !tools.has(name));
    return missing.length ? { status: 'tools_missing', message: 'Required read tools are missing. Update Agency and retry setup.', missing }
      : { status: 'ready', message: 'Tool catalog verified; account and content access are checked when a task reads a source.', toolCount: tools.size };
  } catch (error) {
    const authentication = [401, 403].includes(error.code) || /\b(401|403|unauthorized|authentication|sign.?in)\b/i.test(error.message);
    return { status: authentication ? 'authentication_required' : 'unavailable', message: authentication
      ? 'Sign in with your work account using Agency, then retry setup.'
      : 'Could not verify the tool catalog. Check Agency, network access and work-account sign-in, then retry setup.' };
  } finally { await client.close().catch(() => {}); }
}

export function createAgencyMcp({ env = process.env, spawnImpl = spawn, startupMs = 15000, probeImpl = probeAgencyMcp } = {}) {
  const entries = new Map();
  let starting;
  let closed = false;
  function launch(name) {
    const entry = { name, status: 'starting' };
    entries.set(name, entry);
    return new Promise(resolve => {
      let child;
      try {
        child = spawnImpl(env.AGENCY_CLI || (process.platform === 'win32' ? 'agency.exe' : 'agency'),
          ['mcp', '--transport', 'http', '--port', '0', name], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { entry.status = 'unavailable'; resolve(); return; }
      entry.child = child;
      const lines = createInterface({ input: child.stdout });
      let settled = false;
      const finish = status => {
        clearTimeout(timer);
        entry.status = status;
        if (status !== 'listening') delete entry.url;
        if (!settled) { settled = true; resolve(); }
      };
      const timer = setTimeout(() => { finish('unavailable'); child.kill(); }, startupMs);
      child.stderr.resume();
      lines.on('line', line => {
        if (settled || !/^\d{1,5}$/.test(line.trim())) return;
        const port = Number(line.trim());
        if (port < 1 || port > 65535) return;
        entry.url = `http://127.0.0.1:${port}/`;
        finish('listening');
      });
      child.once('error', () => { finish(closed ? 'stopped' : 'unavailable'); lines.close(); });
      child.once('close', () => { finish(closed ? 'stopped' : 'unavailable'); lines.close(); });
    });
  }
  return {
    start(names = AGENCY_MCP_SERVERS) {
      if (closed) return Promise.resolve();
      if (names.some(name => !knownServers.has(name))) throw new Error('Unknown Agency server');
      if (starting) return starting.then(() => this.start(names));
      const missing = names.filter(name => entries.get(name)?.status !== 'listening');
      if (!missing.length) return Promise.resolve();
      starting = Promise.all(missing.map(launch)).finally(() => { starting = undefined; });
      return starting;
    },
    async check(names = AGENCY_MCP_SERVERS) {
      await this.start(names);
      return Promise.all(names.map(async name => {
        const entry = entries.get(name);
        const result = entry?.url ? await probeImpl(entry.url, readTools[`voice-${name}`] || [])
          : { status: 'unavailable', message: 'Agency proxy did not start. Install Agency from https://aka.ms/agency or set its executable in Settings.' };
        if (entry) entry.check = result;
        return { id: name, ...result };
      }));
    },
    configuration() {
      return Object.fromEntries([...entries.values()].filter(entry => entry.status === 'listening').map(entry =>
        [entry.name, { type: 'http', url: entry.url, tools: ['*'] }]));
    },
    snapshot() {
      return [...new Set([...AGENCY_MCP_SERVERS, ...entries.keys()])].map(name => ({ id: name, label: `${name === 'workiq' ? 'WorkIQ' : name === 'bluebird' ? 'Bluebird' : name === 'teams' ? 'Teams' : name} MCP`, status: entries.get(name)?.status === 'listening' ? entries.get(name).check?.status || 'listening' : entries.get(name)?.status || 'stopped', mode: 'agency', ...(entries.get(name)?.check ? { message: entries.get(name).check.message } : {}) }));
    },
    async close() {
      closed = true;
      await Promise.all([...entries.values()].map(entry => new Promise(resolve => {
        if (!entry.child?.pid || entry.child.exitCode !== null || entry.child.signalCode) return resolve();
        entry.child.once('close', resolve);
        entry.child.kill();
      })));
      await starting;
    },
  };
}