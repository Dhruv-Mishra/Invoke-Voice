import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, closeSync, createReadStream, existsSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { availableParallelism, cpus, totalmem } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stackPaths } from './models.mjs';
import { localLlmArguments } from './start.mjs';
import { createPcmWriter, createSttWriter, localConfiguration, localSttArguments } from '../src/local-voice.mjs';
import { streamReply, voiceInstructions } from '../src/llm.mjs';
import { modelTools as tools } from '../src/supervisor/contract.mjs';
import { evaluateJev, jevCases, jevReceipt } from './jev-cases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = value => {
  const line = JSON.stringify(value);
  console.log(line);
  if (process.env.BENCH_OUTPUT) appendFileSync(process.env.BENCH_OUTPUT, `${line}\n`);
};
const rounded = value => Math.round(value * 10) / 10;
const owned = new Set();
const cancellation = new AbortController();
const deadline = AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.min(240, Math.max(1, Number(process.env.BENCH_DEADLINE_MINUTES) || 15)) * 60 * 1000)]);
const llmCases = [
  { name: 'configured' },
  { name: 'baseline', threads: '12', context: '8192', parallel: '2', key: 'f16', value: 'f16' },
  { name: 'compact-f16', threads: '8', context: '4096', parallel: '1', key: 'f16', value: 'f16' },
  { name: 'compact-q8-k', threads: '8', context: '4096', parallel: '1', key: 'q8_0', value: 'f16' },
  { name: 'compact-q8-kv', threads: '8', context: '4096', parallel: '1', key: 'q8_0', value: 'q8_0' },
];
const sttCases = [
  { name: 'parakeet' },
  { name: 'whisper' },
  { name: 'whisper-scheduling' },
  { name: 'configured' },
  { name: 'baseline', threads: '12', partial: '1000', step: '500' },
  { name: 'candidate', threads: '4', partial: '2000', step: '500' },
  { name: 'step1000', threads: '4', partial: '2000', step: '1000' },
  { name: 'redecode', threads: '12', partial: '1000', step: '500', final: 'redecode' },
  { name: 'bounded', threads: '12', partial: '2000', step: '500', final: 'redecode', silence: '800', length: '4000', tail: '4' },
  { name: 'bounded2', threads: '12', partial: '2000', step: '500', final: 'redecode', silence: '800', length: '2000', tail: '4' },
  { name: 'sparse', threads: '12', partial: '4000', step: '500', final: 'redecode', silence: '800', length: '4000', tail: '4' },
];

function childProcess(executable, args, env) {
  deadline.throwIfAborted();
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  owned.add(child);
  child.failure = null;
  child.once('error', error => { child.failure = error; });
  child.closed = new Promise(resolve => child.once('close', resolve));
  child.once('close', () => owned.delete(child));
  child.stdin.on('error', () => {});
  return child;
}

async function stop(child) {
  if (!child || !owned.has(child)) return;
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await child.closed; } finally { clearTimeout(timer); }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cancellation.abort(new Error('Benchmark cancelled.'));
    process.exitCode = 1;
  });
}
deadline.addEventListener('abort', () => { for (const child of owned) child.kill(); });

async function json(url, body) {
  const response = await fetch(url, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([deadline, AbortSignal.timeout(60000)]),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Native endpoint HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

async function voiceTurn(env, name, messages, outcome, specification) {
  if (env.BENCH_TURN && !env.BENCH_TURN.split(',').includes(name)) return;
  const modes = (env.BENCH_ROUTERS || env.LOCAL_ROUTER || 'off').split(',');
  if (modes.some(mode => !['off', 'choice', 'scored', 'shadow'].includes(mode))) throw new Error('Invalid BENCH_ROUTERS.');
  const repeats = Number(env.BENCH_REPEATS || 1);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('BENCH_REPEATS must be 1..5.');
  for (let repeat = 0; repeat < repeats; repeat++) {
    const offset = (name.length + repeat) % modes.length;
    const order = [...modes.slice(offset), ...modes.slice(0, offset)];
    for (const mode of order) await measureVoiceTurn({ ...env, LOCAL_ROUTER: mode, BENCH_REPEAT: repeat }, name, messages, outcome, specification);
  }
}

async function measureVoiceTurn(env, name, messages, outcome, specification) {
  const originalFetch = globalThis.fetch;
  const document = name.startsWith('document-');
  const expectedAction = { workSearch: 'search_work', delegate: 'start_work', coding: 'start_work', note: 'invoke_vscode', delete: 'delete_work', deleteAll: 'delete_work', followup: 'send_work_message', cancel: 'cancel_work', open: 'open_work', theme: 'control_app', quiet: 'control_app', inbox: 'control_app', end: 'end_call' }[outcome];
  const status = {
    taskId: 'synthetic-task', title: document ? 'Onboarding document' : 'Synthetic login fix', state: 'result_ready',
    result: document ? 'The document draft is ready for review.' : 'The synthetic login fix is complete and its tests passed.',
    actions: ['send_work_message', 'open_work', 'delete_work'],
  };
  const rounds = [];
  const pending = [];
  const calls = [];
  const receipts = [];
  const decisions = [];
  const adapter = [];
  const matchesTask = args => args.taskId === status.taskId || args.query === status.taskId || (typeof args.query === 'string' && /login|document/i.test(args.query));
  const started = performance.now();
  let firstTextMs;
  let text = '';
  let error;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (env.BENCH_CACHE === 'cold' && (url.endsWith('/completion') || url.endsWith('/chat/completions'))) body.cache_prompt = false;
    init = { ...init, body: JSON.stringify(body) };
    if (!url.endsWith('/chat/completions')) {
      const start = performance.now();
      const response = await originalFetch(url, init);
      const record = { endpoint: new URL(url).pathname, wallMs: rounded(performance.now() - start) };
      if (url.endsWith('/apply-template')) record.promptTail = (await response.clone().json()).prompt?.slice(-240);
      if (url.endsWith('/completion')) {
        const result = await response.clone().json();
        Object.assign(record, { content: result.content, tokens: result.tokens, stopType: result.stop_type, timings: result.timings, tokensCached: result.tokens_cached, scoreCount: (result.completion_probabilities ?? result.probs)?.[0]?.top_logprobs?.length });
      }
      adapter.push(record);
      return response;
    }
    const round = { inputMessages: body.messages.length, stage: body.messages[0].content.includes('Available tools:') ? 'planner' : 'text' };
    rounds.push(round);
    const roundStart = performance.now();
    const response = await originalFetch(url, { ...init, body: JSON.stringify({ ...body, chat_template_kwargs: { enable_thinking: false }, temperature: 0.2, seed: Number(env.BENCH_SEED || 42), stream_options: { include_usage: true } }) });
    const copy = response.clone();
    pending.push((async () => {
      const reader = createInterface({ input: (await import('node:stream')).Readable.fromWeb(copy.body) });
      for await (const line of reader) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        const chunk = JSON.parse(line.slice(5));
        const choice = chunk.choices?.[0];
        if (env.BENCH_TRACE === '1' && choice?.delta) {
          round.content = (round.content || '') + (choice.delta.content || '');
          round.reasoning = (round.reasoning || '') + (choice.delta.reasoning_content || '');
        }
        if (round.firstDeltaMs === undefined && (choice?.delta?.content || choice?.delta?.tool_calls)) round.firstDeltaMs = rounded(performance.now() - roundStart);
        if (choice?.finish_reason) round.finishReason = choice.finish_reason;
        if (chunk.usage) round.usage = chunk.usage;
        if (chunk.timings) round.timings = chunk.timings;
      }
      round.wallMs = rounded(performance.now() - roundStart);
    })());
    return response;
  };
  try {
    for await (const event of streamReply({ provider: env.BENCH_NATIVE === '1' ? 'custom' : 'local', profile: 'voice', env: { ...env, CUSTOM_BASE_URL: env.LOCAL_LLM_URL, CUSTOM_MODEL: env.LOCAL_LLM_MODEL || 'ling-local', CUSTOM_API_KEY: '' }, messages, requestId: `synthetic-${name}`, signal: deadline,
      onDecision: decision => decisions.push(decision),
      callTool: async (tool, args) => {
        calls.push({ tool, args, atMs: rounded(performance.now() - started) });
        if (specification) return jevReceipt(specification, tool, args);
        if (tool === 'list_work') {
          if (outcome === 'empty') return args.query === undefined ? { tasks: [] } : { tasks: [], hasMore: false };
          if (outcome === 'error') return { error: 'Synthetic status service unavailable.' };
          if (outcome === 'ambiguous') return { tasks: [status, { ...status, taskId: 'synthetic-other', title: 'Policy document', result: 'The policy draft is ready for review.' }], hasMore: false };
          return args.query === undefined ? { tasks: [{ ...status, id: status.taskId }] } : { tasks: [status], hasMore: false };
        }
        if (tool === 'get_work_status') {
          if (outcome === 'ambiguous') return { clarificationRequired: true, tasks: [status, { ...status, taskId: 'synthetic-other', title: 'Policy document' }], hasMore: false };
          if (outcome === 'empty') return { clarificationRequired: true, tasks: [], hasMore: false };
          return matchesTask(args) ? status : { error: 'Unknown synthetic task.' };
        }
        if (tool === expectedAction) {
          if (outcome === 'workSearch') return args.source === { 'm365-email': 'email', 'm365-teams': 'teams', 'm365-meeting': 'calendar' }[name]
            ? { source: 'workiq', data: { markdown: 'The synthetic project review is scheduled for tomorrow at 10 AM. [^1]', sources: [{ id: '1', url: 'https://example.test/synthetic-review' }] } }
            : { error: 'Search must respect the requested source.' };
          if (outcome === 'deleteAll') return args.all === true ? { deleted: 'tasks', deletedCount: 30, failedCount: 0, failed: [], remaining: 0 } : { error: 'Expected bulk deletion.' };
          if (outcome === 'theme') return args.action === 'set_theme' && args.value === 'baymax' ? { saved: true, ...args } : { error: 'Wrong preference.' };
          if (outcome === 'quiet') return args.action === 'set_spoken_updates' && args.value === 'off' ? { saved: true, ...args } : { error: 'Wrong preference.' };
          if (outcome === 'inbox') return args.action === 'clear_notifications' && args.value === undefined ? { saved: true, ...args } : { error: 'Wrong inbox action.' };
          if (outcome === 'end') return { ended: true };
          if (outcome === 'coding') return args.readOnly !== true ? { taskId: status.taskId, state: 'dispatching' } : { error: 'Coding task cannot be read-only.' };
          if (outcome === 'note') return { invoked: true };
          if (outcome !== 'delegate' && !matchesTask(args)) return { error: 'Unknown synthetic task.' };
          if (outcome === 'cancel') return { taskId: status.taskId, title: status.title, state: 'cancelling' };
          if (outcome === 'open') return { opened: true };
          return outcome === 'delete' ? { taskId: args.taskId, title: status.title, deleted: true } : { taskId: status.taskId, title: outcome === 'delegate' ? 'JavaScript Map research' : status.title, state: 'dispatching' };
        }
        return { error: 'Benchmark refuses all work mutations.' };
      },
    })) {
      if (event.type === 'tool') receipts.push(event.result);
      if (event.type === 'text') {
        firstTextMs ??= rounded(performance.now() - started);
        text += event.text;
      }
    }
  } catch (failure) { error = failure.message; }
  finally {
    globalThis.fetch = originalFetch;
    await Promise.allSettled(pending);
  }
  const listIndex = calls.findIndex(call => call.tool === 'list_work');
  const statusIndex = calls.findIndex(call => call.tool === 'get_work_status' && call.args.taskId === 'synthetic-task');
  const queried = calls.some(call => ['list_work', 'get_work_status'].includes(call.tool) && typeof call.args.query === 'string' && call.args.query.trim());
  const passiveReadContract = outcome === 'conversation' ? calls.length === 0 : expectedAction
    ? calls.filter(call => call.tool === expectedAction).length === 1 && calls.every(call => ['list_work', expectedAction].includes(call.tool)) && !receipts.some(receipt => receipt.error) && (outcome !== 'delegate' || calls.find(call => call.tool === expectedAction)?.args.readOnly === true)
    : (listIndex >= 0 || queried) && calls.every(call => ['list_work', 'get_work_status'].includes(call.tool)) &&
      (outcome === 'status' ? queried || statusIndex > listIndex || receipts.some(receipt => receipt.tasks?.some(task => task.result === status.result)) : true);
  const spokenContract = !/synthetic-(task|other)|list_work|get_work_status|start_work|send_work_message|result_ready|<think>|```/i.test(text);
  const searchContract = !document || (queried && (outcome === 'status' ? calls.length === 1 : /\?/.test(text)));
  const completed = !error && Boolean(text.trim()) && rounds.every(round => round.finishReason === 'stop' || round.finishReason === 'tool_calls');
  const routingMs = (decisions[0]?.wallMs || 0) + rounds.filter(round => round.stage === 'planner').reduce((sum, round) => sum + round.wallMs, 0);
  const result = { kind: 'llm-turn', case: env.BENCH_CASE, router: env.LOCAL_ROUTER, repeat: env.BENCH_REPEAT, name, outcome, wallMs: rounded(performance.now() - started), routingMs: rounded(routingMs), firstToolMs: calls[0]?.atMs, firstTextMs, completed, passiveReadContract, spokenContract, searchContract, text, calls, receipts, rounds, decisions, adapter, ...(error ? { error } : {}) };
  if (specification) Object.assign(result, { category: specification.category, evaluation: evaluateJev(specification, result) });
  if (specification ? !result.evaluation.passed || !spokenContract : !completed || !passiveReadContract || !spokenContract || !searchContract) process.exitCode = 1;
  output(result);
  return result;
}

async function benchLlm(baseEnv, selected) {
  const paths = stackPaths({ ...baseEnv });
  for (const key of ['llama', 'ling']) if (!existsSync(paths[key])) throw new Error(`Installed ${key} missing; provision the local runtime before benchmarking.`);
  const descriptor = openSync(paths.ling, 'r');
  const magic = Buffer.alloc(4);
  try { readSync(descriptor, magic, 0, 4, 0); } finally { closeSync(descriptor); }
  if (magic.toString() !== 'GGUF') throw new Error(`Selected Ling file is not GGUF (${statSync(paths.ling).size} bytes). Supply an intact same-model LOCAL_LLM_PATH; benchmark never repairs assets.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(paths.ling)) hash.update(chunk);
  output({ kind: 'llm-model', name: path.basename(paths.ling), bytes: statSync(paths.ling).size, sha256: hash.digest('hex'), node: process.version, date: new Date().toISOString(), seed: Number(baseEnv.BENCH_SEED || 42), routers: baseEnv.BENCH_ROUTERS || 'off', repeats: Number(baseEnv.BENCH_REPEATS || 1), minimumProbability: baseEnv.LOCAL_ROUTER_MIN_PROBABILITY, minimumMargin: baseEnv.LOCAL_ROUTER_MIN_MARGIN });
  for (const candidate of llmCases.filter(item => !selected || item.name === selected)) {
    deadline.throwIfAborted();
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const env = { ...baseEnv, LOCAL_LLM_URL: `${origin}/v1`, BENCH_CASE: candidate.name };
    for (const [key, value] of [['LLAMA_THREADS', candidate.threads], ['LLAMA_CONTEXT', candidate.context], ['LLAMA_PARALLEL', candidate.parallel]]) {
      if (value !== undefined) env[key] = value;
    }
    const args = localLlmArguments(paths, new URL(origin), env);
    for (const [flag, value] of [['--cache-type-k', candidate.key], ['--cache-type-v', candidate.value]]) {
      if (value === undefined) continue;
      const index = args.indexOf(flag);
      if (index < 0) args.push(flag, value);
      else args[index + 1] = value;
    }
    output({ kind: 'llm-start', case: candidate.name, executable: paths.llama, args });
    const started = performance.now();
    const child = childProcess(paths.llama, args, env);
    let diagnostic = '';
    let startup = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => {
      diagnostic = (diagnostic + chunk).slice(-12000);
      if (startup.length < 60000) startup += chunk;
    });
    try {
      let healthy = false;
      while (performance.now() - started < 120000) {
        if (child.failure) throw child.failure;
        if (child.exitCode !== null) throw new Error(`Native process exited ${child.exitCode}: ${diagnostic.slice(-2000)}`);
        try { healthy = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
        if (healthy) break;
        await delay(250, undefined, { signal: deadline });
      }
      if (!healthy) throw new Error('Native runtime did not become healthy in 120 seconds.');
      const props = await json(`${origin}/props`);
      const messages = [{ role: 'system', content: voiceInstructions }, { role: 'user', content: 'What is the status of my work?' }];
      const template = String(props.chat_template || '');
      const rendered = await json(`${origin}/apply-template`, { messages, tools, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } });
      const prompt = String(rendered.prompt || '');
      output({ kind: 'llm-template', case: candidate.name, build: props.build_info, loadMs: rounded(performance.now() - started), templateSha256: createHash('sha256').update(template).digest('hex'), templateBytes: template.length, renderedBytes: prompt.length, toolNamesRendered: tools.filter(tool => prompt.includes(tool.function.name)).map(tool => tool.function.name), renderedTail: prompt.slice(-900), context: props.default_generation_settings?.n_ctx, native: startup.split(/\r?\n/).filter(line => /build:|architecture|n_ctx|KV.*(size|buffer)|flash.attn|chat format|chat template|offload|type_[kv]/i.test(line)).slice(-35) });
      const warm = await json(`${origin}/v1/chat/completions`, { model: env.LOCAL_LLM_MODEL || 'ling-local', messages: [messages[0], { role: 'user', content: 'Say hello.' }], tools, tool_choice: 'auto', chat_template_kwargs: { enable_thinking: false }, cache_prompt: true, max_tokens: 1, temperature: 0 });
      output({ kind: 'llm-warm', case: candidate.name, usage: warm.usage, timings: warm.timings, choice: warm.choices?.[0] });
      if (env.BENCH_SUITE === 'jev') {
        output({ kind: 'jev-corpus', cases: jevCases.length, sha256: createHash('sha256').update(JSON.stringify(jevCases)).digest('hex'), cache: env.BENCH_CACHE || 'natural', note: 'Synthetic development evaluation, not a 500-case human-reviewed held-out release set.' });
        for (const specification of jevCases) await voiceTurn(env, specification.name, specification.messages, 'jev', specification);
        continue;
      }
      await voiceTurn(env, 'status', [messages[1]], 'status');
      await voiceTurn(env, 'denial-followup', [messages[1], { role: 'assistant', content: 'I cannot access your tasks.' }, { role: 'user', content: 'You do have access. Check the current work and tell me its status; do not start or resume anything.' }], 'status');
      await voiceTurn(env, 'empty', [messages[1]], 'empty');
      await voiceTurn(env, 'error', [messages[1]], 'error');
      const documentQuestion = [{ role: 'user', content: "What's the status of the document work?" }];
      await voiceTurn(env, 'document-unique', documentQuestion, 'status');
      await voiceTurn(env, 'document-ambiguous', documentQuestion, 'ambiguous');
      await voiceTurn(env, 'document-missing', documentQuestion, 'empty');
      await voiceTurn(env, 'conversation', [{ role: 'user', content: 'Hello, how are you?' }], 'conversation');
      await voiceTurn(env, 'read-delegation', [{ role: 'user', content: 'Ask Agency to look up the JavaScript Map API in Microsoft Learn. Read-only; do not change anything.' }], 'delegate');
      await voiceTurn(env, 'delete-by-subject', [{ role: 'user', content: 'Delete the task about the login fix, keeping its files.' }], 'delete');
      await voiceTurn(env, 'worker-followup', [{ role: 'user', content: 'Send the worker for task synthetic-task this new instruction: run the tests again and report the result.' }], 'followup');
      await voiceTurn(env, 'delete-all', [{ role: 'user', content: 'Delete all my task chats. Keep the files.' }], 'deleteAll');
      await voiceTurn(env, 'theme', [{ role: 'user', content: 'Switch to the Baymax theme.' }], 'theme');
      await voiceTurn(env, 'spoken-updates-off', [{ role: 'user', content: 'Turn off spoken task updates.' }], 'quiet');
      await voiceTurn(env, 'clear-inbox', [{ role: 'user', content: 'Clear all notifications from my inbox.' }], 'inbox');
      await voiceTurn(env, 'end-call', [{ role: 'user', content: 'End this call.' }], 'end');
      await voiceTurn(env, 'stop-task', [{ role: 'user', content: 'Stop the task about the login fix.' }], 'cancel');
      await voiceTurn(env, 'open-task', [{ role: 'user', content: 'Open the task about the login fix in VS Code.' }], 'open');
      await voiceTurn(env, 'coding-task', [{ role: 'user', content: 'Start a new task to add unit tests for the login parser.' }], 'coding');
      await voiceTurn(env, 'vscode-note', [{ role: 'user', content: 'Open a request note in VS Code: review the parser. Do not start an agent.' }], 'note');
      await voiceTurn(env, 'conversation-no-delete', [{ role: 'user', content: 'Do not delete any tasks. Just say hello.' }], 'conversation');
      if (env.VOICE_DIRECT_MCP_ACCESS === 'read-only' && env.AGENCY_WORK_DATA_ACCESS === 'read-only') {
        await voiceTurn(env, 'm365-email', [{ role: 'user', content: 'Search my emails for the project review time.' }], 'workSearch');
        await voiceTurn(env, 'm365-teams', [{ role: 'user', content: 'What did the team say in Teams about the project review time?' }], 'workSearch');
        await voiceTurn(env, 'm365-meeting', [{ role: 'user', content: 'Find the project review meeting on my calendar.' }], 'workSearch');
      }
    } catch (error) {
      output({ kind: 'llm-error', case: candidate.name, error: error.message });
      process.exitCode = 1;
    } finally { await stop(child); }
  }
}

async function speech(env, text) {
  if (process.platform !== 'win32') throw new Error('Synthetic STT benchmark currently requires Windows System.Speech.');
  const source = `Add-Type -AssemblyName System.Speech; $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; $stream = New-Object System.IO.MemoryStream; $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); try { $speaker.SetOutputToAudioStream($stream, $format); $speaker.Rate = 0; $speaker.Speak('${text.replaceAll("'", "''")}'); $bytes = $stream.ToArray(); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length) } finally { $speaker.Dispose(); $stream.Dispose() }`;
  const child = childProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], env);
  const buffers = [];
  let diagnostic = '';
  child.stdout.on('data', chunk => buffers.push(chunk));
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1000); });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    await child.closed;
    if (child.failure || child.exitCode !== 0) throw new Error(`System.Speech failed: ${child.failure?.message || diagnostic}`);
    const pcm = Buffer.concat(buffers);
    let end = pcm.length - pcm.length % 2;
    while (end > 2 && Math.abs(pcm.readInt16LE(end - 2)) < 80) end -= 2;
    if (end < 3200 || end > 32000 * 40) throw new Error('Synthetic PCM duration is outside the bounded benchmark range.');
    return pcm.subarray(0, end);
  } finally { clearTimeout(timer); await stop(child); }
}

async function benchWhisper(env, selectedSample, preparedSamples = new Map(), engine = 'whisper') {
  const config = localConfiguration({ ...env, LOCAL_STT_PROVIDER: engine });
  const modelDir = engine === 'parakeet' ? config.parakeetModelDir : config.whisperModelDir;
  if (!existsSync(path.join(modelDir, engine === 'parakeet' ? 'encoder-model.int8.onnx' : 'model.bin'))) throw new Error(`${engine} model is missing. Install it in Settings before benchmarking.`);
  const predecodeMs = env.WHISPER_PREDECODE_MS || '480';
  const repeats = Number(env.BENCH_STT_REPEATS || '1');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('BENCH_STT_REPEATS must be an integer from 1 to 5.');
  const args = ['-I', '-u', fileURLToPath(new URL('./whisper_worker.py', import.meta.url)), '--engine', engine, '--model', modelDir, '--language', env.WHISPER_LANGUAGE || 'en', '--threads', env.WHISPER_THREADS || '8', '--silence-ms', env.WHISPER_END_SILENCE_MS || '1400', '--predecode-ms', predecodeMs];
  const child = childProcess(config.pythonBin, args, { ...env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' });
  const reader = createInterface({ input: child.stdout });
  const results = [];
  const finals = [];
  let diagnostic = '';
  let workerError;
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-1500); });
  reader.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'error') workerError = event.message;
      if (event.type === 'final') finals.push({ ...event, wallMs: performance.now() });
    } catch {}
  });
  function waitEvent(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Whisper ${type} timed out: ${workerError || diagnostic}`)), 60000);
      const onClose = () => finish(new Error(`Whisper stopped: ${workerError || diagnostic || child.failure?.message}`));
      const onLine = line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'error') finish(new Error(event.message));
        else if (event.type === type) finish(null, { ...event, wallMs: performance.now() });
      };
      function finish(error, event) {
        clearTimeout(timer);
        reader.off('line', onLine);
        child.off('close', onClose);
        error ? reject(error) : resolve(event);
      }
      reader.on('line', onLine);
      child.once('close', onClose);
    });
  }
  const writer = createSttWriter(child.stdin, 'whisper', message => { workerError = message; child.kill(); });
  const samples = [
    { name: 'brief', text: 'Please check my work.' },
    { name: 'short', text: 'Please check the current work and tell me whether the tests have passed.' },
    { name: 'long', text: 'Please check the current work and tell me whether the tests have passed before you summarize the latest result without starting any new work because I need to review the changes and decide what to do next.' },
    { name: 'paused', text: 'Please check the current work and tell me whether the tests have passed.', parts: ['Please check the current work', 'and tell me whether the tests have passed.'], pauseMs: 800 },
    { name: 'hesitation', text: 'Please check the current work but do not start any new work.', parts: ['Please check the current work', 'but do not start any new work.'], pauseMs: 1056 },
  ];
  try {
    const loading = performance.now();
    const ready = await waitEvent('ready');
    if (!['int8', 'int8_float32'].includes(ready.compute_type)) throw new Error('Whisper did not initialize INT8 inference.');
    output({ kind: 'stt-runtime', provider: engine, loadMs: rounded(ready.wallMs - loading), computeType: ready.compute_type, args });
    for (const sample of samples.filter(item => !selectedSample || item.name === selectedSample)) {
      let pcm = preparedSamples.get(sample.name);
      if (!pcm) {
        pcm = sample.parts
          ? Buffer.concat([await speech(env, sample.parts[0]), Buffer.alloc(sample.pauseMs * 32), await speech(env, sample.parts[1])])
          : await speech(env, sample.text);
        preparedSamples.set(sample.name, pcm);
      }
      for (let repeat = 1; repeat <= repeats; repeat++) for (const mode of ['commit', 'hands-free']) {
        const finalStart = finals.length;
        const final = waitEvent('final');
        final.catch(() => {});
        if (mode === 'commit') writer.begin();
        const started = performance.now();
        let maxInputLagMs = 0;
        const audio = mode === 'commit' ? pcm : Buffer.concat([pcm, Buffer.alloc(32000 * 4)]);
        for (let offset = 0; offset < audio.length; offset += 640) {
          deadline.throwIfAborted();
          if (workerError) throw new Error(workerError);
          writer.write(audio.subarray(offset, offset + 640));
          const remaining = started + Math.min(offset + 640, audio.length) / 32 - performance.now();
          maxInputLagMs = Math.max(maxInputLagMs, -remaining);
          if (remaining > 0) await delay(remaining, undefined, { signal: deadline });
        }
        if (mode === 'commit') writer.commit();
        const event = await final;
        const normalize = text => text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const transcriptMatches = normalize(event.text) === normalize(sample.text);
        const prematureFinal = event.wallMs < started + pcm.length / 32;
        const finalCount = finals.length - finalStart;
        const result = { kind: 'stt', case: engine, predecodeMs: Number(predecodeMs), repeat, mode, sample: sample.name, expected: sample.text, transcript: event.text, transcriptMatches, prematureFinal, finalCount, pcmSha256: createHash('sha256').update(pcm).digest('hex'), maxInputLagMs: rounded(maxInputLagMs), audioMs: rounded(pcm.length / 32), endSilenceMs: rounded(event.wallMs - started - pcm.length / 32) };
        results.push(result);
        output(result);
        if (!transcriptMatches || prematureFinal || finalCount !== 1) process.exitCode = 1;
      }
    }
  } finally { writer.dispose(); await stop(child); reader.close(); }
  return results;
}

async function benchStt(env, selected, selectedSample) {
  if (selected === 'parakeet') return benchWhisper(env, selectedSample, new Map(), 'parakeet');
  if (selected === 'whisper') return benchWhisper(env, selectedSample);
  if (selected === 'whisper-scheduling') {
    const preparedSamples = new Map();
    const baseline = await benchWhisper({ ...env, WHISPER_PREDECODE_MS: '0' }, selectedSample, preparedSamples);
    const candidate = await benchWhisper({ ...env, WHISPER_PREDECODE_MS: '480' }, selectedSample, preparedSamples);
    for (const previous of baseline) {
      const current = candidate.find(result => result.sample === previous.sample && result.mode === previous.mode && result.repeat === previous.repeat);
      const identical = current?.pcmSha256 === previous.pcmSha256 && current?.transcript === previous.transcript;
      output({ kind: 'stt-comparison', sample: previous.sample, mode: previous.mode, repeat: previous.repeat, identical, baselineMs: previous.endSilenceMs, candidateMs: current?.endSilenceMs, savedMs: current ? rounded(previous.endSilenceMs - current.endSilenceMs) : null });
      if (!identical) process.exitCode = 1;
    }
    return;
  }
  const config = localConfiguration({ ...env, LOCAL_STT_PROVIDER: 'moonshine' });
  const idleMs = Number(env.BENCH_STT_IDLE_MS || 0);
  if (!Number.isInteger(idleMs) || idleMs < 0 || idleMs > 60000) throw new Error('BENCH_STT_IDLE_MS must be an integer from 0 to 60000.');
  if (!config.sttConfigured) throw new Error('Installed Crisp, Moonshine, tokenizer or VAD missing; provision speech before benchmarking.');
  const descriptor = openSync(config.moonshineModel, 'r');
  const magic = Buffer.alloc(4);
  try { readSync(descriptor, magic, 0, 4, 0); } finally { closeSync(descriptor); }
  if (magic.toString() !== 'GGUF' || statSync(config.moonshineModel).size < 1024 * 1024) throw new Error('STT benchmark requires an intact installed GGUF model; it never repairs assets.');
  output({ kind: 'stt-runtime', executable: config.crispasrBin, executableBytes: statSync(config.crispasrBin).size, model: config.moonshineModel, modelBytes: statSync(config.moonshineModel).size });
  const samples = [
    { name: 'brief', text: 'Please check my work.' },
    { name: 'short', text: 'Please check the current work and tell me whether the tests have passed.' },
    { name: 'long', text: 'Please check the current work and tell me whether the tests have passed before you summarize the latest result without starting any new work because I need to review the changes and decide what to do next.' },
  ];
  for (const sample of samples.filter(item => selectedSample ? item.name === selectedSample : item.name !== 'brief')) {
    const pcm = await speech(env, sample.text);
    if (sample.name === 'long' && pcm.length <= 32000 * 8) throw new Error('Long speech must exceed the eight-second rolling window.');
    for (const candidate of sttCases.filter(item => selected ? item.name === selected : ['baseline', 'candidate'].includes(item.name))) {
      const settings = candidate.name === 'configured' ? { ...env, CRISPASR_MOONSHINE_STREAM_BENCH: '1' } : { ...env, CRISPASR_THREADS: candidate.threads, CRISPASR_PARTIAL_DECODE_MS: candidate.partial, CRISPASR_PARTIAL_TAIL_SEC: candidate.tail || '6', CRISPASR_STREAM_STEP_MS: candidate.step, CRISPASR_STREAM_LENGTH_MS: candidate.length || '8000', END_SILENCE_MS: candidate.silence || '500', CRISPASR_FINAL_MODE: candidate.final || 'prefix', CRISPASR_MOONSHINE_STREAM_BENCH: '1' };
      const args = [...localSttArguments(config, settings), '--verbose'];
      const child = childProcess(config.crispasrBin, args, settings);
      let writerError;
      const pcmWriter = env.BENCH_STT_WRITER === 'app' ? createPcmWriter(child.stdin, message => { writerError = message; child.kill(); }) : null;
      let diagnostic = '';
      let started;
      let decodeStarted;
      let inferenceStarted;
      let observedDecodeMs = 0;
      let observedInferenceMs = 0;
      let decodeCount = 0;
      let backpressureCount = 0;
      let maxWritableBytes = 0;
      let maxInputLagMs = 0;
      let writtenBytes = 0;
      const nativeStagesMs = {};
      const nativeTiming = [];
      const events = [];
      let ready;
      const readiness = new Promise(resolve => { ready = resolve; });
      const diagnostics = createInterface({ input: child.stderr });
      diagnostics.on('line', line => {
        if (line.includes('reading raw s16le 16kHz mono PCM from stdin')) ready();
        const stage = line.match(/moonshine_stream_bench:\s+(\w+)\s+([\d.]+) ms/);
        if (stage) nativeStagesMs[stage[1]] = rounded((nativeStagesMs[stage[1]] || 0) + Number(stage[2]));
        if (/^moonshine_streaming:|^whisper_vad_detect_speech: vad time|^crispasr\[stream\]/.test(line)) {
          nativeTiming.push(line);
          if (nativeTiming.length > 100) nativeTiming.shift();
        }
        if (/error|failed/i.test(line) && !line.includes('=')) diagnostic = (diagnostic + line).slice(-1000);
        if (/^whisper_vad_detect_speech: vad time/.test(line)) inferenceStarted = performance.now();
        if (/^moonshine_streaming: \d+ samples/.test(line)) decodeStarted = performance.now();
        if (/^moonshine_streaming: decoder produced/.test(line) && decodeStarted !== undefined) {
          observedDecodeMs += performance.now() - decodeStarted;
          decodeStarted = undefined;
          decodeCount += 1;
          if (inferenceStarted !== undefined) observedInferenceMs += performance.now() - inferenceStarted;
          inferenceStarted = undefined;
        }
      });
      const reader = createInterface({ input: child.stdout });
      reader.on('line', line => {
        try { events.push({ ...JSON.parse(line), wallMs: rounded(performance.now() - started) }); } catch {}
      });
      const timer = setTimeout(() => child.kill(), 180000);
      let error;
      try {
        await Promise.race([readiness, child.closed.then(() => { throw new Error(`Crisp failed before readiness: ${diagnostic.slice(-1000)}`); })]);
        started = performance.now();
        const audio = Buffer.concat([Buffer.alloc(idleMs * 32), pcm, Buffer.alloc(Math.max(2000, idleMs) * 32)]);
        for (let offset = 0; offset < audio.length; offset += 640) {
          deadline.throwIfAborted();
          if (child.exitCode !== null) throw new Error(`Crisp exited ${child.exitCode}`);
          const chunk = audio.subarray(offset, offset + 640);
          if (writerError) throw new Error(writerError);
          const writable = pcmWriter ? (pcmWriter.write(chunk), !child.stdin.writableNeedDrain) : child.stdin.write(chunk);
          writtenBytes += chunk.length;
          maxWritableBytes = Math.max(maxWritableBytes, child.stdin.writableLength);
          if (!writable) {
            backpressureCount += 1;
            if (!pcmWriter) await once(child.stdin, 'drain', { signal: deadline });
          }
          const remaining = started + Math.min(offset + 640, audio.length) / 32 - performance.now();
          maxInputLagMs = Math.max(maxInputLagMs, -remaining);
          if (remaining > 0) await delay(remaining, undefined, { signal: deadline });
        }
        while (!events.some(event => event.type === 'final' && event.text && event.wallMs >= idleMs + pcm.length / 32) && owned.has(child)) await delay(50, undefined, { signal: deadline });
        if (writerError) throw new Error(writerError);
      } catch (failure) { error = failure.message; }
      finally {
        const finals = events.filter(event => event.type === 'final' && event.text);
        const lastFinal = finals.at(-1);
        const transcript = finals.map(event => event.text).join(' ');
        const normalize = text => text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const transcriptMatches = normalize(transcript) === normalize(sample.text);
        output({ kind: 'stt', case: candidate.name, sample: sample.name, expected: sample.text, audioMs: rounded(pcm.length / 32), idleMs, writer: pcmWriter ? 'app' : 'drain', pcmSha256: createHash('sha256').update(pcm).digest('hex'), wallMs: started ? rounded(performance.now() - started) : null, endSilenceMs: lastFinal ? rounded(lastFinal.wallMs - idleMs - pcm.length / 32) : null, transcript, transcriptMatches, observedInferenceMs: rounded(observedInferenceMs), observedDecodeMs: rounded(observedDecodeMs), nativeStagesMs, decodeCount, writtenBytes, backpressureCount, maxWritableBytes, maxInputLagMs: rounded(maxInputLagMs), timingNote: 'Observed inference spans VAD completion to decoder completion; decode spans samples/frame log to decoder completion. Wall time also includes paced input, VAD and queueing.', args, events, nativeTiming, ...(error ? { error } : {}) });
        if (!lastFinal || !transcriptMatches || error) process.exitCode = 1;
        clearTimeout(timer);
        reader.close();
        diagnostics.close();
        pcmWriter?.dispose();
        await stop(child);
      }
    }
  }
}

async function main() {
  const [mode = 'all', selected, sample] = process.argv.slice(2);
  if (mode === '--help') {
    console.log('Jevify: BENCH_SUITE=jev selects 54 synthetic probes. BENCH_ROUTERS=off,choice,scored pairs modes per case; BENCH_REPEATS=1..5 rotates order. BENCH_CACHE=cold disables prompt reuse. LOCAL_ROUTER_REVERSE=1 permutes options. BENCH_OUTPUT appends JSONL to an existing directory. Scored mode abstains unless explicit LOCAL_ROUTER_MIN_PROBABILITY/MARGIN pass. All callbacks are synthetic.');
    console.log('LLM configured uses current environment and portable defaults. BENCH_TURN=name[,name] selects cases; BENCH_SEED selects the seed; BENCH_TRACE=1 records synthetic model content/reasoning. Enable both direct/private read-only flags to include three synthetic M365 searches. No real MCP calls are made.');
    console.log('STT cases parakeet and whisper test the installed INT8 worker with push-to-talk and hands-free synthetic audio. Other STT cases explicitly use Moonshine/CrispASR.');
    console.log('STT case whisper-scheduling compares predecode off versus 480 ms using identical PCM, including paused/hesitation samples; BENCH_STT_REPEATS=1..5 repeats each sample. No provisional result may end a turn early. WHISPER_PREDECODE_MS=0 disables predecode for the whisper case.');
    console.log('node scripts/bench-local.mjs [all|llm|stt] [case] [brief|short|long]\nLLM cases: configured, baseline, compact-f16, compact-q8-k, compact-q8-kv\nSTT cases: configured (actual app arguments), baseline, candidate, step1000, redecode, bounded, bounded2 (rejected: loses brief-command words), sparse\nBENCH_STT_IDLE_MS=0..60000 adds paced silence before and after each STT clip (at least 2000 ms after). BENCH_STT_WRITER=app exercises the production bounded PCM writer without slowing input for drain. CRISPASR_BIN selects an already-installed runtime for comparison.\nSynthetic inputs only; JSON lines on stdout. Uses installed assets, private ports and owned processes; no downloads or configuration writes. Baselines and experimental cases are comparison values, not recommended laptop settings.');
    return;
  }
  if (!['all', 'llm', 'stt'].includes(mode) || (selected && !(mode === 'stt' ? sttCases : llmCases).some(candidate => candidate.name === selected)) || (sample && !(selected === 'parakeet' || selected?.startsWith('whisper') ? ['brief', 'short', 'long', 'paused', 'hesitation'] : ['brief', 'short', 'long']).includes(sample))) throw new Error('Use --help for benchmark arguments.');
  const env = { ...process.env };
  output({ kind: 'hardware', cpu: cpus()[0]?.model, logical: cpus().length, available: availableParallelism(), ramGiB: rounded(totalmem() / 1024 ** 3), note: 'Synthetic measurements on this machine, not a laptop performance guarantee.' });
  if (mode !== 'stt') await benchLlm(env, selected);
  if (mode !== 'llm') await benchStt(env, mode === 'stt' ? selected : undefined, sample);
}

try { await main(); }
catch (error) { output({ kind: 'benchmark-error', error: error.message }); process.exitCode = 1; }
finally { await Promise.all([...owned].map(stop)); }