import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVSCodeBridge } from '../src/vscode-bridge.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { createAgencyMcp } from '../src/agency-mcp.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'voice-agency-read-check-'));
const visibleTools = new Set();
const toolResults = new Map();
let round = 0;
let supervisor;
const agencyMcp = createAgencyMcp();
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  for (const tool of body.tools ?? []) visibleTools.add(tool.function?.name ?? tool.name);
  for (const message of body.messages ?? []) {
    if (message.role === 'tool') toolResults.set(message.tool_call_id, String(message.content));
  }
  round += 1;
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const calls = round === 1 ? [
    call('blocked-write', 'voice-teams-SendMessageToChat', {}),
    call('blocked-shell', 'powershell', { command: 'Write-Output SHELL_REACHED' }),
    call('blocked-workiq-ask', 'voice-workiq-ask', { question: 'Do not execute this synthetic call.' }),
  ] : round === 2 ? [call('public-read', 'voice-msft-learn-microsoft_docs_search', { query: 'C# String.Length property' }),
    call('workiq-schema', 'voice-workiq-search_paths', { filter: '/me/messages' })]
    : [call(`complete-${round}`, 'task_complete', { summary: round === 3 ? 'READ_CHECK_OK' : 'THREAD_RESUMED' })];
  const message = { role: 'assistant', content: null, tool_calls: calls };
  response.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (body.stream) {
    const delta = { role: 'assistant', tool_calls: calls.map((tool, index) => ({ index, ...tool })) };
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: 'tool_calls' }]) {
      response.write(`data: ${JSON.stringify({ id: `fixture-${round}`, object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, ...choice }], usage })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  } else {
    response.end(JSON.stringify({ id: `fixture-${round}`, object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message, finish_reason: 'tool_calls' }], usage }));
  }
});

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = {
    ...process.env, AGENCY_WORK_DATA_ACCESS: 'read-only', AGENCY_M365_TOOLS: 'workiq',
    COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'gpt-4.1',
    COPILOT_PROVIDER_API_KEY: 'synthetic-only', COPILOT_PROVIDER_HEADERS: '',
    COPILOT_PROVIDER_API_KEY_COMMAND: '', COPILOT_PROVIDER_BEARER_TOKEN: '',
  };
  await agencyMcp.start();
  assert.equal(agencyMcp.configuration().workiq?.type, 'http');
  assert.equal(agencyMcp.configuration().teams, undefined);
  supervisor = new Supervisor({ dataDir, env, bridge: createVSCodeBridge(dataDir, env, { agencyMcp }) });
  let completed = once(supervisor, 'notification');
  const receipt = await supervisor.callTool('start_work', {
    objective: 'Synthetic permission check. Only public Microsoft Learn content may be read.',
    readOnly: true, model: 'default',
  }, { requestId: 'synthetic-read' });
  const queued = await supervisor.callTool('send_work_message', { taskId: receipt.taskId, message: 'Once done, if the prior result is READ_CHECK_OK, reply THREAD_RESUMED. Otherwise report the failure. Do not read sources.' }, { requestId: 'synthetic-resume' });
  assert.equal(queued.state, 'queued');
  console.log('Agency read-only task dispatched; model provider is a local fixture.');
  const [initial] = await completed;
  assert.equal(initial.state, 'result_ready', initial.text);
  assert.equal(initial.text, 'READ_CHECK_OK');
  assert.equal(visibleTools.has('voice-teams-ListChatMessages'), false);
  assert.ok(visibleTools.has('voice-workiq-retrieve'));
  assert.equal(visibleTools.has('voice-workiq-ask'), false);
  assert.equal(visibleTools.has('voice-workiq-create_entity'), false);
  assert.ok(visibleTools.has('task_complete'));
  assert.ok([...visibleTools].every(name => name === 'task_complete' || name.startsWith('voice-')));
  assert.equal(visibleTools.has('voice-teams-SendMessageToChat'), false);
  assert.equal(visibleTools.has('powershell'), false);
  for (const id of ['blocked-write', 'blocked-shell', 'blocked-workiq-ask']) assert.match(toolResults.get(id) ?? '', /does not exist|denied|not allowed/i);
  assert.match(toolResults.get('public-read') ?? '', /learn\.microsoft\.com/);
  assert.match(toolResults.get('workiq-schema') ?? '', /\/me\/messages/);
  const task = supervisor.task(receipt.taskId);
  assert.equal(task.worktree, null);
  assert.equal(task.sessionLog, undefined);
  assert.ok(task.observations.every(observation => !/SHELL_REACHED|learn\.microsoft\.com/.test(observation.summary)));
  const sessionId = task.sessionId;
  completed = once(supervisor, 'notification');
  const [resumed] = await completed;
  assert.equal(resumed.state, 'result_ready', resumed.text);
  assert.equal(resumed.text, 'THREAD_RESUMED');
  assert.equal(supervisor.task(task.id).sessionId, sessionId);
  for (const access of ['disabled', 'read-only']) {
    env.AGENCY_WORK_DATA_ACCESS = access;
    visibleTools.clear();
    completed = once(supervisor, 'notification');
    await supervisor.callTool('send_work_message', { taskId: task.id, message: 'Synthetic consent refresh check. Reply THREAD_RESUMED without reading sources.' }, { requestId: `consent-${access}` });
    const [updated] = await completed;
    assert.equal(updated.state, 'result_ready', updated.text);
    assert.equal(visibleTools.has('voice-workiq-retrieve'), access === 'read-only');
    assert.equal(visibleTools.has('voice-teams-ListChatMessages'), false);
    assert.equal(visibleTools.has('voice-workiq-ask'), false);
    assert.equal(supervisor.task(task.id).sessionId, sessionId);
  }
  console.log('PASS: shared WorkIQ HTTP; WorkIQ schema and public Learn reads; redundant M365 servers omitted; writes, ask and shell rejected; queued same-session resume, consent revoke/restore and private progress.');
} finally {
  await supervisor?.close();
  await agencyMcp.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch { console.warn(`Disposable check files remain at ${dataDir}`); }
}