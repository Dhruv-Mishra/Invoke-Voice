import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor, tools, supervisorTools, supervisorInstructions } from '../src/supervisor.mjs';
import { createLocalTaskSearch, SemanticTaskIndex } from '../src/supervisor/semantic-search.mjs';
import { assetReady, stackPaths, TASK_SEARCH_ASSETS } from '../scripts/models.mjs';
import { tools as contractTools, supervisorTools as contractSupervisorTools, supervisorInstructions as contractSupervisorInstructions } from '../src/supervisor/contract.mjs';

test('exports the canonical LLM tool schemas', () => {
  assert.equal(tools, supervisorTools);
  assert.equal(tools, contractTools);
  assert.equal(supervisorTools, contractSupervisorTools);
  assert.equal(supervisorInstructions, contractSupervisorInstructions);
  assert.deepEqual(tools.map(tool => tool.function.name), ['list_work', 'start_work', 'send_work_message', 'get_work_status', 'open_work', 'delete_work', 'invoke_vscode']);
  assert.equal(Object.hasOwn(tools[0].function.parameters, 'required'), false);
  assert.equal(tools[0].function.parameters.properties.query.type, 'string');
  assert.ok(supervisorInstructions.length < 1350);
  assert.ok(JSON.stringify(tools).length + supervisorInstructions.length < 4200);
  assert.deepEqual(tools.find(tool => tool.function.name === 'start_work').function.parameters.properties.backend.enum, ['copilot', 'agency']);
  assert.equal(tools.find(tool => tool.function.name === 'start_work').function.parameters.properties.context.enum.includes('long_context'), true);
  assert.deepEqual(tools.find(tool => tool.function.name === 'start_work').function.parameters.required, ['objective']);
  assert.equal(tools.find(tool => tool.function.name === 'start_work').function.parameters.properties.readOnly.type, 'boolean');
  assert.match(supervisorInstructions, /readOnly:true for external questions/);
});

test('notification inbox persists simultaneous completions and marks only observed IDs read', context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-inbox-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = new Supervisor({ dataDir, bridge: {}, now: () => 1000 });
  const events = [];
  supervisor.on('notification', event => events.push(event));
  for (const id of ['first', 'second']) {
    const task = { id, title: id, backend: 'copilot', observations: [], turns: [] };
    supervisor.state.tasks.push(task);
    supervisor.completeTask(task, { result: `${id} finished` });
  }
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  supervisor.readNotifications({ ids: [events[0].id] });
  const restored = new Supervisor({ dataDir, bridge: {} });
  assert.deepEqual(restored.snapshot().notifications.map(item => item.read), [true, false]);
  assert.throws(() => restored.readNotifications({ ids: 'all' }), /Invalid/);
  for (let index = 0; index < 102; index++) restored.publishNotification({ id: 'task', title: 'Task', state: 'result_ready' }, 'Done');
  assert.equal(restored.snapshot().notifications.length, 100);
});

test('idle call settings default on and validate atomically', context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-idle-settings-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = new Supervisor({ dataDir, bridge: {} });
  assert.equal(supervisor.state.settings.autoEndCall, true);
  assert.equal(supervisor.state.settings.idleWarningSeconds, 40);
  assert.equal(supervisor.state.settings.idleEndSeconds, 60);
  for (const input of [{ idleEndSeconds: 30 }, { idleWarningSeconds: 0 }, { idleEndSeconds: '90' }, { idleEndSeconds: 9000 }]) assert.throws(() => supervisor.updateSettings(input), /Idle/);
  assert.equal(supervisor.state.settings.idleEndSeconds, 60);
  supervisor.updateSettings({ autoEndCall: false, idleWarningSeconds: 50, idleEndSeconds: 90 });
  const restored = new Supervisor({ dataDir, bridge: {} });
  assert.equal(restored.state.settings.autoEndCall, false);
  assert.equal(restored.state.settings.idleEndSeconds, 90);
});

test('searches all saved work with bounded fresh status and no mutations', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-search-'));
  const clock = Date.now();
  try {
    const supervisor = new Supervisor({ dataDir, bridge: {}, now: () => clock, env: { SUPERVISOR_CACHE_DIR: dataDir } });
    const areaId = supervisor.resolveArea().id;
    const addTask = (id, title, extra = {}) => supervisor.state.tasks.push({
      id, title, objective: title, areaId, state: 'result_ready', createdAt: clock,
      observations: [], turns: [], ...extra,
    });
    addTask('document', 'Draft onboarding document', { result: 'Draft ready for review.', sessionLog: 'private.log', worktree: 'private/path' });
    for (let index = 0; index < 30; index += 1) addTask(`other-${index}`, `Fix compiler ${index}`);
    assert.equal((await supervisor.callTool('list_work')).tasks.some(task => task.id === 'document'), false);
    const before = JSON.stringify(supervisor.state);
    const found = await supervisor.callTool('list_work', { query: "What's the status of the document work?" });
    assert.equal(found.hasMore, false);
    assert.equal(found.tasks.length, 1);
    assert.equal(found.tasks[0].taskId, 'document');
    assert.equal(found.tasks[0].result, 'Draft ready for review.');
    assert.ok(found.tasks[0].actions.includes('send_work_message'));
    assert.equal(Object.hasOwn(found.tasks[0], 'sessionLog'), false);
    assert.equal(Object.hasOwn(found.tasks[0], 'worktree'), false);
    assert.equal(JSON.stringify(supervisor.state), before);
    assert.equal((await supervisor.callTool('list_work', { query: 'documant' })).tasks[0].taskId, 'document');
    assert.deepEqual(await supervisor.callTool('list_work', { query: 'invoice document' }), { tasks: [], hasMore: false });
    assert.deepEqual(await supervisor.callTool('list_work', { query: 'the work' }), { tasks: [], hasMore: false });
    addTask('other-document', 'Review policy document', { state: 'running', lastObservedAt: clock - 180000 });
    const ambiguous = await supervisor.callTool('list_work', { query: 'document' });
    assert.equal(ambiguous.tasks.length, 2);
    assert.equal(ambiguous.tasks.find(task => task.taskId === 'other-document').state, 'unknown');
    assert.equal(ambiguous.tasks.find(task => task.taskId === 'other-document').stale, true);
    assert.equal((await supervisor.callTool('list_work', { query: 'onboarding document' })).tasks.length, 1);
    addTask('follow-up', 'Prepare release', { turns: [{ message: 'Include the migration checklist', createdAt: clock }] });
    assert.equal((await supervisor.callTool('list_work', { query: 'migration checklist' })).tasks[0].taskId, 'follow-up');
    const limited = await supervisor.callTool('list_work', { query: 'compiler' });
    assert.equal(limited.tasks.length, 3);
    assert.equal(limited.hasMore, true);
    for (const query of ['', ' ', null, 123, 'x'.repeat(201)]) await assert.rejects(supervisor.callTool('list_work', { query }), /Invalid task query/);
    supervisor.save();
    const restored = new Supervisor({ dataDir, bridge: {}, env: { SUPERVISOR_CACHE_DIR: dataDir } });
    assert.equal((await restored.callTool('list_work', { query: 'onboarding' })).tasks[0].taskId, 'document');
    supervisor.deleteTask('document');
    assert.deepEqual(await supervisor.callTool('list_work', { query: 'onboarding' }), { tasks: [], hasMore: false });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('task search awaits semantic results, reads fresh state and survives unavailable embeddings', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-semantic-tool-'));
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  try {
    const supervisor = new Supervisor({ dataDir, bridge: {}, semanticSearch: async (query, documents, lexical) => {
      entered({ query, documents, lexical });
      await waiting;
      return [{ id: 'guide' }, { id: 'removed' }];
    } });
    supervisor.state.tasks = ['guide', 'removed'].map(id => ({ id, title: 'Write onboarding handbook', state: 'running', createdAt: Date.now(), observations: [], turns: [] }));
    const pending = supervisor.callTool('list_work', { query: "What's the status of the document work?" });
    const request = await started;
    assert.equal(request.query, 'document');
    assert.equal(request.documents.length, 2);
    assert.deepEqual(request.lexical, []);
    supervisor.state.tasks.pop();
    supervisor.state.tasks[0].state = 'result_ready';
    supervisor.state.tasks[0].result = 'Handbook ready for review.';
    release();
    const result = await pending;
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].state, 'result_ready');
    assert.equal(result.tasks[0].result, 'Handbook ready for review.');
    supervisor.semanticSearch = async () => { throw new Error('Unavailable'); };
    assert.equal((await supervisor.callTool('list_work', { query: 'handbook' })).tasks[0].taskId, 'guide');
    assert.deepEqual(await supervisor.callTool('list_work', { query: 'the work' }), { tasks: [], hasMore: false });
  } finally { release(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('unprovisioned semantic search stays offline and preserves keyword results', async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-semantic-offline-'));
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('Unexpected network request'); });
  try {
    const search = createLocalTaskSearch({ dataDir, env: { SUPERVISOR_CACHE_DIR: dataDir } });
    const lexical = [{ id: 'guide', score: 1 }];
    assert.equal(await search('handbook', [{ id: 'guide', text: 'Write a guide' }], lexical), lexical);
    assert.equal(requests, 0);
    assert.equal(existsSync(path.join(dataDir, 'task-search-vectors.json')), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('installed MiniLM matches paraphrases offline without loading the voice LLM', { skip: process.env.TEST_TASK_EMBEDDINGS !== '1' }, async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-semantic-live-'));
  const paths = stackPaths();
  assert.ok(TASK_SEARCH_ASSETS.every(asset => assetReady(paths, asset)), 'Provision with npm run models -- task-search first');
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('Embedding inference must stay offline'); });
  try {
    const supervisor = new Supervisor({ dataDir, bridge: {} });
    supervisor.state.tasks = [
      ['guide', 'Write the onboarding guide for new employees'],
      ['login', 'Repair the sign-in page and password reset flow'],
      ['theme', 'Fix the dark theme colors in the settings panel'],
    ].map(([id, title]) => ({ id, title, objective: title, state: 'result_ready', createdAt: Date.now(), observations: [], turns: [] }));
    const first = await supervisor.callTool('list_work', { query: 'new employee handbook' });
    assert.equal(first.tasks[0]?.taskId, 'guide');
    const start = performance.now();
    const second = await supervisor.callTool('list_work', { query: 'authentication bug' });
    context.diagnostic(`Warm synthetic semantic lookup: ${Math.round(performance.now() - start)}ms`);
    assert.equal(second.tasks[0]?.taskId, 'login');
    assert.deepEqual(await supervisor.callTool('list_work', { query: 'lunch reservation' }), { tasks: [], hasMore: false });
    supervisor.state.tasks[0].result = 'Handbook ready for review.';
    assert.equal((await supervisor.callTool('list_work', { query: 'new employee handbook' })).tasks[0].result, 'Handbook ready for review.');
    assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'task-search-vectors.json'), 'utf8')).vectors.length, 3);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('semantic task ranking caches vectors, refreshes changes and removes deleted tasks', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-semantic-search-'));
  const cacheFile = path.join(dataDir, 'search.json');
  const calls = [];
  const vectors = { 'document work': [1, 0, 0], 'Write onboarding guide': [0.9, 0.1, 0], 'Fix sign-in': [0, 1, 0], 'Prepare policy handbook': [0.8, 0.2, 0], 'Buy equipment': [0, 0, 1] };
  const embed = async texts => { calls.push(texts); return texts.map(text => vectors[text]); };
  const documents = [{ id: 'guide', text: 'Write onboarding guide' }, { id: 'login', text: 'Fix sign-in' }];
  try {
    const index = new SemanticTaskIndex({ embed, cacheFile, modelKey: 'fixture-1', dimensions: 3 });
    const results = await Promise.all([index.search('document work', documents, []), index.search('document work', documents, [])]);
    assert.deepEqual(results.map(matches => matches.map(match => match.id)), [['guide'], ['guide']]);
    assert.deepEqual(calls, [['Write onboarding guide', 'Fix sign-in'], ['document work']]);
    assert.equal(readFileSync(cacheFile, 'utf8').includes('Write onboarding guide'), false);
    documents[1].text = 'Prepare policy handbook';
    assert.deepEqual((await index.search('document work', documents, [])).map(match => match.id), ['guide', 'login']);
    assert.deepEqual(calls.at(-1), ['Prepare policy handbook']);
    documents.shift();
    assert.deepEqual((await index.search('document work', documents, [])).map(match => match.id), ['login']);
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).vectors.length, 1);
    const restored = new SemanticTaskIndex({ embed, cacheFile, modelKey: 'fixture-1', dimensions: 3 });
    const beforeRestore = calls.length;
    await restored.search('document work', documents, []);
    assert.deepEqual(calls.slice(beforeRestore), [['document work']]);
    assert.deepEqual(await restored.search('Buy equipment', documents, []), []);
    assert.equal((await restored.search('Buy equipment', documents, [{ id: 'login' }]))[0].id, 'login');
    const changedModel = new SemanticTaskIndex({ embed, cacheFile, modelKey: 'fixture-2', dimensions: 3 });
    await changedModel.search('document work', documents, []);
    assert.deepEqual(calls.at(-2), ['Prepare policy handbook']);
    const invalid = new SemanticTaskIndex({ embed: async () => [[NaN]], cacheFile, modelKey: 'invalid', dimensions: 3 });
    await assert.rejects(invalid.search('document work', documents, []), /Invalid task embedding/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
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
    assert.equal(supervisor.snapshot().settings.defaultBackend, 'agency');
    const managed = supervisor.resolveArea();
    const first = await supervisor.registerArea({ name: 'First', repoPath: dataDir });
    const second = await supervisor.registerArea({ name: 'Second', repoPath: dataDir });
    assert.equal(supervisor.resolveArea().id, managed.id);
    supervisor.deleteArea(managed.id);
    assert.equal(supervisor.resolveArea().id, first.id);
    assert.equal(JSON.parse(readFileSync(supervisor.file, 'utf8')).settings.defaultAreaId, first.id);
    supervisor.updateSettings({ defaultAreaId: second.id, copilotModel: 'custom-model', defaultBackend: 'copilot' });
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal(restored.resolveArea().id, second.id);
    assert.equal(restored.snapshot().settings.copilotModel, 'custom-model');
    assert.equal(restored.snapshot().settings.defaultBackend, 'copilot');
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
    assert.equal(dispatched.task.backend, 'agency');
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

test('settling tasks cannot be deleted and late worker logs cannot corrupt a follow-up', async context => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-task-races-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let reportOld;
  let reportNew;
  let finishFirst;
  let finishNext;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const next = new Promise(resolve => { finishNext = resolve; });
  const supervisor = new Supervisor({ dataDir, bridge: {
    prepare: async () => ({}),
    dispatch: async (_task, _area, report) => { reportOld = report; return first; },
    continue: async (_task, _area, _prompt, report) => { reportNew = report; return next; },
  } });
  const receipt = await supervisor.callTool('start_work', { objective: 'Run checks' }, { requestId: 'race-first' });
  await new Promise(setImmediate);
  reportOld({ kind: 'result_ready', summary: 'Finishing' });
  assert.equal(supervisor.status(receipt.taskId).deletable, false);
  assert.equal(supervisor.toolStatus(receipt.taskId).actions.includes('send_work_message'), false);
  assert.throws(() => supervisor.deleteTask(receipt.taskId), /Only finished/);
  finishFirst({ result: 'First done' });
  await new Promise(setImmediate);
  assert.equal(supervisor.status(receipt.taskId).deletable, true);
  await supervisor.callTool('send_work_message', { taskId: receipt.taskId, message: 'Check again' }, { requestId: 'race-next' });
  reportNew({ kind: 'progress', summary: 'New run' });
  const before = JSON.stringify(supervisor.state);
  reportOld({ kind: 'result_ready', summary: 'Late old log' });
  assert.equal(JSON.stringify(supervisor.state), before);
  finishNext({ result: 'Next done' });
  await new Promise(setImmediate);
  reportNew({ kind: 'progress', summary: 'Late new log' });
  assert.equal(supervisor.task(receipt.taskId).observations.at(-1).summary, 'Next done');
  assert.equal(supervisor.snapshot().notifications.length, 2);
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

test('work-data questions use one regular Agency task and deliver its answer without redispatch', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-question-'));
  const objective = 'What is my latest message on the PDF group from yesterday?';
  const answer = 'I could not retrieve that message because Teams access is not configured.';
  let dispatches = 0;
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  const bridge = {
    prepare: async () => ({ worktree: dataDir, branch: 'voice/test' }),
    dispatch: async () => { dispatches += 1; return completion; },
  };
  try {
    const supervisor = new Supervisor({ dataDir, bridge });
    const notifications = [];
    supervisor.on('notification', event => notifications.push(event));
    const args = { objective };
    const context = { requestId: 'question-turn' };
    const receipt = await supervisor.callTool('start_work', args, context);
    assert.equal((await supervisor.callTool('start_work', args, context)).duplicate, true);
    assert.equal(supervisor.task(receipt.taskId).objective, objective);
    assert.equal(supervisor.task(receipt.taskId).backend, 'agency');
    release({ result: answer });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].text, answer);
    assert.equal(notifications[0].taskId, receipt.taskId);
    assert.equal((await supervisor.callTool('get_work_status', { taskId: receipt.taskId })).result, answer);
    const restored = new Supervisor({ dataDir, bridge });
    assert.equal((await restored.callTool('get_work_status', { taskId: receipt.taskId })).result, answer);
    assert.equal(dispatches, 1);
    assert.equal(supervisor.state.tasks.length, 1);
  } finally { release(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('read-only tasks preserve their execution boundary across retries and follow-ups', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-readonly-task-'));
  const executions = [];
  const bridge = {
    prepare: async () => ({}),
    dispatch: async task => { executions.push({ ...task }); return { result: 'Read complete.' }; },
    continue: async task => { executions.push({ ...task }); return { result: 'Follow-up read complete.' }; },
  };
  try {
    const supervisor = new Supervisor({ dataDir, bridge });
    supervisor.updateSettings({ defaultBackend: 'copilot' });
    const args = { objective: 'Find yesterday\'s project messages', readOnly: true };
    const context = { requestId: 'read-only-turn' };
    const receipt = await supervisor.callTool('start_work', args, context);
    assert.equal((await supervisor.callTool('start_work', args, context)).duplicate, true);
    await assert.rejects(supervisor.callTool('start_work', { ...args, backend: 'agency', readOnly: false }, context), /another task/);
    await new Promise(resolve => setImmediate(resolve));
    const restored = new Supervisor({ dataDir, bridge });
    await restored.callTool('send_work_message', { taskId: receipt.taskId, message: 'Narrow to the afternoon' }, { requestId: 'read-follow-up' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions.length, 2);
    assert.ok(executions.every(task => task.readOnly && task.backend === 'agency' && task.agent === 'agent'));
    assert.equal(executions[0].sessionId, executions[1].sessionId);
    await assert.rejects(restored.callTool('start_work', { ...args, readOnly: 'true' }, { requestId: 'invalid' }), /Invalid read-only/);
    await assert.rejects(restored.callTool('start_work', { ...args, backend: 'copilot' }, { requestId: 'wrong-backend' }), /require Agency/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('quarantines corrupt state and makes abandoned tasks recoverable after restart', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-recovery-'));
  try {
    writeFileSync(path.join(dataDir, 'state.json'), '{"tasks":');
    const recovered = new Supervisor({ dataDir, bridge: {}, now: () => 12345 });
    assert.match(recovered.snapshot().recoveryWarning, /preserved/);
    assert.equal(existsSync(path.join(dataDir, 'state.json.corrupt-12345')), true);

    const area = recovered.resolveArea();
    recovered.state.tasks.push({ id: 'abandoned', areaId: area.id, state: 'running', createdAt: 1, observations: [], turns: [] });
    recovered.save();
    const restarted = new Supervisor({ dataDir, bridge: {} });
    const status = restarted.toolStatus('abandoned');
    assert.equal(status.state, 'agent_stopped');
    assert.ok(status.actions.includes('send_work_message'));
    assert.ok(status.actions.includes('delete_work'));
    writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ areas: [null, { id: 'bad' }], tasks: [], settings: {} }));
    const sanitized = new Supervisor({ dataDir, bridge: {} });
    assert.equal(sanitized.snapshot().areas.length, 1);
    assert.doesNotThrow(() => sanitized.listAgents(sanitized.resolveArea().id));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('follow-up status uses current-turn observations after retention', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-progress-'));
  try {
    const supervisor = new Supervisor({ dataDir, bridge: {} });
    const task = {
      id: 'retained-progress', state: 'running', createdAt: 1, observations: [],
      turns: [{ requestId: 'turn', message: 'Continue', createdAt: 200, state: 'running' }],
      turnObservationStart: 150,
    };
    for (let index = 0; index < 100; index++) task.observations.push({ id: String(index), at: 201 + index, summary: `Update ${index}` });
    supervisor.state.tasks.push(task);
    assert.equal(supervisor.toolStatus(task.id).update, 'Update 99');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});