import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor, tools } from '../src/supervisor.mjs';

test('exports the canonical LLM tool schemas', () => {
  assert.deepEqual(tools.map(tool => tool.function.name), ['list_work', 'start_work', 'send_work_message', 'get_work_status', 'open_work', 'delete_work', 'invoke_vscode']);
  assert.equal(Object.hasOwn(tools[0].function.parameters, 'required'), false);
  assert.deepEqual(tools.find(tool => tool.function.name === 'start_work').function.parameters.properties.backend.enum, ['copilot', 'agency']);
  assert.equal(tools.find(tool => tool.function.name === 'start_work').function.parameters.properties.context.enum.includes('long_context'), true);
  assert.deepEqual(tools.find(tool => tool.function.name === 'start_work').function.parameters.required, ['objective']);
});

test('deletes stale inactive work while protecting active work', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-stale-'));
  const taskId = 'stale-task';
  const clock = Date.now();
  try {
    const supervisor = new Supervisor({ dataDir, bridge: {}, now: () => clock });
    supervisor.state.tasks.push({ id: taskId, state: 'running', createdAt: clock - 180000, lastObservedAt: clock - 180000, observations: [], turns: [] });
    supervisor.activeTasks.add(taskId);
    await assert.rejects(supervisor.callTool('delete_work', { taskId }), /Only finished or stale tasks/);
    supervisor.activeTasks.delete(taskId);
    assert.deepEqual(supervisor.toolStatus(taskId).actions, ['delete_work']);
    assert.deepEqual(await supervisor.callTool('delete_work', { taskId }), { deleted: 'task' });
    supervisor.state.tasks.push({ id: 'recent-task', state: 'dispatching', createdAt: clock - 1000, dispatchStartedAt: clock - 1000, lastObservedAt: null, observations: [], turns: [] });
    assert.equal(supervisor.status('recent-task').stale, false);
    assert.equal(supervisor.status('recent-task').deletable, false);
    await assert.rejects(supervisor.callTool('delete_work', { taskId: 'recent-task' }), /Only finished or stale tasks/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Copilot dispatch is idempotent, records progress, and exposes passive status', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-test-'));
  let dispatches = 0;
  let continuations = 0;
  let vscodeRequest;
  const bridge = {
    verifyRepo: async () => {},
    prepare: async () => ({ worktree: dataDir, branch: 'voice/test' }),
    dispatch: async (task, area, report) => {
      dispatches += 1;
      report({ kind: 'progress', summary: 'Running tests.' });
      return { result: 'Checks passed', sessionLog: path.join(dataDir, `${task.id}.jsonl`) };
    },
    continue: async (task, area, prompt, report) => {
      continuations += 1;
      report({ kind: 'progress', summary: `Following up: ${prompt}` });
      return { result: 'Follow-up passed', sessionLog: path.join(dataDir, `${task.id}.jsonl`) };
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
    const args = { objective: 'Add encryption tests', backend: 'agency' };
    const receipt = await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    assert.deepEqual(receipt, { taskId: receipt.taskId, state: 'dispatching' });
    const duplicateStart = await supervisor.callTool('start_work', args, { requestId: 'request-1' });
    assert.deepEqual(Object.keys(duplicateStart), ['taskId', 'state', 'duplicate']);
    assert.equal(duplicateStart.taskId, receipt.taskId);
    assert.equal(duplicateStart.duplicate, true);
    assert.ok(['dispatching', 'running', 'result_ready'].includes(duplicateStart.state));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, 1);
    const status = await supervisor.callTool('get_work_status', { taskId: receipt.taskId });
    assert.deepEqual(status, {
      taskId: receipt.taskId,
      state: 'result_ready',
      actions: ['send_work_message', 'open_work', 'delete_work'],
      result: 'Checks passed',
    });
    const followUp = await supervisor.callTool('send_work_message', { taskId: receipt.taskId, message: 'Now update the docs' }, { requestId: 'follow-up-1' });
    const duplicateFollowUp = await supervisor.callTool('send_work_message', { taskId: receipt.taskId, message: 'Now update the docs' }, { requestId: 'follow-up-1' });
    assert.deepEqual(Object.keys(duplicateFollowUp), ['taskId', 'state', 'duplicate']);
    assert.equal(duplicateFollowUp.taskId, receipt.taskId);
    assert.equal(duplicateFollowUp.duplicate, true);
    assert.ok(['dispatching', 'running', 'result_ready'].includes(duplicateFollowUp.state));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(followUp.state, 'dispatching');
    assert.equal(continuations, 1);
    assert.equal((await supervisor.callTool('get_work_status', { taskId: receipt.taskId })).result, 'Follow-up passed');
    const listedTask = (await supervisor.callTool('list_work')).tasks[0];
    assert.equal(Object.hasOwn(listedTask, 'result'), false);
    assert.deepEqual(await supervisor.callTool('open_work', { taskId: receipt.taskId }), { opened: true });
    assert.deepEqual(await supervisor.callTool('invoke_vscode', { prompt: 'Draft a fix', model: 'gpt-5.4', context: 'default' }, { requestId: 'vscode-1' }), { invoked: true });
    assert.equal(vscodeRequest.directory, dataDir);
    assert.equal(vscodeRequest.prompt, 'Draft a fix');
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal(restored.snapshot().tasks.length, 1);
    assert.equal(restored.snapshot().settings.defaultAreaId, area.id);
    assert.equal(dispatches, 1);
    assert.deepEqual(await restored.callTool('delete_work', { taskId: receipt.taskId }), { deleted: 'task' });
    assert.deepEqual(await restored.callTool('delete_work', { areaId: area.id }), { deleted: 'area' });
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
    const failed = await supervisor.callTool('start_work', { areaId: area.id, objective: 'Fail' }, { requestId: 'notify-failure' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(notifications.map(event => event.state), ['result_ready', 'agent_failed']);
    assert.deepEqual(await supervisor.callTool('get_work_status', { taskId: failed.taskId }), {
      taskId: failed.taskId,
      state: 'agent_failed',
      actions: ['send_work_message', 'open_work', 'delete_work'],
      error: 'Agent unavailable',
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});