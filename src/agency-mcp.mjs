import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const AGENCY_MCP_SERVERS = ['bluebird', 'workiq', 'teams'];

export function createAgencyMcp({ env = process.env, spawnImpl = spawn, startupMs = 15000 } = {}) {
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
    start() {
      if (closed) return Promise.resolve();
      starting ??= Promise.all(AGENCY_MCP_SERVERS.map(launch));
      return starting;
    },
    configuration() {
      return Object.fromEntries([...entries.values()].filter(entry => entry.status === 'listening').map(entry =>
        [entry.name, { type: 'http', url: entry.url, tools: ['*'] }]));
    },
    snapshot() {
      return AGENCY_MCP_SERVERS.map(name => ({ id: name, label: `${name === 'workiq' ? 'WorkIQ' : name === 'bluebird' ? 'Bluebird' : 'Teams'} MCP`, status: entries.get(name)?.status || 'stopped', mode: 'agency' }));
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