import { createHash } from 'node:crypto';
import { tools as supervisorTools, supervisorInstructions, voiceTools } from './supervisor/contract.mjs';
import { themedInstructions } from './theme-session.mjs';
import { assertLoopback, providerProfiles, resolveEndpoint } from './llm/provider-config.mjs';

export { assertLoopback, providerProfiles, resolveEndpoint };

export const voiceInstructions = `${supervisorInstructions} Respond in brief, natural spoken sentences without markdown or routing prefixes.`;

class ReasoningFilter {
  constructor() {
    this.inThinking = false;
    this.buffer = '';
  }
  process(chunk) {
    if (!chunk) return '';
    this.buffer += chunk;
    let output = '';
    while (this.buffer.length > 0) {
      if (!this.inThinking) {
        const match = this.buffer.match(/<think>|\[think\]/i);
        if (!match) {
          const partial = this.buffer.match(/(<t?h?i?n?k?|\[t?h?i?n?k?)$/i);
          if (partial && partial.index !== undefined) {
            output += this.buffer.slice(0, partial.index);
            this.buffer = this.buffer.slice(partial.index);
            break;
          }
          output += this.buffer;
          this.buffer = '';
        } else {
          output += this.buffer.slice(0, match.index);
          this.buffer = this.buffer.slice(match.index + match[0].length);
          this.inThinking = true;
        }
      } else {
        const match = this.buffer.match(/<\/think>|\[\/think\]/i);
        if (!match) {
          const partial = this.buffer.match(/(<\/(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?|\[\/(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?|<|\[)$/i);
          if (partial && partial.index !== undefined) {
            this.buffer = this.buffer.slice(partial.index);
            break;
          }
          this.buffer = '';
          break;
        } else {
          this.buffer = this.buffer.slice(match.index + match[0].length);
          this.inThinking = false;
        }
      }
    }
    return output;
  }
  flush() {
    if (!this.inThinking && this.buffer) {
      const out = this.buffer;
      this.buffer = '';
      return out;
    }
    this.buffer = '';
    return '';
  }
}

export function compactToolResult(result, limit = 6000) {
  const value = result ?? {};
  const serialized = JSON.stringify(value);
  if (serialized.length <= limit) return value;
  const truth = Object.fromEntries(['taskId', 'id', 'state', 'status', 'stale', 'actions', 'error', 'duplicate', 'receipt', 'opened', 'invoked', 'deleted', 'saved', 'action', 'value']
    .filter(key => value[key] !== undefined)
    .map(key => [key, value[key]]));
  if (Array.isArray(value.tasks)) {
    if (typeof value.hasMore === 'boolean') {
      return {
        ...truth, hasMore: value.hasMore, truncated: true,
        tasks: value.tasks.map(task => ({
          ...compactToolResult(task, Math.max(128, Math.floor(limit / value.tasks.length) - 64)),
          title: task.title,
          ...(task.area !== undefined ? { area: task.area } : {}),
        })),
      };
    }
    const compact = { ...truth, tasks: [], truncated: true };
    for (const task of [...value.tasks].reverse()) {
      const record = Object.fromEntries(['id', 'taskId', 'state', 'status', 'stale', 'actions', 'error', 'areaId', 'title']
        .filter(key => task?.[key] !== undefined)
        .map(key => [key, key === 'title' ? String(task[key]).slice(0, 80) : task[key]]));
      compact.tasks.unshift(record);
      if (JSON.stringify(compact).length > limit) {
        delete record.title;
        delete record.areaId;
        if (JSON.stringify(compact).length > limit) {
          if (compact.tasks.length > 1) compact.tasks.shift();
          break;
        }
      }
    }
    if (value.defaultAreaId !== undefined) {
      compact.defaultAreaId = value.defaultAreaId;
      if (JSON.stringify(compact).length > limit) delete compact.defaultAreaId;
    }
    if (Array.isArray(value.areas)) {
      compact.areas = [];
      for (const area of value.areas) {
        compact.areas.push({ id: area.id, name: String(area.name || '').slice(0, 80) });
        if (JSON.stringify(compact).length > limit) { compact.areas.pop(); break; }
      }
      if (JSON.stringify(compact).length > limit) delete compact.areas;
    }
    return compact;
  }
  if (Object.keys(truth).length > 0) {
    const compact = { ...truth, truncated: true };
    for (const key of ['result', 'update', 'title', 'description']) {
      if (value[key] === undefined) continue;
      compact[key] = value[key];
      while (String(compact[key]).length > 16 && JSON.stringify(compact).length > limit) {
        compact[key] = String(compact[key]).slice(0, Math.floor(String(compact[key]).length / 2));
      }
      if (JSON.stringify(compact).length > limit) delete compact[key];
    }
    return compact;
  }
  let preview = serialized.slice(0, Math.max(0, limit - 40));
  let compact = { preview, truncated: true };
  while (preview && JSON.stringify(compact).length > limit) {
    preview = preview.slice(0, preview.length - (JSON.stringify(compact).length - limit));
    compact = { preview, truncated: true };
  }
  return compact;
}

function boundToolResult(result, limit = 6000) {
  return JSON.stringify(compactToolResult(result, limit));
}

function stableMutationId(baseRequestId, name, args) {
  const normArgs = args && typeof args === 'object'
    ? Object.keys(args).sort().reduce((acc, k) => { acc[k] = args[k]; return acc; }, {})
    : (args ?? {});
  const hash = createHash('sha256')
    .update(`${name}:${JSON.stringify(normArgs)}`)
    .digest('hex')
    .slice(0, 16);
  return `${baseRequestId || 'req'}-${hash}`;
}

function validateToolArgs(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Tool arguments must be a JSON object.';
  for (const key of schema.required || []) {
    if (!Object.hasOwn(args, key)) return `Missing required argument: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!Object.hasOwn(schema.properties, key)) return `Unknown argument: ${key}. Use only the tool schema fields.`;
    if (typeof value !== property.type) return `Argument ${key} must be ${property.type}.`;
    if (property.enum && !property.enum.includes(value)) return `Argument ${key} must be one of: ${property.enum.join(', ')}.`;
  }
  return null;
}

function prepareMessages(messages = [], { maxMessages = 12, maxChars = 16000, maxTextChars = 16000 } = {}) {
  const allowed = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter(part => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n');
    } else if (typeof m.text === 'string') {
      text = m.text;
    }
    allowed.push({ role: m.role, content: text.slice(0, maxTextChars) });
  }

  let slice = allowed.slice(-maxMessages);
  let totalChars = slice.reduce((sum, m) => sum + m.content.length, 0);
  while (slice.length > 1 && totalChars > maxChars) {
    slice.shift();
    totalChars = slice.reduce((sum, m) => sum + m.content.length, 0);
  }
  return slice;
}

function localContextTokens(env) {
  const context = Number(env.LLAMA_CONTEXT || 4096);
  const parallel = Number(env.LLAMA_PARALLEL || 1);
  if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(parallel) || parallel <= 0) {
    throw new Error('LLAMA_CONTEXT and LLAMA_PARALLEL must be positive integers');
  }
  return Math.floor(context / parallel);
}

function fitLocalMessages(messages, instructions, contextTokens, requestTools) {
  const fitted = [...messages];
  const fits = () => {
    const prompt = { tools: requestTools, messages: [{ role: 'system', content: instructions }, ...fitted] };
    const estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(prompt), 'utf8') / 3) + prompt.messages.length * 16;
    return estimatedTokens + 512 + 256 <= contextTokens;
  };
  while (!fits()) {
    const latestUser = fitted.findLastIndex(message => message.role === 'user');
    if (latestUser > 0) {
      const nextUser = fitted.findIndex((message, index) => index > 0 && message.role === 'user');
      fitted.splice(0, nextUser);
      continue;
    }
    let reduced = false;
    for (let index = 0; index < fitted.length; index += 1) {
      const message = fitted[index];
      if (message.role !== 'tool' || message.content.length <= 128) continue;
      const content = boundToolResult(JSON.parse(message.content), Math.max(128, Math.floor(message.content.length / 2)));
      if (content.length < message.content.length) {
        fitted[index] = { ...message, content };
        reduced = true;
      }
    }
    if (!reduced) {
      throw new Error(`Local request exceeds the estimated per-slot context budget (LLAMA_CONTEXT / LLAMA_PARALLEL = ${contextTokens}, output reserve 512). Shorten the request or increase per-slot context; the latest instruction was not truncated and current-turn tool exchanges were retained.`);
    }
  }
  return fitted;
}

function formatAnthropicMessages(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'tool' ? 'user' : m.role;
    let content = m.content;
    if (m.role === 'tool') {
      content = [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? {}),
      }];
    } else if (typeof content === 'string') {
      content = [{ type: 'text', text: content }];
    }
    const prev = result[result.length - 1];
    if (prev && prev.role === role) {
      prev.content = [
        ...(Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: String(prev.content) }]),
        ...(Array.isArray(content) ? content : [{ type: 'text', text: String(content) }]),
      ];
    } else {
      result.push({ role, content: Array.isArray(content) ? [...content] : content });
    }
  }
  if (result.length > 0 && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: [{ type: 'text', text: 'Task instructions ready.' }] });
  }
  return result;
}

async function* readSSELines(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
    }
    if (buf.trim() && !signal?.aborted) yield buf.trim();
  } finally {
    reader.releaseLock();
  }
}

export async function* streamReply({
  provider = 'gemini',
  model,
  messages = [],
  callTool = async () => ({}),
  signal,
  requestId,
  env = process.env,
  profile = 'supervisor',
  persona = '',
}) {
  const config = resolveEndpoint(provider, model, env);
  const reasoningFilter = new ReasoningFilter();
  const executedCalls = new Map();
  const isAnthropic = provider === 'anthropic';
  const requestTools = profile === 'voice' ? voiceTools : supervisorTools;
  const anthropicTools = requestTools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
  const toolSchemas = new Map(requestTools.map(tool => [tool.function.name, tool.function.parameters]));
  const instructions = themedInstructions(profile === 'voice' ? voiceInstructions : supervisorInstructions, persona);
  const contextTokens = provider === 'local' ? localContextTokens(env) : null;
  let workingMessages = prepareMessages(messages, provider === 'local'
    ? { maxMessages: Infinity, maxChars: Infinity, maxTextChars: Infinity }
    : undefined);
  let completed = false;

  const maxToolRounds = 8;
  for (let round = 0; round <= maxToolRounds; round++) {
    if (signal?.aborted) return;
    const finalRound = round === maxToolRounds;
    const roundInstructions = finalRound
      ? `${instructions} Tool budget reached. Answer now using the tool results. State what succeeded and what remains unfinished; do not claim unconfirmed actions or request more tools.`
      : instructions;
    if (provider === 'local') workingMessages = fitLocalMessages(workingMessages, roundInstructions, contextTokens, requestTools);
    const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);

    let body;
    if (isAnthropic) {
      body = {
        model: config.model,
        system: roundInstructions,
        messages: formatAnthropicMessages(workingMessages),
        stream: true,
        max_tokens: profile === 'voice' ? 512 : 1024,
        tools: anthropicTools,
        ...(finalRound ? { tool_choice: { type: 'none' } } : {}),
      };
    } else {
      body = {
        model: config.model,
        messages: [{ role: 'system', content: roundInstructions }, ...workingMessages.filter(m => m.role !== 'system')],
        stream: true,
        max_tokens: provider === 'local' || profile === 'voice' ? 512 : 1024,
        tools: requestTools,
        ...(finalRound ? { tool_choice: 'none' } : {}),
      };
      if (provider === 'local') {
        body.chat_template_kwargs = { enable_thinking: false };
        body.cache_prompt = true;
        body.temperature = 0.2;
      }
    }

    const response = await fetch(config.url, {
      method: 'POST',
      redirect: 'error',
      headers: config.headers,
      body: JSON.stringify(body),
      signal: fetchSignal,
    });

    if (!response.ok) {
      throw new Error(`${provider} API error (${response.status} ${response.statusText})`);
    }

    const toolCalls = [];
    let roundText = '';
    let stopReason = null;
    let finishReason = null;
    let streamCompleted = false;

    if (isAnthropic) {
      let currentTool = null;
      for await (const line of readSSELines(response, fetchSignal)) {
        if (signal?.aborted) return;
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        let event;
        try { event = JSON.parse(dataStr); } catch { continue; }
        if (event.type === 'error' || event.error) {
          throw new Error('Anthropic stream failed. Check provider access and logs.');
        }
        if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
        }
        if (event.type === 'message_stop') streamCompleted = true;
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentTool = { id: event.content_block.id, name: event.content_block.name, arguments: '' };
            toolCalls[event.index ?? toolCalls.length] = currentTool;
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            roundText += event.delta.text;
          } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            const target = toolCalls[event.index] || currentTool;
            if (target) target.arguments += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          currentTool = null;
        }
      }
    } else {
      for await (const line of readSSELines(response, fetchSignal)) {
        if (signal?.aborted) return;
        if (!line.startsWith('data:')) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        if (dataStr === '[DONE]') {
          streamCompleted = true;
          break;
        }
        let chunk;
        try { chunk = JSON.parse(dataStr); } catch { continue; }
        if (chunk.error) {
          throw new Error(`${provider} stream failed. Check provider access and logs.`);
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta;
        if (delta?.content) {
          const text = (provider === 'local' || provider === 'custom') ? reasoningFilter.process(delta.content) : delta.content;
          if (text) {
            roundText += text;
            if (provider === 'local' && !toolCalls.length && !delta.tool_calls?.length) yield { type: 'text', text };
          }
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
          }
        }
      }
      if (provider === 'local' || provider === 'custom') {
        const remaining = reasoningFilter.flush();
        if (remaining) {
          roundText += remaining;
          if (provider === 'local' && !toolCalls.length) yield { type: 'text', text: remaining };
        }
      }
    }

    const finishedCalls = toolCalls.filter(Boolean);
    if (finishedCalls.length === 0) {
      const completeReason = isAnthropic ? stopReason === 'end_turn' : finishReason === 'stop';
      if (!streamCompleted || !completeReason) {
        const reason = isAnthropic ? stopReason : finishReason;
        throw new Error(`Response stream ended before completion (${reason || 'no finish reason'})`);
      }
      if (roundText && provider !== 'local') yield { type: 'text', text: roundText };
      completed = true;
      break;
    }

    if (finalRound) throw new Error('The model requested more tools after its budget ended. Completed actions were retained; ask for the remaining work separately.');
    if (!streamCompleted) throw new Error('Tool call stream ended before completion');
    if (isAnthropic) {
      if (stopReason !== 'tool_use') {
        throw new Error(`Tool call stream ended without valid finish marker (stop_reason: ${stopReason})`);
      }
    } else {
      if (finishReason !== 'tool_calls' && finishReason !== 'function_call') {
        throw new Error(`Tool call stream ended without valid finish marker (finish_reason: ${finishReason})`);
      }
    }

    if (isAnthropic) {
      const assistantContent = [];
      if (roundText) assistantContent.push({ type: 'text', text: roundText });
      for (const call of finishedCalls) {
        let parsed = {};
        try { parsed = call.arguments ? JSON.parse(call.arguments) : {}; } catch {}
        assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: parsed });
      }
      workingMessages.push({ role: 'assistant', content: assistantContent });
    } else {
      workingMessages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: finishedCalls.map((c, i) => ({
          id: c.id || `call_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      });
    }

    const completedCalls = await Promise.all(finishedCalls.map(async (call, i) => {
      const callId = call.id || `call_${round}_${i}`;

      let parsedArgs = {};
      let parseFailed = false;
      try {
        parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
      } catch (err) {
        parseFailed = true;
        parsedArgs = { error: `Invalid JSON in tool arguments: ${err.message}` };
      }

      const isRead = call.name === 'list_work' || call.name === 'get_work_status';
      const invocationKey = isRead
        ? `${requestId || 'req'}-${round}-${i}-${callId}`
        : stableMutationId(requestId, call.name, parsedArgs);
      const toolCallContext = { requestId: invocationKey };

      let result;
      const schema = toolSchemas.get(call.name);
      const argumentError = schema && !parseFailed ? validateToolArgs(parsedArgs, schema) : null;
      if (!schema) {
        result = { error: `Unauthorized or unknown tool: ${call.name}` };
      } else if (parseFailed) {
        result = parsedArgs;
      } else if (argumentError) {
        result = { error: argumentError };
      } else if (executedCalls.has(invocationKey)) {
        result = await executedCalls.get(invocationKey);
      } else {
        if (signal?.aborted) return { call, i, result: { error: 'Request cancelled' } };
        const pending = Promise.resolve().then(() => callTool(call.name, parsedArgs, toolCallContext))
          .catch(err => ({ error: err.message || 'Tool execution error' }));
        executedCalls.set(invocationKey, pending);
        result = await pending;
        if (executedCalls.get(invocationKey) === pending) executedCalls.set(invocationKey, result);
      }

      return { call, i, result };
    }));
    if (signal?.aborted) return;

    const anthropicToolResults = [];
    for (const { call, i, result } of completedCalls) {
      const compactResult = compactToolResult(result);
      yield { type: 'tool', name: call.name, result: compactResult };

      if (isAnthropic) {
        anthropicToolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: boundToolResult(compactResult),
        });
      } else {
        workingMessages.push({
          role: 'tool',
          tool_call_id: call.id || `call_${round}_${i}`,
          name: call.name,
          content: boundToolResult(compactResult),
        });
      }
    }

    if (isAnthropic && anthropicToolResults.length > 0) {
      workingMessages.push({ role: 'user', content: anthropicToolResults });
    }
  }

  if (!completed) throw new Error('Response did not complete');
  yield { type: 'done' };
}
