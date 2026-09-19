import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { copilotPrompt, createVSCodeBridge, sessionEventText, sessionLaunch, worktreeWindowArgs } from '../src/vscode-bridge.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { agencyReadPolicy, prepareAgencyRead } from '../src/agency-read.mjs';

const execute = promisify(execFile);

test('managed workspace resumes an empty Git initialization without committing staged content', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-unborn-'));
  try {
    const bridge = createVSCodeBridge(dataDir);
    const area = new Supervisor({ dataDir, bridge }).resolveArea();
    const git = async (...args) => (await execute('git', args, { cwd: area.repoPath, windowsHide: true })).stdout.trim();
    await git('init', '--initial-branch=main', '--template=');
    writeFileSync(path.join(area.repoPath, 'staged.txt'), 'Not part of bootstrap.');
    await git('add', 'staged.txt');
    await bridge.verifyRepo(area.repoPath);
    assert.equal(await git('ls-tree', '--name-only', 'HEAD'), '');
    assert.equal(await git('diff', '--cached', '--name-only'), 'staged.txt');
    assert.equal(readFileSync(path.join(area.repoPath, 'staged.txt'), 'utf8'), 'Not part of bootstrap.');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('managed workspace refuses redirected folders and Git metadata', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-containment-'));
  const dataDir = path.join(rootDir, 'data');
  const external = path.join(rootDir, 'external');
  try {
    mkdirSync(dataDir);
    mkdirSync(external);
    writeFileSync(path.join(external, 'sentinel.txt'), 'Unchanged.');
    const workspace = path.join(dataDir, 'workspace');
    symlinkSync(external, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => new Supervisor({ dataDir, bridge: {} }), /Default workspace must stay inside/);
    assert.equal(existsSync(path.join(dataDir, 'state.json')), false);
    unlinkSync(workspace);
    const bridge = createVSCodeBridge(dataDir);
    const area = new Supervisor({ dataDir, bridge }).resolveArea();
    const gitDirectory = path.join(area.repoPath, '.git');
    symlinkSync(external, gitDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(bridge.verifyRepo(area.repoPath), /Git directory must be a local directory/);
    unlinkSync(gitDirectory);
    writeFileSync(gitDirectory, `gitdir: ${external}\n`);
    await assert.rejects(bridge.verifyRepo(area.repoPath), /Git directory must be a local directory/);
    unlinkSync(gitDirectory);
    const worktrees = path.join(dataDir, 'worktrees');
    symlinkSync(external, worktrees, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(bridge.prepare({ id: 'redirected-worktree' }, area), /worktrees must stay inside/);
    unlinkSync(worktrees);
    assert.deepEqual(readdirSync(external), ['sentinel.txt']);
    assert.equal(readFileSync(path.join(external, 'sentinel.txt'), 'utf8'), 'Unchanged.');
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('managed workspace bootstraps real isolated worktrees without publishing or staging files', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-workspace-'));
  const git = async (cwd, ...args) => (await execute('git', args, { cwd, windowsHide: true })).stdout.trim();
  try {
    const bridge = createVSCodeBridge(dataDir);
    const supervisor = new Supervisor({ dataDir, bridge });
    const area = supervisor.resolveArea();
    mkdirSync(path.join(area.repoPath, '.git'));
    writeFileSync(path.join(area.repoPath, 'untouched.txt'), 'Leave this file alone.');
    const prepared = await Promise.all([
      bridge.prepare({ id: '11111111-first' }, area),
      bridge.prepare({ id: '22222222-second' }, area),
    ]);
    const head = await git(area.repoPath, 'rev-parse', 'HEAD');
    assert.equal(await git(area.repoPath, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(area.repoPath, 'ls-tree', '--name-only', 'HEAD'), '');
    assert.equal(await git(area.repoPath, 'remote'), '');
    assert.equal(await git(area.repoPath, 'diff', '--cached', '--name-only'), '');
    assert.equal(readFileSync(path.join(area.repoPath, 'untouched.txt'), 'utf8'), 'Leave this file alone.');
    assert.doesNotMatch(readFileSync(path.join(area.repoPath, '.git', 'config'), 'utf8'), /\[user\]|workspace@localhost/);
    for (const work of prepared) {
      assert.equal(path.dirname(work.worktree), path.join(realpathSync(dataDir), 'worktrees'));
      assert.equal(await git(work.worktree, 'rev-parse', 'HEAD'), head);
      assert.equal(existsSync(path.join(work.worktree, 'untouched.txt')), false);
      assert.match(copilotPrompt({ objective: 'Test', ...work }, area), /Do not commit, push, or create a PR/);
    }
    const restoredBridge = createVSCodeBridge(dataDir);
    await restoredBridge.verifyRepo(area.repoPath);
    const restored = new Supervisor({ dataDir, bridge: restoredBridge });
    await restored.registerArea({ ...area, name: 'Renamed workspace' });
    assert.equal(await git(area.repoPath, 'rev-parse', 'HEAD'), head);
    assert.equal(restored.resolveArea().name, 'Renamed workspace');
    const unrelated = path.join(dataDir, 'unregistered');
    mkdirSync(unrelated);
    await assert.rejects(restoredBridge.verifyRepo(unrelated));
    assert.equal(existsSync(path.join(unrelated, '.git')), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('extracts final text from Copilot and Agency completion events', () => {
  assert.equal(sessionEventText({ type: 'assistant.message', data: { content: 'Copilot done' } }), 'Copilot done');
  assert.equal(sessionEventText({ type: 'session.task_complete', data: { summary: 'Agency done', taskId: 'internal-task', sessionId: 'internal-session' } }), 'Agency done');
  assert.equal(sessionEventText({ type: 'assistant.turn_end', data: {} }), '');
});

test('Copilot prompt includes area instructions and worktrees open separately', () => {
  const prompt = copilotPrompt(
    { objective: 'Fix settings', worktree: 'C:\\worktree' },
    { allowPublish: false, instructions: 'Use the existing API contract.' },
  );
  assert.match(prompt, /Fix settings/);
  assert.match(prompt, /Work area instructions:\nUse the existing API contract\./);
  assert.deepEqual(worktreeWindowArgs('C:\\worktree'), ['--new-window', 'C:\\worktree']);
});

test('delegated questions retain original intent, date context and a bounded spoken answer', () => {
  const objective = 'What is my latest message on the PDF group from yesterday?';
  const task = { objective, worktree: 'C:\\worktree', createdAt: Date.parse('2026-09-18T12:00:00Z') };
  const area = { allowPublish: false, instructions: '' };
  const prompt = copilotPrompt(task, area);
  assert.ok(prompt.includes(objective));
  assert.match(prompt, /2026-09-18T12:00:00.000Z; user timezone:/);
  assert.match(prompt, /without changing files or remote data/);
  assert.match(prompt, /at most two short sentences and 320 characters/);
  assert.match(prompt, /source links, dates/);
  assert.match(prompt, /access is unavailable/);
  for (const readOnly of [false, true]) {
    const summaryPrompt = copilotPrompt({ ...task, readOnly, id: 'internal-task', sessionId: 'internal-session' }, area, {});
    assert.match(summaryPrompt, /Omit internal task and session IDs from the summary/);
    assert.match(summaryPrompt, /at most three short bullets only for essential source links, dates or validation/);
    assert.match(summaryPrompt, /No preamble, progress recap or repeated summary/);
    assert.match(summaryPrompt, /Expand only when explicitly requested/);
    const detailedRequest = 'Explain the evidence in detail, including all limitations.';
    assert.ok(copilotPrompt({ ...task, readOnly, objective: detailedRequest }, area, {}).includes(detailedRequest));
    assert.doesNotMatch(summaryPrompt, /internal-task|internal-session/);
  }
  assert.match(copilotPrompt({ ...task, turns: [{ createdAt: Date.parse('2026-09-19T12:00:00Z') }] }, area), /2026-09-19T12:00:00.000Z/);
  const recovered = copilotPrompt({ ...task, turns: [
    { state: 'dispatching', createdAt: Date.parse('2026-09-18T13:00:00Z') },
    { state: 'queued', createdAt: Date.parse('2026-09-18T14:00:00Z') },
    { state: 'result_ready', createdAt: Date.parse('2026-09-19T12:00:00Z') },
  ] }, area);
  assert.match(recovered, /2026-09-18T13:00:00.000Z/);
  assert.ok(prompt.length - objective.length < 950);
});

test('research distinguishes existing supervisor tasks, consent and source failures', () => {
  const task = { readOnly: true, objective: 'Summarize the project documentation' };
  const area = { allowPublish: false };
  const disabled = copilotPrompt(task, area, {});
  assert.match(disabled, /supervisor task already exists/);
  assert.match(disabled, /enable Agency work data in Settings, then retry this task/);
  assert.match(disabled, /do not claim sign-in failed/);
  const enabled = copilotPrompt(task, area, { AGENCY_WORK_DATA_ACCESS: 'read-only' });
  assert.match(enabled, /Try the relevant tool before claiming access is unavailable/);
  assert.doesNotMatch(enabled, /disabled by user consent/);
});

test('builds explicit Copilot and Agency start and resume commands', () => {
  const base = { dataDir: 'C:\\data', worktree: 'C:\\worktree', model: 'gpt-5.6-sol', context: 'default', sessionId: '11111111-1111-4111-8111-111111111111', agent: 'builder' };
  const area = { allowPublish: false, instructions: '' };
  const copilot = sessionLaunch({ ...base, backend: 'copilot' }, area, { COPILOT_CLI: 'copilot-test', COPILOT_REASONING: 'low' });
  assert.equal(copilot.executable, 'copilot-test');
  assert.deepEqual(copilot.args.slice(-4), ['--session-id', base.sessionId, '--agent', 'builder']);
  const agency = sessionLaunch({ ...base, backend: 'agency' }, area, { AGENCY_CLI: 'agency-test' }, { resume: true });
  assert.equal(agency.executable, 'agency-test');
  assert.deepEqual(agency.args.slice(0, 13), ['copilot', '--hub', '--profile-only', `invoke-work-${base.sessionId}`, '--no-default-mcps', '--mcp', 'bluebird', '--mcp', 'workiq', '--mcp', 'teams', '--mcp', 'msft-learn']);
  assert.equal(copilot.args.includes('--mcp'), false);
  assert.equal(agency.args.includes('workiq'), true);
  assert.ok(agency.args.includes(`--resume=${base.sessionId}`));
  assert.equal(agency.args.includes('--session-id'), false);
  assert.equal(agency.prompt.includes(base.sessionId), false);
  assert.equal(agency.args[agency.args.indexOf('--model') + 1], base.model);
  for (const backend of ['copilot', 'agency']) {
    for (const resume of [false, true]) {
      for (const model of ['default', ' Default ', '', undefined]) {
        const launch = sessionLaunch({ ...base, backend, model }, area, {}, { resume });
        assert.equal(launch.args.includes('--model'), false);
        assert.equal(launch.args.includes(undefined), false);
      }
    }
  }
});

test('agent progress reports one process start across multiple model turns', async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-progress-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const bridge = createVSCodeBridge(dataDir, {}, { spawnImpl: () => child });
  const reports = [];
  const task = { id: 'task', backend: 'copilot', worktree: dataDir, sessionId: 'session', objective: 'Check work', model: 'test', context: 'default' };
  const pending = bridge.dispatch(task, {}, event => reports.push(event));
  child.emit('spawn');
  for (let turn = 0; turn < 4; turn++) {
    child.stdout.write(`${JSON.stringify({ type: 'assistant.turn_start' })}\n`);
    child.stdout.write(`${JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'read' } })}\n`);
  }
  child.stdout.write(`${JSON.stringify({ type: 'session.task_complete', data: { summary: 'Correct answer' } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'result', sessionId: 'session', exitCode: 0 })}\n`);
  child.emit('close', 0, null);
  assert.equal((await pending).result, 'Correct answer');
  assert.equal(reports.filter(event => event.summary.endsWith('started working.')).length, 1);
  assert.equal(reports.filter(event => event.summary === 'Running read.').length, 4);
});

test('cancelling a bridge session stops its owned process tree and rejects late results', { timeout: 15000 }, async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-cancel-process-'));
  let child;
  const bridge = createVSCodeBridge(dataDir, {}, { spawnImpl: () => {
    child = spawn(process.execPath, ['-e', "const { spawn } = require('node:child_process'); const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.send({ pid: worker.pid }); setInterval(() => {}, 1000);"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    return child;
  } });
  context.after(async () => { await bridge.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const controller = new AbortController();
  const task = { id: 'task', backend: 'copilot', worktree: dataDir, sessionId: 'session', objective: 'Check', model: 'test', context: 'default' };
  const pending = bridge.dispatch(task, {}, () => {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  const [{ pid: descendantPid }] = await once(child, 'message');
  assert.equal(Number.isInteger(descendantPid), true);
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  if (process.platform === 'win32') assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  else process.kill(descendantPid);
});

test('read-only Agency launch exposes only curated MCP reads and rejects changed consent', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-agency-read-'));
  const env = { AGENCY_CLI: 'agency-test', AGENCY_WORK_DATA_ACCESS: 'read-only', COPILOT_ALLOW_ALL: 'true' };
  const task = { id: 'read-task', sessionId: 'read-session', readOnly: true, backend: 'agency', dataDir, objective: 'Find my project messages', model: 'test', context: 'default', agent: 'unsafe-agent' };
  const area = { repoPath: 'must-not-read', allowPublish: true, instructions: 'must-not-load' };
  try {
    assert.deepEqual(agencyReadPolicy({}).servers, ['msft-learn']);
    const prepared = await prepareAgencyRead(task, dataDir, env, async (executable, args, options) => {
      assert.equal(executable, 'agency-test');
      assert.deepEqual(args.slice(0, 6), ['config', 'set', '--local', '--no-aec', '--profile', 'voice-read-read-session']);
      assert.ok(args.includes('voice-teams: teams'));
      assert.ok(args.includes('voice-calendar: calendar'));
      assert.ok(args.includes('voice-m365-user: m365-user'));
      assert.equal(options.timeout, 30000);
      assert.equal(options.env.COPILOT_ALLOW_ALL, '0');
      assert.equal(options.cwd, path.join(realpathSync.native(dataDir), 'agency-read', task.id));
    });
    assert.equal(existsSync(path.join(dataDir, 'worktrees')), false);
    assert.equal(Object.hasOwn(prepared, 'worktree'), false);
    Object.assign(task, prepared);
    for (const resume of [false, true]) {
      const launch = sessionLaunch(task, area, env, { resume });
      assert.equal(launch.directory, prepared.directory);
      assert.equal(launch.env.COPILOT_ALLOW_ALL, '0');
      assert.equal(launch.args[launch.args.indexOf('--reasoning-effort') + 1], 'low');
      for (const flag of ['--allow-all-tools', '--hub', '--agent', '--add-dir']) assert.equal(launch.args.includes(flag), false, flag);
      assert.ok(launch.args.includes('--profile-only'));
      assert.ok(launch.args.includes('--no-config-plugins'));
      assert.ok(launch.args.includes('--deny-tool=shell,write,read,url'));
      assert.equal(launch.args.includes('--additional-mcp-config'), false);
      const policy = agencyReadPolicy(env);
      assert.deepEqual(Object.keys(policy.tools), ['voice-msft-learn', 'voice-workiq', 'voice-teams', 'voice-calendar', 'voice-m365-user']);
      assert.deepEqual(policy.tools['voice-workiq'], ['retrieve', 'fetch', 'search_paths', 'get_schema']);
      assert.ok(policy.tools['voice-teams'].includes('ListChatMessages'));
      assert.ok(policy.tools['voice-m365-user'].includes('GetMyDetails'));
      const available = launch.args.find(arg => arg.startsWith('--available-tools=')).slice('--available-tools='.length).split(',');
      const allowed = launch.args.find(arg => arg.startsWith('--allow-tool=')).slice('--allow-tool='.length).split(',');
      for (const [server, tools] of Object.entries(policy.tools)) {
        assert.ok(tools.every(tool => !/^(Send|Create|Delete|Update|Add|Reply)|\*/.test(tool)));
        assert.ok(tools.every(tool => available.includes(`${server}-${tool}`) && allowed.includes(`${server}(${tool})`)));
      }
      assert.ok(available.includes('task_complete'));
      assert.ok(available.every(tool => tool === 'task_complete' || tool.startsWith('voice-')));
      assert.equal(launch.args[launch.args.indexOf('--max-autopilot-continues') + 1], '1');
      assert.doesNotMatch(launch.prompt, /must-not-load|may commit/);
      assert.match(launch.prompt, /five pages per source/);
    }
    assert.throws(() => sessionLaunch(task, area, { ...env, AGENCY_WORK_DATA_ACCESS: 'disabled' }), /access changed/);
    assert.throws(() => agencyReadPolicy({ AGENCY_WORK_DATA_ACCESS: 'all' }), /Invalid Agency/);
    await assert.rejects(prepareAgencyRead({ ...task, id: '../escape' }, dataDir, env), /Invalid read-only task/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Agency read deadlines distinguish active reads, inactivity and the hard limit without exposing content', async context => {
  for (const scenario of ['active', 'idle', 'hard', 'cancel']) await context.test(scenario, async context => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-read-deadline-'));
    context.after(() => rmSync(dataDir, { recursive: true, force: true }));
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const reports = [];
    const controller = new AbortController();
    const task = { id: 'task', readOnly: true, backend: 'agency', directory: dataDir, agencyProfile: 'read', agencyReadPolicy: 'disabled-v1', sessionId: 'session', objective: 'Read docs', model: 'test', context: 'default' };
    const bridge = createVSCodeBridge(dataDir, {}, { spawnImpl: () => child });
    const pending = bridge.dispatch(task, {}, event => reports.push(event), { signal: controller.signal });
    await Promise.resolve();
    const emit = (type, data) => child.stdout.write(`${JSON.stringify({ type, data })}\n`);
    if (scenario === 'active') {
      context.mock.timers.tick(120000);
      emit('tool.execution_start', { toolName: 'voice-msft-learn-microsoft_docs_search', arguments: 'PRIVATE QUESTION' });
      context.mock.timers.tick(120000);
      emit('tool.execution_complete', { success: false, output: 'PRIVATE CONTENT' });
      context.mock.timers.tick(120000);
      emit('session.task_complete', { summary: 'Public answer.' });
      child.stdout.write(`${JSON.stringify({ type: 'result', sessionId: 'session', exitCode: 0 })}\n`);
      child.emit('close', 0, null);
      assert.equal((await pending).result, 'Public answer.');
      assert.match(JSON.stringify(reports), /Microsoft Learn.*read 1/);
      assert.match(JSON.stringify(reports), /Source read failed/);
      assert.doesNotMatch(JSON.stringify(reports), /PRIVATE/);
    } else {
      if (scenario === 'idle') context.mock.timers.tick(180000);
      if (scenario === 'hard') for (let step = 0; step < 6; step++) {
        emit('tool.execution_complete', { success: true });
        context.mock.timers.tick(100000);
      }
      if (scenario === 'cancel') controller.abort();
      child.emit('close', null, 'SIGTERM');
      await assert.rejects(pending, scenario === 'idle' ? /No Agency progress for 3 minutes/ : scenario === 'hard' ? /10-minute read limit/ : { name: 'AbortError' });
    }
  });
});