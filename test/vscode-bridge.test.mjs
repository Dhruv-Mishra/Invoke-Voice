import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { copilotPrompt, createVSCodeBridge, sessionEventText, sessionLaunch, worktreeWindowArgs } from '../src/vscode-bridge.mjs';
import { Supervisor } from '../src/supervisor.mjs';

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
  assert.equal(sessionEventText({ type: 'session.task_complete', data: { summary: 'Agency done' } }), 'Agency done');
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
  assert.match(copilotPrompt({ ...task, turns: [{ createdAt: Date.parse('2026-09-19T12:00:00Z') }] }, area), /2026-09-19T12:00:00.000Z/);
});

test('builds explicit Copilot and Agency start and resume commands', () => {
  const base = { dataDir: 'C:\\data', worktree: 'C:\\worktree', model: 'gpt-5.6-sol', context: 'default', sessionId: '11111111-1111-4111-8111-111111111111', agent: 'builder' };
  const area = { allowPublish: false, instructions: '' };
  const copilot = sessionLaunch({ ...base, backend: 'copilot' }, area, { COPILOT_CLI: 'copilot-test', COPILOT_REASONING: 'low' });
  assert.equal(copilot.executable, 'copilot-test');
  assert.deepEqual(copilot.args.slice(-4), ['--session-id', base.sessionId, '--agent', 'builder']);
  const agency = sessionLaunch({ ...base, backend: 'agency' }, area, { AGENCY_CLI: 'agency-test' }, { resume: true });
  assert.equal(agency.executable, 'agency-test');
  assert.deepEqual(agency.args.slice(0, 5), ['copilot', '--hub', '--no-default-mcps', '--mcp', 'msft-learn']);
  assert.equal(copilot.args.includes('--mcp'), false);
  assert.equal(agency.args.includes('teams'), false);
  assert.ok(agency.args.includes(`--resume=${base.sessionId}`));
  assert.equal(agency.args.includes('--session-id'), false);
});