import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamReply } from '../src/llm.mjs';

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

    assert.equal(events[events.length - 1].type, 'done');
  } finally {
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
