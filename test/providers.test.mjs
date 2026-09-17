import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { compactToolResult, streamReply, voiceInstructions } from '../src/llm.mjs';
import { supervisorInstructions } from '../src/supervisor.mjs';
import { drainVoiceText, isVoiceResponsePlayable, localSttArguments, parseVoiceResponse, retryPlaybackAction } from '../src/local-voice.mjs';
import { createTranscriptStream, DEFAULT_GEMINI_LIVE_MODEL, geminiLiveConfig, geminiLiveFunctionResponse } from '../src/realtime.mjs';

test('keeps the user-facing agent contract concise and hides implementation details', () => {
  assert.match(supervisorInstructions, /one or two short sentences/i);
  assert.match(supervisorInstructions, /Do not narrate tool calls/i);
  assert.match(supervisorInstructions, /task IDs/i);
  assert.match(supervisorInstructions, /raw JSON/i);
  assert.match(supervisorInstructions, /unless explicitly asked/i);
});

test('configures Gemini 3.8 Live with non-blocking tools and idle responses', () => {
  const config = geminiLiveConfig();
  const declarations = config.tools[0].functionDeclarations;
  assert.equal(DEFAULT_GEMINI_LIVE_MODEL, 'gemini-3.8-live');
  assert.equal(config.thinkingConfig, undefined);
  assert.equal(config.responseModalities[0], 'AUDIO');
  assert.ok(declarations.length > 0);
  assert.ok(declarations.every(declaration => declaration.behavior === 'NON_BLOCKING'));
  assert.deepEqual(geminiLiveFunctionResponse({ id: 'call-1', name: 'list_work' }, { tasks: [] }), {
    id: 'call-1', name: 'list_work', response: { tasks: [] }, scheduling: 'WHEN_IDLE',
  });
});

test('uses responsive STT timing without decoding every VAD step', () => {
  const args = localSttArguments({ moonshineModel: 'moonshine.gguf', moonshineTokenizer: 'tokenizer.bin', vadModel: 'vad.bin' }, {});
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('--stream-step'), '500');
  assert.equal(value('--stream-length'), '8000');
  assert.equal(value('--stream-partial-decode-ms'), '1000');
  assert.equal(value('--stream-partial-tail-sec'), '6');
  assert.equal(value('--stream-final-on-silence-ms'), '500');
  assert.equal(value('--stream-final-mode'), 'prefix');
  assert.equal(value('-t'), '12');
});

test('streams complete voice text once across stable synthesis chunks', () => {
  const first = drainVoiceText('This is the first complete clause, followed by text that is still arriving.');
  assert.deepEqual(first.chunks, ['This is the first complete clause,']);
  const final = drainVoiceText(`${first.remainder} And this is the end.`, true);
  assert.equal([...first.chunks, ...final.chunks].join(' '), 'This is the first complete clause, followed by text that is still arriving. And this is the end.');
  assert.equal(final.remainder, '');
  const version = drainVoiceText('Version 1.');
  assert.deepEqual(version.chunks, []);
  assert.deepEqual(drainVoiceText(`${version.remainder}2 is current.`, true).chunks, ['Version 1.2 is current.']);
  assert.equal(isVoiceResponsePlayable({ audioSent: true, synthesisFailed: false }), true);
  assert.equal(isVoiceResponsePlayable({ audioSent: true, synthesisFailed: true }), false);
  assert.equal(retryPlaybackAction({ id: 'action', playbackRetries: 1 }), null);
  assert.deepEqual(retryPlaybackAction({ id: 'action' }), { id: 'action', playbackRetries: 1 });
});

test('normalizes provider transcript deltas into cumulative partials and authoritative finals', () => {
  const events = [];
  const transcripts = createTranscriptStream(event => events.push(event));
  transcripts.push('assistant', 'Hello', { id: 'response-1' });
  transcripts.push('assistant', ' there', { id: 'response-1' });
  transcripts.push('assistant', 'Hello there.', { id: 'response-1', final: true, replacement: true });
  assert.deepEqual(events.map(({ text, partial }) => ({ text, partial })), [
    { text: 'Hello', partial: true },
    { text: 'Hello there', partial: true },
    { text: 'Hello there.', partial: false },
  ]);
  assert.ok(events.every(event => event.turnId === 'response-1'));
});

test('routes only explicit ACTION voice responses to deferred work', () => {
  assert.deepEqual(parseVoiceResponse('SAY: Ten.'), { route: 'say', text: 'Ten.' });
  assert.deepEqual(parseVoiceResponse('ACTION: I will check after speaking.'), { route: 'action', text: 'I will check after speaking.' });
  assert.deepEqual(parseVoiceResponse('Unlabelled fallback'), { route: 'say', text: 'Unlabelled fallback' });
  assert.deepEqual(parseVoiceResponse(''), { route: 'say', text: 'Okay.' });
});

test('bounds oversized tool results as valid structured data', () => {
  const compact = compactToolResult({ result: 'x'.repeat(1000) }, 120);
  assert.deepEqual(Object.keys(compact), ['preview', 'truncated']);
  assert.equal(compact.truncated, true);
  assert.ok(JSON.stringify(compact).length <= 120);
  assert.deepEqual(compactToolResult({ ok: true }, 120), { ok: true });
});

test('fast voice requests omit tools and keep the prompt compact', async () => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    let bodyText = '';
    for await (const chunk of req) bodyText += chunk;
    requestBody = JSON.parse(bodyText);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"SAY: Hello."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { LOCAL_LLM_URL: `http://127.0.0.1:${server.address().port}/v1`, LOCAL_LLM_MODEL: 'test-local' };
    const events = [];
    for await (const event of streamReply({ provider: 'local', profile: 'voice-fast', messages: [{ role: 'user', content: 'Hello' }], env })) events.push(event);
    assert.equal(requestBody.tools, undefined);
    assert.equal(requestBody.max_tokens, 96);
    assert.equal(requestBody.temperature, 0.2);
    assert.equal(requestBody.cache_prompt, true);
    assert.equal(requestBody.messages[0].content, voiceInstructions);
    assert.ok(JSON.stringify(requestBody).length < 1000);
    assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'SAY: Hello.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('normal local tool/result roundtrip verifies thinking false, tools roundtrip and no reasoning output across split tags', async () => {
  let requestCount = 0;
  let receivedThinkingFlag = null;
  let round2Messages = null;

  const server = http.createServer(async (req, res) => {
    let bodyText = '';
    for await (const chunk of req) {
      bodyText += chunk;
    }
    const body = JSON.parse(bodyText);
    requestCount++;

    if (requestCount === 1) {
      receivedThinkingFlag = body.chat_template_kwargs?.enable_thinking;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"choices":[{"delta":{"content":"<think>Internal thought process split across </th"}}]}\n\n');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ink>Checking existing work registered.\n' } }] })}\n\n`);
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_test_1","type":"function","function":{"name":"list_work","arguments":"{}"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (requestCount === 2) {
      round2Messages = body.messages;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"choices":[{"delta":{"content":"Here are the work areas."}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const env = { LOCAL_LLM_URL: `http://127.0.0.1:${port}/v1`, LOCAL_LLM_MODEL: 'test-local' };

  try {
    let toolInvoked = false;
    let toolInvocationName = null;
    let toolInvocationContext = null;

    const callTool = async (name, args, context) => {
      toolInvoked = true;
      toolInvocationName = name;
      toolInvocationContext = context;
      return { areas: [{ id: 'area-1', name: 'UI' }], tasks: [] };
    };

    const events = [];
    for await (const event of streamReply({
      provider: 'local',
      messages: [{ role: 'user', content: 'What work is running?' }],
      callTool,
      env,
      requestId: 'req-local-1',
    })) {
      events.push(event);
    }

    assert.equal(receivedThinkingFlag, false, 'Expected enable_thinking: false in request body');
    assert.equal(toolInvoked, true, 'Expected tool callback to be invoked');
    assert.equal(toolInvocationName, 'list_work');
    assert.ok(toolInvocationContext?.requestId, 'Expected requestId in tool invocation context');

    const textEvents = events.filter(e => e.type === 'text');
    const fullText = textEvents.map(e => e.text).join('');
    assert.ok(!fullText.includes('Internal thought process'), 'Reasoning content must not be output');
    assert.ok(!fullText.includes('think'), 'Thinking tags must not be output');
    assert.ok(fullText.includes('Checking existing work registered.'), 'Answer after split tag must be output');
    assert.ok(fullText.includes('Here are the work areas.'), 'Followup text must be output');

    const toolEvents = events.filter(e => e.type === 'tool');
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0].name, 'list_work');
    assert.deepEqual(toolEvents[0].result, { areas: [{ id: 'area-1', name: 'UI' }], tasks: [] });

    assert.ok(round2Messages, 'Round 2 messages must have been sent');
    const toolMsg = round2Messages.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'Expected tool result message in round 2 continuation');
    assert.equal(toolMsg.name, 'list_work');
    assert.deepEqual(JSON.parse(toolMsg.content), { areas: [{ id: 'area-1', name: 'UI' }], tasks: [] });

    assert.equal(events[events.length - 1].type, 'done');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('executes complete local tool-call batches concurrently and preserves result order', { timeout: 5000 }, async () => {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    requestCount++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requestCount === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_list', type: 'function', function: { name: 'list_work', arguments: '{}' } },
        { index: 1, id: 'call_status', type: 'function', function: { name: 'get_work_status', arguments: '{"taskId":"task-1"}' } },
      ] } }] })}\n\n`);
      res.end('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    } else {
      res.end('data: {"choices":[{"delta":{"content":"Both checks finished."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let releaseCalls;
  let markBothStarted;
  const callGate = new Promise(resolve => { releaseCalls = resolve; });
  const bothStarted = new Promise(resolve => { markBothStarted = resolve; });
  const started = [];
  const events = [];
  try {
    const consuming = (async () => {
      for await (const event of streamReply({
        provider: 'local',
        messages: [{ role: 'user', content: 'Check work and status' }],
        callTool: async name => {
          started.push(name);
          if (started.length === 2) markBothStarted();
          await callGate;
          return { name };
        },
        env: { LOCAL_LLM_URL: `http://127.0.0.1:${server.address().port}/v1`, LOCAL_LLM_MODEL: 'test-local' },
        requestId: 'parallel-local',
      })) events.push(event);
    })();
    await bothStarted;
    releaseCalls();
    await consuming;
    assert.deepEqual(started, ['list_work', 'get_work_status']);
    assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.name), started);
  } finally {
    releaseCalls();
    await new Promise(resolve => server.close(resolve));
  }
});

test('truncated tool call stream does NOT invoke callback', async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // consume
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Send partial tool call chunk without finish_reason='tool_calls'
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_trunc', type: 'function', function: { name: 'start_work', arguments: '{"areaId":"a1"' } }] } }] })}\n\n`);
    // Abruptly terminate stream without sending valid finish_reason
    res.end('data: [DONE]\n\n');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const env = { LOCAL_LLM_URL: `http://127.0.0.1:${port}/v1`, LOCAL_LLM_MODEL: 'test-local' };

  try {
    let callbackInvoked = false;
    const callTool = async () => {
      callbackInvoked = true;
      return { taskId: 'task-1' };
    };

    await assert.rejects(
      async () => {
        for await (const _ of streamReply({
          provider: 'local',
          messages: [{ role: 'user', content: 'Start task' }],
          callTool,
          env,
          requestId: 'req-trunc-1',
        })) {
          // consume
        }
      },
      /finish/i
    );

    assert.equal(callbackInvoked, false, 'Tool callback must not be invoked on truncated stream');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
