import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const READ_TOOLS = {
  'msft-learn': ['microsoft_docs_search', 'microsoft_code_sample_search', 'microsoft_docs_fetch'],
  teams: ['ListChats', 'GetChat', 'ListChatMembers', 'ListChatMessages', 'GetChatMessage', 'ListTeams', 'ListChannels', 'ListChannelMessages', 'ListChannelMessageReplies', 'SearchTeamMessagesQueryParameters'],
  calendar: ['ListCalendarView', 'GetUserDateAndTimeZoneSettings'],
  'm365-user': ['GetMyDetails', 'GetUserDetails', 'GetMultipleUsersDetails', 'GetManagerDetails', 'GetDirectReportsDetails'],
};

export function agencyReadPolicy(env = process.env) {
  const access = env.AGENCY_WORK_DATA_ACCESS || 'disabled';
  if (!['disabled', 'read-only'].includes(access)) throw new Error('Invalid Agency work-data access setting');
  const servers = access === 'read-only' ? Object.keys(READ_TOOLS) : ['msft-learn'];
  const executable = env.AGENCY_CLI || (process.platform === 'win32' ? 'agency.exe' : 'agency');
  const tools = Object.fromEntries(servers.map(server => [`voice-${server}`, [...READ_TOOLS[server]]]));
  return { id: `${access}-v1`, executable, servers, tools };
}

export async function prepareAgencyRead(task, dataDir, env = process.env, run = execute) {
  if (!/^[\w-]+$/.test(task.id) || !/^[\w-]+$/.test(task.sessionId)) throw new Error('Invalid read-only task identity');
  const policy = agencyReadPolicy(env);
  const parent = path.join(realpathSync.native(dataDir), 'agency-read');
  mkdirSync(parent, { recursive: true });
  if (realpathSync.native(parent) !== parent) throw new Error('Read-only tasks must stay inside the application data directory');
  const directory = path.join(parent, task.id);
  mkdirSync(directory, { recursive: true });
  if (realpathSync.native(directory) !== directory) throw new Error('Read-only task directory must not be redirected');
  const profile = `voice-read-${task.sessionId}`;
  await run(policy.executable, ['config', 'set', '--local', '--no-aec', '--profile', profile,
    ...policy.servers.flatMap(server => ['--mcp', `voice-${server}: ${server}`])], {
    cwd: directory, env: agencyReadEnvironment(env), windowsHide: true, timeout: 30000, maxBuffer: 65536,
  });
  return { directory, agencyReadPolicy: policy.id, agencyProfile: profile };
}

export function agencyReadEnvironment(env = process.env) {
  return { ...env, COPILOT_ALLOW_ALL: '0', AGENCY_AEC_ENABLED: '0', AGENCY_NO_INSTALLED_PLUGINS: '1',
    GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: 'false', GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: 'false',
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false', COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '', COPILOT_SKILLS_DIRS: '' };
}

export function agencyReadArgs(task, env = process.env) {
  const policy = agencyReadPolicy(env);
  if (task.backend !== 'agency' || !task.directory || !task.agencyProfile || task.agencyReadPolicy !== policy.id) {
    throw new Error('Agency read access changed or was not prepared. Start a new read-only task.');
  }
  const entries = Object.entries(policy.tools);
  return ['copilot', '--profile-only', task.agencyProfile, '--no-aec', '--no-config-plugins', '--no-default-mcps',
    '--no-custom-instructions', '--disallow-temp-dir', '--log-level', 'error', '--max-autopilot-continues', '1',
    `--available-tools=task_complete,${entries.flatMap(([server, tools]) => tools.map(tool => `${server}-${tool}`)).join(',')}`,
    `--allow-tool=${entries.flatMap(([server, tools]) => tools.map(tool => `${server}(${tool})`)).join(',')}`,
    '--deny-tool=shell,write,read,url'];
}