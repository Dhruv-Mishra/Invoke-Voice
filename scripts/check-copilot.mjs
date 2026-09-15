import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVSCodeBridge } from '../src/vscode-bridge.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-copilot-'));
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

  const supervisor = new Supervisor({ dataDir, bridge: createVSCodeBridge(dataDir) });
  const area = await supervisor.registerArea({ name: 'Check', repoPath: repo });
  const receipt = await supervisor.callTool('start_work', {
    areaId: area.id,
    objective: 'Read README.md. Do not modify files. Reply with exactly SUPERVISOR_READY.',
    model: process.env.COPILOT_MODEL || 'gpt-5.6-sol',
    context: process.env.COPILOT_CONTEXT || 'long_context',
  }, { requestId: `check-${Date.now()}` });

  const deadline = Date.now() + 120000;
  let status;
  while (Date.now() < deadline) {
    status = await supervisor.callTool('get_work_status', { taskId: receipt.taskId });
    if (['result_ready', 'agent_failed'].includes(status.state)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (status?.state !== 'result_ready') throw new Error(status?.error || 'Copilot supervisor check timed out');
  console.log(`Copilot supervisor check: ${status.result}`);
  console.log(`Session: ${status.sessionId}`);
} finally {
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore', windowsHide: true }); } catch {}
  rmSync(root, { recursive: true, force: true });
}