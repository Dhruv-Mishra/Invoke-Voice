import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor } from '../src/supervisor.mjs';

test('dispatch is idempotent, status is passive, and only matching host evidence binds a task', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-test-'));
  let dispatches = 0;
  const bridge = { verifyRepo: async () => {}, prepare: async () => ({ worktree: dataDir, branch: 'voice/test' }), dispatch: async () => { dispatches += 1; }, open: async () => {} };
  try {
    let clock = Date.now();
    const supervisor = new Supervisor({ dataDir, bridge, now: () => clock });
    assert.equal((await supervisor.callTool('list_work')).tasks.length, 0);
    await assert.rejects(supervisor.callTool('start_work', { areaId: 'missing', objective: 'fix' }, { requestId: 'test' }));
    const area = await supervisor.registerArea({ name: 'PDF', repoPath: dataDir });
    const args = { areaId: area.id, objective: 'Add encryption tests' };
    const receipt = await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, 1);
    clock += 31000;
    assert.equal(supervisor.status(receipt.taskId).state, 'dispatch_unconfirmed');
    const event = { id: 'event-1', taskId: receipt.taskId, cwd: dataDir, sessionId: 'actual-session', kind: 'UserPromptSubmit', prompt: 'unrelated prompt' };
    assert.equal(supervisor.observe(event), false);
    event.prompt = `[voice-task:${receipt.taskId}] Add tests`;
    assert.equal(supervisor.observe(event), true);
    assert.equal(supervisor.observe(event), false);
    assert.equal(supervisor.observe({ ...event, id: 'wrong-session', sessionId: 'other' }), false);
    clock += 121000;
    assert.equal((await supervisor.callTool('get_work_status', { taskId: receipt.taskId })).state, 'unknown');
    supervisor.observe({ ...event, id: 'event-2', kind: 'Stop' });
    assert.equal(supervisor.status(receipt.taskId).state, 'agent_stopped');
    supervisor.observe({ ...event, id: 'event-3', kind: 'result_ready', summary: 'Checks passed' });
    supervisor.observe({ ...event, id: 'event-4', kind: 'Stop' });
    assert.equal(supervisor.status(receipt.taskId).state, 'result_ready');
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal(restored.snapshot().tasks.length, 1);
    assert.equal(dispatches, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});