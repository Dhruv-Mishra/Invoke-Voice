import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor, tools } from '../src/supervisor.mjs';

test('exports the canonical LLM tool schemas', () => {
  assert.deepEqual(tools.map(tool => tool.function.name), ['list_work', 'start_work', 'get_work_status', 'open_work', 'invoke_vscode']);
  assert.equal(tools.find(tool => tool.function.name === 'start_work').function.parameters.properties.context.enum.includes('long_context'), true);
});

test('Copilot dispatch is idempotent, records progress, and exposes passive status', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-test-'));
  let dispatches = 0;
  let vscodeRequest;
  const bridge = {
    verifyRepo: async () => {},
    prepare: async () => ({ worktree: dataDir, branch: 'voice/test' }),
    dispatch: async (task, area, report) => {
      dispatches += 1;
      report({ kind: 'progress', summary: 'Running tests.' });
      return { result: 'Checks passed', sessionLog: path.join(dataDir, `${task.id}.jsonl`) };
    },
    invokeVSCode: async request => { vscodeRequest = request; return { invoked: true }; },
    open: async () => {},
  };
  try {
    let clock = Date.now();
    const supervisor = new Supervisor({ dataDir, bridge, now: () => clock, env: { COPILOT_MODEL: 'test-model' } });
    assert.equal((await supervisor.callTool('list_work')).tasks.length, 0);
    await assert.rejects(supervisor.callTool('start_work', { areaId: 'missing', objective: 'fix' }, { requestId: 'test' }));
    const area = await supervisor.registerArea({ name: 'PDF', repoPath: dataDir });
    const args = { areaId: area.id, objective: 'Add encryption tests' };
    const receipt = await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, 1);
    const status = await supervisor.callTool('get_work_status', { taskId: receipt.taskId });
    assert.equal(status.state, 'result_ready');
    assert.equal(status.result, 'Checks passed');
    assert.equal(status.model, 'test-model');
    assert.equal(status.context, 'long_context');
    assert.equal(status.observations.at(-2).summary, 'Running tests.');
    await supervisor.callTool('invoke_vscode', { areaId: area.id, prompt: 'Draft a fix', model: 'gpt-5.4', context: 'default' }, { requestId: 'vscode-1' });
    assert.equal(vscodeRequest.directory, dataDir);
    assert.equal(vscodeRequest.prompt, 'Draft a fix');
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal(restored.snapshot().tasks.length, 1);
    assert.equal(dispatches, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});