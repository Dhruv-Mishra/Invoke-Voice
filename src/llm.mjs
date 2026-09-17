import { createHash } from 'node:crypto';
import { tools as supervisorTools, supervisorInstructions } from './supervisor.mjs';

const anthropicTools = supervisorTools.map(tool => ({
  name: tool.function.name,
  description: tool.function.description,
  input_schema: tool.function.parameters,
}));

const allowedToolNames = new Set(supervisorTools.map(t => t.function?.name || t.name).filter(Boolean));
export const voiceInstructions = 'Answer with exactly one brief spoken sentence. Prefix ACTION: when the request requires supervisor tools or future work; otherwise prefix SAY:. For ACTION, only acknowledge. Never expose IDs, tool names, JSON, API fields, or reasoning.';

function assertLoopback(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid local URL: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!isLoopback) {
    throw new Error(`Local LLM URL must loopback to localhost or 127.0.0.1, got: ${host}`);
  }
}

export function providerProfiles(env = process.env) {
  return [
    {
      id: 'gemini',
      label: 'Gemini',
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
      configured: Boolean(env.GEMINI_API_KEY),
    },
    {
      id: 'openai',
      label: 'OpenAI',
      model: env.OPENAI_MODEL || 'gpt-4.1-mini',
      configured: Boolean(env.OPENAI_API_KEY),
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      configured: Boolean(env.ANTHROPIC_API_KEY),
    },
    {
      id: 'azure',
      label: 'Azure OpenAI',
      model: env.AZURE_OPENAI_DEPLOYMENT || env.AZURE_OPENAI_MODEL || 'gpt-4o-mini',
      configured: Boolean(env.AZURE_OPENAI_ENDPOINT && (env.AZURE_OPENAI_KEY || env.AZURE_OPENAI_API_KEY)),
    },
    {
      id: 'local',
      label: 'Local',
      model: env.LOCAL_LLM_MODEL || 'ling-local',
      configured: Boolean(env.LOCAL_LLM_URL),
    },
    {
      id: 'custom',
      label: 'Custom',
      model: env.CUSTOM_MODEL || 'custom-model',
      configured: Boolean(env.CUSTOM_BASE_URL),
    },
  ];
}

function resolveEndpoint(provider, model, env) {
  switch (provider) {
    case 'gemini': {
      if (!env.GEMINI_API_KEY) throw new Error('Add a Gemini API key in Settings > Config');
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GEMINI_API_KEY}` },
        model: model || env.GEMINI_MODEL || 'gemini-3.8-flash',
      };
    }
    case 'openai': {
      if (!env.OPENAI_API_KEY) throw new Error('Add an OpenAI API key in Settings > Config');
      const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
      return {
        url: `${base}/chat/completions`,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        model: model || env.OPENAI_MODEL || 'gpt-4.1-mini',
      };
    }
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) throw new Error('Add an Anthropic API key in Settings > Config');
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        model: model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      };
    }
    case 'azure': {
      const endpoint = env.AZURE_OPENAI_ENDPOINT;
      const key = env.AZURE_OPENAI_KEY || env.AZURE_OPENAI_API_KEY;
      if (!endpoint || !key) throw new Error('Add an Azure OpenAI endpoint and key in Settings > Config');
      const deployment = model || env.AZURE_OPENAI_DEPLOYMENT || env.AZURE_OPENAI_MODEL || 'gpt-4o-mini';
      const clean = endpoint.trim().replace(/\/+$/, '');
      const url = clean.includes('/chat/completions')
        ? clean
        : `${clean}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION || '2024-06-01'}`;
      return {
        url,
        headers: { 'Content-Type': 'application/json', 'api-key': key },
        model: deployment,
      };
    }
    case 'local': {
      const localUrl = env.LOCAL_LLM_URL;
      if (!localUrl) throw new Error('Missing LOCAL_LLM_URL for local provider');
      assertLoopback(localUrl);
      const clean = localUrl.trim().replace(/\/+$/, '');
      const url = clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
      return {
        url,
        headers: { 'Content-Type': 'application/json' },
        model: model || env.LOCAL_LLM_MODEL || 'ling-local',
      };
    }
    case 'custom': {
      const baseUrl = env.CUSTOM_BASE_URL;
      if (!baseUrl) throw new Error('Add a custom endpoint URL in Settings > Config');
      const clean = baseUrl.trim().replace(/\/+$/, '');
      const url = clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (env.CUSTOM_API_KEY) headers.Authorization = `Bearer ${env.CUSTOM_API_KEY}`;
      return { url, headers, model: model || env.CUSTOM_MODEL || 'custom-model' };
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

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

function prepareMessages(messages = [], { maxMessages = 12, maxChars = 16000 } = {}) {
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
    allowed.push({ role: m.role, content: text.slice(0, 16000) });
  }

  let slice = allowed.slice(-maxMessages);
  let totalChars = slice.reduce((sum, m) => sum + m.content.length, 0);
  while (slice.length > 1 && totalChars > maxChars) {
    slice.shift();
    totalChars = slice.reduce((sum, m) => sum + m.content.length, 0);
  }
  return slice;
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
}) {
  const config = resolveEndpoint(provider, model, env);
  const reasoningFilter = new ReasoningFilter();
  const executedCalls = new Map();
  const isAnthropic = provider === 'anthropic';
  const voiceFast = profile === 'voice-fast';
  let workingMessages = prepareMessages(messages, voiceFast ? { maxMessages: 4, maxChars: 2400 } : undefined);
  let completed = false;

  for (let round = 0; round < (voiceFast ? 1 : 4); round++) {
    if (signal?.aborted) return;
    const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);

    let body;
    if (isAnthropic) {
      body = {
        model: config.model,
        system: voiceFast ? voiceInstructions : supervisorInstructions,
        messages: formatAnthropicMessages(workingMessages),
        stream: true,
        max_tokens: voiceFast ? 96 : 1024,
      };
      if (!voiceFast) body.tools = anthropicTools;
    } else {
      body = {
        model: config.model,
        messages: [{ role: 'system', content: voiceFast ? voiceInstructions : supervisorInstructions }, ...workingMessages.filter(m => m.role !== 'system')],
        stream: true,
        max_tokens: voiceFast ? 96 : (provider === 'local' ? 512 : 1024),
      };
      if (!voiceFast) body.tools = supervisorTools;
      if (provider === 'local') {
        body.chat_template_kwargs = { enable_thinking: false };
        body.cache_prompt = true;
        body.temperature = voiceFast ? 0.2 : 0.7;
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
            yield { type: 'text', text: event.delta.text };
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
            yield { type: 'text', text };
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
          yield { type: 'text', text: remaining };
        }
      }
    }

    const finishedCalls = toolCalls.filter(Boolean);
    if (voiceFast && finishedCalls.length > 0) {
      throw new Error('Fast voice response attempted a tool call');
    }
    if (finishedCalls.length === 0) {
      const completeReason = isAnthropic ? stopReason === 'end_turn' : finishReason === 'stop';
      if (!streamCompleted || !completeReason) {
        const reason = isAnthropic ? stopReason : finishReason;
        throw new Error(`Response stream ended before completion (${reason || 'no finish reason'})`);
      }
      completed = true;
      break;
    }

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

      const isStartWork = call.name === 'start_work';
      const invocationKey = isStartWork
        ? stableMutationId(requestId, call.name, parsedArgs)
        : `${requestId || 'req'}-${round}-${i}-${callId}`;
      const toolCallContext = { requestId: invocationKey };

      let result;
      if (!allowedToolNames.has(call.name)) {
        result = { error: `Unauthorized or unknown tool: ${call.name}` };
      } else if (parseFailed) {
        result = parsedArgs;
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

  if (!completed) throw new Error('Response exceeded the tool round limit');
  yield { type: 'done' };
}
