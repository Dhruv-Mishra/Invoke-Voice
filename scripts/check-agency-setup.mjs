import os from 'node:os';
import path from 'node:path';
import { createAgencyMcp, AGENCY_MCP_SERVERS } from '../src/agency-mcp.mjs';
import { agencyReadPolicy } from '../src/agency-read.mjs';
import { createRuntimeConfig } from '../src/runtime-config.mjs';

const dataDir = path.resolve(process.env.SUPERVISOR_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VoiceSupervisor'));
createRuntimeConfig({ dataDir });
const mcp = createAgencyMcp();
try {
  const names = [...new Set([...AGENCY_MCP_SERVERS, ...agencyReadPolicy({ ...process.env, AGENCY_WORK_DATA_ACCESS: 'read-only' }).servers])];
  console.log('Checking Agency tool catalogs only. No private content is read and consent is unchanged.');
  const results = await mcp.check(names);
  for (const result of results) console.log(`${result.id}: ${result.status}. ${result.message}`);
  if (results.some(result => result.status !== 'ready')) process.exitCode = 1;
  console.log('Invoke starts its own proxies on app launch. Enable research in Settings > Integrations > Private work sources, then Save access.');
} finally {
  await mcp.close();
}