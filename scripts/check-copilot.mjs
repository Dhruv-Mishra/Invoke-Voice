import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVSCodeBridge } from '../src/vscode-bridge.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createAgencyMcp } from '../src/agency-mcp.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-copilot-'));
const backend = process.argv.includes('--agency') ? 'agency' : 'copilot';
const agencyMcp = backend === 'agency' ? createAgencyMcp() : undefined;
let supervisor;
const repo = path.join(root, 'repo');
const dataDir = path.join(root, 'state');
const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });

try {
  execFileSync('git', ['init', repo], { stdio: 'ignore', windowsHide: true });
  git(['config', 'user.name', 'Voice Supervisor Check']);
  git(['config', 'user.email', 'voice-supervisor@example.invalid']);
  writeFileSync(path.join(repo, 'README.md'), '# Isolated check\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'check fixture']);

  await agencyMcp?.start();
  supervisor = new Supervisor({ dataDir, bridge: createVSCodeBridge(dataDir, process.env, { agencyMcp }) });
  const area = await supervisor.registerArea({ name: 'Check', repoPath: repo });
  const completed = once(supervisor, 'notification', { signal: AbortSignal.timeout(120000) });
  const receipt = await supervisor.callTool('start_work', {
    areaId: area.id,
    objective: 'Read README.md. Do not modify files. Reply with exactly SUPERVISOR_READY.',
    backend,
    model: process.env.COPILOT_MODEL || 'gpt-5.6-sol',
    context: process.env.COPILOT_CONTEXT || 'default',
  }, { requestId: `check-${Date.now()}` });

  const sessionId = supervisor.status(receipt.taskId).sessionId;
  const followUp = await supervisor.callTool('send_work_message', {
    taskId: receipt.taskId,
    message: 'When the previous task finishes, if its actual result contains SUPERVISOR_READY, reply exactly THREAD_RESUMED; otherwise reply CHECK_FAILED. Do not modify files or query remote data.',
  }, { requestId: `resume-${Date.now()}` });
  assert.equal(followUp.state, 'queued');
  const [initial] = await completed;
  assert.equal(initial.state, 'result_ready', initial.text);
  assert.match(initial.text, /SUPERVISOR_READY/);
  const [resumed] = await once(supervisor, 'notification', { signal: AbortSignal.timeout(120000) });
  assert.equal(resumed.state, 'result_ready', resumed.text);
  assert.match(resumed.text, /THREAD_RESUMED/);
  if (supervisor.status(receipt.taskId).sessionId !== sessionId) throw new Error(`${backend} resume changed session ID`);
  console.log(`${backend} supervisor check: conditional queue passed in the original session (${resumed.text}).`);
  console.log(`Task: ${receipt.taskId}`);
  console.log(`Session: ${sessionId}`);
} finally {
  await supervisor?.close();
  await agencyMcp?.close();
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore', windowsHide: true }); } catch {}
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
}