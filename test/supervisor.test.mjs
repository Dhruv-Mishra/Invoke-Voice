import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

test('persists automatic work area selection and preserves user choices', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-default-'));
  const bridge = { verifyRepo: async () => {} };
  try {
    const supervisor = new Supervisor({ dataDir, bridge });
    const managed = supervisor.resolveArea();
    const first = await supervisor.registerArea({ name: 'First', repoPath: dataDir });
    const second = await supervisor.registerArea({ name: 'Second', repoPath: dataDir });
    assert.equal(supervisor.resolveArea().id, managed.id);
    supervisor.deleteArea(managed.id);
    assert.equal(supervisor.resolveArea().id, first.id);
    assert.equal(JSON.parse(readFileSync(supervisor.file, 'utf8')).settings.defaultAreaId, first.id);
    supervisor.updateSettings({ defaultAreaId: second.id, copilotModel: 'custom-model', defaultBackend: 'agency' });
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal(restored.resolveArea().id, second.id);
    assert.equal(restored.snapshot().settings.copilotModel, 'custom-model');
    assert.equal(restored.snapshot().settings.defaultBackend, 'agency');
    assert.throws(() => restored.resolveArea('missing'), /Choose a work area/);
    assert.throws(() => restored.updateSettings({ defaultAreaId: 'missing' }), /Unknown default work area/);
    restored.deleteArea(second.id);
    assert.equal(restored.resolveArea().id, first.id);
    assert.equal(JSON.parse(readFileSync(restored.file, 'utf8')).settings.defaultAreaId, first.id);
    restored.deleteArea(first.id);
    const replacement = restored.resolveArea();
    assert.equal(replacement.repoPath, managed.repoPath);
    assert.equal(replacement.allowPublish, false);
    assert.equal(restored.snapshot().areas.length, 1);
    assert.equal(new Supervisor({ dataDir, bridge }).resolveArea().id, replacement.id);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('fresh installs persist an editable private workspace and omitted work options resolve', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-bootstrap-'));
  let invocation;
  let dispatched;
  const bridge = {
    verifyRepo: async () => {},
    prepare: async (task, area) => { dispatched = { task, area }; return { worktree: area.repoPath, branch: 'voice/test' }; },
    dispatch: async () => ({ result: 'Test only' }),
    invokeVSCode: async request => { invocation = request; },
  };
  try {
    const supervisor = new Supervisor({ dataDir, bridge, env: {} });
    const area = supervisor.resolveArea();
    assert.equal(area.name, 'My Workspace');
    assert.equal(area.repoPath, path.join(realpathSync.native(dataDir), 'workspace'));
    assert.notEqual(area.repoPath, process.cwd());
    assert.ok(existsSync(area.repoPath));
    assert.equal(existsSync(path.join(area.repoPath, '.git')), false);
    assert.deepEqual({ agent: area.agent, baseRef: area.baseRef, instructions: area.instructions, allowPublish: area.allowPublish }, { agent: 'agent', baseRef: 'HEAD', instructions: '', allowPublish: false });
    assert.equal(new Supervisor({ dataDir, bridge }).resolveArea().id, area.id);
    assert.equal((await supervisor.callTool('list_work')).defaultAreaId, area.id);
    await supervisor.callTool('invoke_vscode', { prompt: 'Test note' }, { requestId: 'default-note' });
    assert.equal(invocation.directory, area.repoPath);
    const receipt = await supervisor.callTool('start_work', { objective: 'Test dispatch' }, { requestId: 'default-work' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(supervisor.status(receipt.taskId).state, 'result_ready');
    assert.equal(dispatched.area.id, area.id);
    assert.equal(dispatched.area.allowPublish, false);
    assert.equal(dispatched.task.backend, 'copilot');
    assert.equal(dispatched.task.context, 'default');
    assert.equal(dispatched.task.agent, 'agent');
    assert.throws(() => supervisor.deleteArea(area.id), /Delete this area's tasks first/);
    await supervisor.registerArea({ ...area, name: 'Personal workspace', agent: 'builder', baseRef: 'main', instructions: 'Keep changes local.' });
    supervisor.updateSettings({ defaultAreaId: null, copilotModel: 'chosen-model', copilotContext: 'long_context' });
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal(restored.resolveArea().name, 'Personal workspace');
    assert.equal(restored.resolveArea().agent, 'builder');
    assert.equal(restored.resolveArea().baseRef, 'main');
    assert.equal(restored.resolveArea().instructions, 'Keep changes local.');
    assert.equal(restored.snapshot().settings.copilotModel, 'chosen-model');
    assert.equal(restored.snapshot().settings.copilotContext, 'long_context');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('repairs missing and stale defaults in existing saved work areas', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-upgrade-'));
  const area = { id: 'existing', name: 'Existing', aliases: [], repoPath: dataDir, agent: 'agent', baseRef: 'HEAD', instructions: '', allowPublish: false };
  try {
    for (const settings of [{}, { defaultAreaId: null }, { defaultAreaId: 'deleted' }]) {
      writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ areas: [area], tasks: [], settings }));
      const supervisor = new Supervisor({ dataDir, bridge: {} });
      assert.equal(supervisor.resolveArea().id, area.id);
      assert.deepEqual(supervisor.snapshot().areas, [area]);
      assert.equal(existsSync(path.join(dataDir, 'workspace')), false);
      assert.equal(JSON.parse(readFileSync(supervisor.file, 'utf8')).settings.defaultAreaId, area.id);
    }
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