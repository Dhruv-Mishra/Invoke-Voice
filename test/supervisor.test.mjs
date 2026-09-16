import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor, tools } from '../src/supervisor.mjs';

test('exports the canonical LLM tool schemas', () => {
  assert.deepEqual(tools.map(tool => tool.function.name), ['list_work', 'start_work', 'get_work_status', 'open_work', 'delete_work', 'invoke_vscode']);
  assert.equal(tools.find(tool => tool.function.name === 'start_work').function.parameters.properties.context.enum.includes('long_context'), true);
  assert.deepEqual(tools.find(tool => tool.function.name === 'start_work').function.parameters.required, ['objective']);
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
    mkdirSync(path.join(dataDir, '.github', 'agents'), { recursive: true });
    writeFileSync(path.join(dataDir, '.github', 'agents', 'builder.agent.md'), '---\nname: Builder\nmodel: "GPT-5.6 Luna (copilot)"\n---\n');
    const area = await supervisor.registerArea({ name: 'PDF', repoPath: dataDir, agent: 'builder', instructions: 'Keep compatibility.' });
    assert.deepEqual(supervisor.listAgents(area.id).at(-1), { id: 'builder', name: 'Builder', model: 'GPT-5.6 Luna (copilot)' });
    supervisor.updateSettings({ defaultAreaId: area.id, copilotContext: 'default' });
    const args = { objective: 'Add encryption tests' };
    const receipt = await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, 1);
    const status = await supervisor.callTool('get_work_status', { taskId: receipt.taskId });
    assert.equal(status.state, 'result_ready');
    assert.equal(status.result, 'Checks passed');
    assert.equal(status.model, 'test-model');
    assert.equal(status.agent, 'builder');
    assert.equal(status.context, 'default');
    assert.equal(status.update.summary, 'Checks passed');
    const listedTask = (await supervisor.callTool('list_work')).tasks[0];
    assert.equal(Object.hasOwn(listedTask, 'result'), false);
    await supervisor.callTool('invoke_vscode', { prompt: 'Draft a fix', model: 'gpt-5.4', context: 'default' }, { requestId: 'vscode-1' });
    assert.equal(vscodeRequest.directory, dataDir);
    assert.equal(vscodeRequest.prompt, 'Draft a fix');
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal(restored.snapshot().tasks.length, 1);
    assert.equal(restored.snapshot().settings.defaultAreaId, area.id);
    assert.equal(dispatches, 1);
    assert.deepEqual(await restored.callTool('delete_work', { taskId: receipt.taskId }), { deleted: 'task', id: receipt.taskId });
    assert.deepEqual(await restored.callTool('delete_work', { areaId: area.id }), { deleted: 'area', id: area.id });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('announces completed and failed work', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-notify-'));
  let shouldFail = false;
  const bridge = {
    verifyRepo: async () => {},
    prepare: async () => ({ worktree: dataDir, branch: 'voice/test' }),
    dispatch: async () => {
      if (shouldFail) throw new Error('Agent unavailable');
      return { result: 'Done' };
    },
    open: async () => {},
  };
  try {
    const supervisor = new Supervisor({ dataDir, bridge });
    const notifications = [];
    supervisor.on('notification', event => notifications.push(event));
    const area = await supervisor.registerArea({ name: 'Notify', repoPath: dataDir });
    await supervisor.callTool('start_work', { areaId: area.id, objective: 'Succeed' }, { requestId: 'notify-success' });
    await new Promise(resolve => setImmediate(resolve));
    shouldFail = true;
    await supervisor.callTool('start_work', { areaId: area.id, objective: 'Fail' }, { requestId: 'notify-failure' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(notifications.map(event => event.state), ['result_ready', 'agent_failed']);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});