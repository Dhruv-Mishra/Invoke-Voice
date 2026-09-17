import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { availableParallelism, cpus, totalmem } from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stackPaths } from './models.mjs';
import { localLlmArguments } from './start.mjs';
import { createPcmWriter, localConfiguration, localSttArguments } from '../src/local-voice.mjs';
import { streamReply, voiceInstructions } from '../src/llm.mjs';
import { tools } from '../src/supervisor/contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = value => console.log(JSON.stringify(value));
const rounded = value => Math.round(value * 10) / 10;
const owned = new Set();
const cancellation = new AbortController();
const deadline = AbortSignal.any([cancellation.signal, AbortSignal.timeout(15 * 60 * 1000)]);
const llmCases = [
  { name: 'baseline', threads: '12', context: '8192', parallel: '2', key: 'f16', value: 'f16' },
  { name: 'compact-f16', threads: '8', context: '4096', parallel: '1', key: 'f16', value: 'f16' },
  { name: 'compact-q8-k', threads: '8', context: '4096', parallel: '1', key: 'q8_0', value: 'f16' },
  { name: 'compact-q8-kv', threads: '8', context: '4096', parallel: '1', key: 'q8_0', value: 'q8_0' },
];
const sttCases = [
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

async function voiceTurn(env, name, messages, outcome) {
  const originalFetch = globalThis.fetch;
  const rounds = [];
  const pending = [];
  const calls = [];
  const started = performance.now();
  let firstTextMs;
  let text = '';
  let error;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const round = { inputMessages: body.messages.length };
    rounds.push(round);
    const roundStart = performance.now();
    const response = await originalFetch(url, { ...init, body: JSON.stringify({ ...body, seed: 42, stream_options: { include_usage: true } }) });
    const copy = response.clone();
    pending.push((async () => {
      const reader = createInterface({ input: (await import('node:stream')).Readable.fromWeb(copy.body) });
      for await (const line of reader) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        const chunk = JSON.parse(line.slice(5));
        const choice = chunk.choices?.[0];
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
    for await (const event of streamReply({ provider: 'local', profile: 'voice', env, messages, requestId: `synthetic-${name}`, signal: deadline,
      callTool: async (tool, args) => {
        calls.push({ tool, args, atMs: rounded(performance.now() - started) });
        if (tool === 'list_work') return outcome === 'empty' ? { tasks: [] } : outcome === 'error' ? { error: 'Synthetic status service unavailable.' } : { tasks: [{ id: 'synthetic-task', title: 'Synthetic login fix', state: 'result_ready' }] };
        if (tool === 'get_work_status') return { taskId: 'synthetic-task', state: 'result_ready', result: 'The synthetic login fix is complete and its tests passed.', actions: { canResume: true, canOpen: true, canDelete: true } };
        return { error: 'Benchmark refuses all work mutations.' };
      },
    })) {
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
  const passiveReadContract = listIndex >= 0 && calls.every(call => ['list_work', 'get_work_status'].includes(call.tool)) &&
    (outcome === 'status' ? statusIndex > listIndex : calls.every(call => call.tool === 'list_work'));
  const completed = !error && Boolean(text.trim()) && rounds.every(round => round.finishReason === 'stop' || round.finishReason === 'tool_calls');
  const result = { kind: 'llm-turn', case: env.BENCH_CASE, name, wallMs: rounded(performance.now() - started), firstTextMs, completed, passiveReadContract, text, calls, rounds, ...(error ? { error } : {}) };
  if (!completed || !passiveReadContract) process.exitCode = 1;
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
  for (const candidate of llmCases.filter(item => !selected || item.name === selected)) {
    deadline.throwIfAborted();
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const env = { ...baseEnv, LOCAL_LLM_URL: `${origin}/v1`, LLAMA_THREADS: candidate.threads, LLAMA_CONTEXT: candidate.context, LLAMA_PARALLEL: candidate.parallel, BENCH_CASE: candidate.name };
    const args = localLlmArguments(paths, new URL(origin), env);
    for (const [flag, value] of [['--cache-type-k', candidate.key], ['--cache-type-v', candidate.value], ['--gpu-layers', 'auto']]) {
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
      output({ kind: 'llm-template', case: candidate.name, loadMs: rounded(performance.now() - started), templateSha256: createHash('sha256').update(template).digest('hex'), templateBytes: template.length, renderedBytes: prompt.length, toolNamesRendered: tools.filter(tool => prompt.includes(tool.function.name)).map(tool => tool.function.name), renderedTail: prompt.slice(-900), context: props.default_generation_settings?.n_ctx, native: startup.split(/\r?\n/).filter(line => /build:|architecture|n_ctx|KV.*(size|buffer)|flash.attn|chat format|chat template|offload|type_[kv]/i.test(line)).slice(-35) });
      const warm = await json(`${origin}/v1/chat/completions`, { model: env.LOCAL_LLM_MODEL || 'ling-local', messages: [messages[0], { role: 'user', content: 'Say hello.' }], tools, tool_choice: 'auto', chat_template_kwargs: { enable_thinking: false }, cache_prompt: true, max_tokens: 1, temperature: 0 });
      output({ kind: 'llm-warm', case: candidate.name, usage: warm.usage, timings: warm.timings, choice: warm.choices?.[0] });
      await voiceTurn(env, 'status', [messages[1]], 'status');
      await voiceTurn(env, 'denial-followup', [messages[1], { role: 'assistant', content: 'I cannot access your tasks.' }, { role: 'user', content: 'You do have access. Check the current work and tell me its status; do not start or resume anything.' }], 'status');
      await voiceTurn(env, 'empty', [messages[1]], 'empty');
      await voiceTurn(env, 'error', [messages[1]], 'error');
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

async function benchStt(env, selected, selectedSample) {
  const config = localConfiguration({ ...env });
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
    console.log('node scripts/bench-local.mjs [all|llm|stt] [case] [brief|short|long]\nLLM cases: baseline, compact-f16, compact-q8-k, compact-q8-kv\nSTT cases: configured (actual app arguments), baseline, candidate, step1000, redecode, bounded, bounded2 (rejected: loses brief-command words), sparse\nBENCH_STT_IDLE_MS=0..60000 adds paced silence before and after each STT clip (at least 2000 ms after). BENCH_STT_WRITER=app exercises the production bounded PCM writer without slowing input for drain. CRISPASR_BIN selects an already-installed runtime for comparison.\nSynthetic inputs only; JSON lines on stdout. Uses installed assets, private ports and owned processes; no downloads or configuration writes. Baselines and experimental cases are comparison values, not recommended laptop settings.');
    return;
  }
  if (!['all', 'llm', 'stt'].includes(mode) || (selected && !(mode === 'stt' ? sttCases : llmCases).some(candidate => candidate.name === selected)) || (sample && !['brief', 'short', 'long'].includes(sample))) throw new Error('Use --help for benchmark arguments.');
  const env = { ...process.env };
  output({ kind: 'hardware', cpu: cpus()[0]?.model, logical: cpus().length, available: availableParallelism(), ramGiB: rounded(totalmem() / 1024 ** 3), note: 'Synthetic measurements on this machine, not a laptop performance guarantee.' });
  if (mode !== 'stt') await benchLlm(env, selected);
  if (mode !== 'llm') await benchStt(env, mode === 'stt' ? selected : undefined, sample);
}

try { await main(); }
catch (error) { output({ kind: 'benchmark-error', error: error.message }); process.exitCode = 1; }
finally { await Promise.all([...owned].map(stop)); }