import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { streamReply } from './llm.mjs';
import { themeVoicePreset } from './theme-session.mjs';
import { createCloudRecognizer, synthesizeSpeech, validateSpeechPipeline } from './speech-pipeline.mjs';
import { localThreadDefault } from './runtime-config.mjs';
import { localSttProvider, stackPaths } from '../scripts/models.mjs';
import desktopLaunch from '../scripts/desktop-launch.cjs';

const worker = fileURLToPath(new URL('../scripts/kokoro_worker.py', import.meta.url));
const whisperWorker = fileURLToPath(new URL('../scripts/whisper_worker.py', import.meta.url));
const bundledPython = fileURLToPath(new URL('../.venv/Scripts/python.exe', import.meta.url));
const defaultMoonshineModel = fileURLToPath(new URL('../../LocalVoiceStack/STT_Models/moonshine-streaming-tiny-q4_k.gguf', import.meta.url));
let kokoroRuntimePromise;
let sttRuntimePromise;
let kokoroProcess;
let sttProcess;
const runtimeExitListeners = new Set();
const intentionalStops = new WeakSet();

function stopRuntime(child) {
  if (!child) return;
  intentionalStops.add(child);
  child.kill();
}

export function isLocalVoiceWarm() {
  return [kokoroProcess, sttProcess].every(process => process && process.exitCode === null && process.signalCode === null);
}

export function onLocalVoiceRuntimeExit(listener) {
  runtimeExitListeners.add(listener);
  return () => runtimeExitListeners.delete(listener);
}

function reportRuntimeExit(runtime) {
  for (const listener of runtimeExitListeners) listener(runtime);
}

async function startKokoroRuntime(config, env, signal) {
  const process = spawn(config.pythonBin, ['-u', worker], { windowsHide: true, env: { ...env, LOCAL_THREADS: env.KOKORO_THREADS || env.LOCAL_THREADS || '8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  kokoroProcess = process;
  desktopLaunch.trackChild(process);
  let diagnostic = '';
  process.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-1000); });
  process.stdin.on('error', () => {});
  const reader = createInterface({ input: process.stdout });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kokoro startup exceeded 45s. Run its warm-up command first.')), 45000);
      const abort = () => { clearTimeout(timer); stopRuntime(process); reject(new Error('Kokoro startup was cancelled')); };
      const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      signal?.addEventListener('abort', abort, { once: true });
      process.once('error', error => finish(new Error(`Kokoro failed to start: ${error.message}`)));
      process.once('exit', code => finish(new Error(`Kokoro exited (${code}). ${diagnostic}`)));
      const onLine = line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'ready') { reader.off('line', onLine); finish(); }
      };
      reader.on('line', onLine);
    });
  } catch (error) {
    reader.close();
    stopRuntime(process);
    throw error;
  }
  return { process, reader };
}

function getKokoroRuntime(config, env, signal) {
  if (!kokoroRuntimePromise) {
    const pending = startKokoroRuntime(config, env, signal);
    kokoroRuntimePromise = pending;
    pending.then(runtime => {
      runtime.process.once('exit', () => {
        if (kokoroRuntimePromise === pending) kokoroRuntimePromise = undefined;
        if (kokoroProcess !== runtime.process) return;
        kokoroProcess = undefined;
        if (!intentionalStops.has(runtime.process)) reportRuntimeExit('Kokoro');
      });
    }).catch(() => { if (kokoroRuntimePromise === pending) kokoroRuntimePromise = undefined; });
  }
  return kokoroRuntimePromise;
}

async function startSttRuntime(config, env, signal) {
  const whisper = config.sttProvider === 'whisper';
  const name = whisper ? 'Whisper' : 'CrispASR';
  const executable = whisper ? config.pythonBin : config.crispasrBin;
  const args = whisper ? ['-I', '-u', whisperWorker, '--model', config.whisperModelDir, '--threads', env.WHISPER_THREADS || env.LOCAL_THREADS || localThreadDefault(8), '--language', env.WHISPER_LANGUAGE || 'auto', '--silence-ms', env.WHISPER_END_SILENCE_MS || '650'] : localSttArguments(config, env);
  const process = spawn(executable, args, { windowsHide: true, env: { ...env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  sttProcess = process;
  desktopLaunch.trackChild(process);
  let diagnostic = '';
  process.stdin.on('error', () => {});
  const transcription = createInterface({ input: process.stdout });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not become ready within 60s. Run local setup and retry.`)), 60000);
      const abort = () => { clearTimeout(timer); stopRuntime(process); reject(new Error(`${name} startup was cancelled`)); };
      const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      signal?.addEventListener('abort', abort, { once: true });
      const onLine = line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'ready') {
          transcription.off('line', onLine);
          finish(['int8', 'int8_float32'].includes(event.compute_type) ? null : new Error(`Whisper did not initialize INT8 inference (${event.compute_type}).`));
        } else if (event.type === 'error') finish(new Error(event.message || 'Whisper startup failed'));
      };
      if (whisper) transcription.on('line', onLine);
      process.stderr.on('data', chunk => {
        diagnostic = (diagnostic + chunk.toString()).slice(-1000);
        if (!whisper && diagnostic.includes('reading raw s16le 16kHz mono PCM from stdin')) finish();
      });
      process.once('error', error => finish(new Error(`${name} failed: ${error.message}`)));
      process.once('exit', code => finish(new Error(`${name} stopped during startup (${code}): ${diagnostic}`)));
    });
  } catch (error) {
    transcription.close();
    stopRuntime(process);
    throw error;
  }
  return { process, transcription, name, diagnostic: () => diagnostic };
}

function getSttRuntime(config, env, signal) {
  if (!sttRuntimePromise) {
    const pending = startSttRuntime(config, env, signal);
    sttRuntimePromise = pending;
    pending.then(runtime => {
      runtime.process.once('exit', () => {
        if (sttRuntimePromise === pending) sttRuntimePromise = undefined;
        if (sttProcess !== runtime.process) return;
        sttProcess = undefined;
        if (!intentionalStops.has(runtime.process)) reportRuntimeExit(runtime.name);
      });
    }).catch(() => { if (sttRuntimePromise === pending) sttRuntimePromise = undefined; });
  }
  return sttRuntimePromise;
}

async function claimSttRuntime(config, env) {
  const pending = getSttRuntime(config, env);
  if (sttRuntimePromise === pending) sttRuntimePromise = undefined;
  const runtime = await pending;
  if (runtime.process.exitCode !== null) throw new Error(`${runtime.name} stopped before the voice session started (${runtime.process.exitCode})`);
  return runtime;
}

export async function warmLocalVoice(env = process.env, signal) {
  const config = localConfiguration(env);
  const warmups = [];
  const ownedProcesses = [];
  if (config.ttsConfigured) {
    const existing = kokoroRuntimePromise;
    warmups.push(getKokoroRuntime(config, env, signal));
    if (!existing && kokoroProcess) ownedProcesses.push(kokoroProcess);
  }
  if (config.sttConfigured) {
    const existing = sttRuntimePromise;
    warmups.push(getSttRuntime(config, env, signal));
    if (!existing && sttProcess) ownedProcesses.push(sttProcess);
  }
  try { await Promise.all(warmups); }
  catch (error) {
    for (const process of ownedProcesses) stopRuntime(process);
    await Promise.allSettled(warmups);
    throw error;
  }
  return warmups.length > 0;
}

export async function closeLocalVoice() {
  const pending = [kokoroRuntimePromise, sttRuntimePromise];
  kokoroRuntimePromise = undefined;
  sttRuntimePromise = undefined;
  for (const process of new Set([kokoroProcess, sttProcess].filter(Boolean))) stopRuntime(process);
  kokoroProcess = undefined;
  sttProcess = undefined;
  for (const result of await Promise.allSettled(pending.filter(Boolean))) {
    if (result.status === 'fulfilled') {
      result.value.reader?.close();
      result.value.transcription?.close();
      stopRuntime(result.value.process);
    }
  }
}

export function localConfiguration(env = process.env) {
  const paths = stackPaths(env);
  const sttProvider = localSttProvider(env);
  const whisperModelDir = paths.whisperDir;
  const crispasrBin = paths.crispasr;
  const requestedMoonshineModel = env.MOONSHINE_MODEL ? path.resolve(env.MOONSHINE_MODEL) : defaultMoonshineModel;
  const unsupportedQ8 = path.basename(requestedMoonshineModel).toLowerCase() === 'moonshine-streaming-small-q8_0.gguf';
  const moonshineModel = env.MOONSHINE_EFFECTIVE_MODEL || (existsSync(paths.moonshine) ? paths.moonshine : requestedMoonshineModel);
  const sttLabel = sttProvider === 'whisper' ? 'Whisper Small INT8' : /^moonshine-streaming-tiny-/i.test(path.basename(moonshineModel)) ? 'Moonshine Tiny streaming' : /^moonshine-streaming-small-/i.test(path.basename(moonshineModel)) ? 'Moonshine Small streaming' : 'Moonshine custom streaming';
  const sttWarning = sttProvider === 'moonshine' && unsupportedQ8 && moonshineModel !== requestedMoonshineModel ? 'Small Q8_0 crashes CrispASR 0.8.32; using canonical Tiny Q4_K.' : null;
  const siblingTokenizer = path.join(path.dirname(moonshineModel), 'tokenizer.bin');
  const moonshineTokenizer = env.MOONSHINE_TOKENIZER || (existsSync(siblingTokenizer) ? siblingTokenizer : paths.tokenizer);
  const vadModel = paths.vad;
  const sttConfigured = sttProvider === 'whisper'
    ? [paths.whisperModel, paths.whisperConfig, paths.whisperTokenizer, paths.whisperVocabulary].every(existsSync) && env.WHISPER_READY === '1'
    : [crispasrBin, moonshineModel, moonshineTokenizer, vadModel].every(existsSync);
  const managedPython = existsSync(path.join(paths.venv, 'complete.json')) && existsSync(paths.python) ? paths.python : null;
  const pythonBin = env.PYTHON_BIN && env.PYTHON_BIN !== 'python' ? path.resolve(env.SUPERVISOR_CONFIG_DIR || fileURLToPath(new URL('../', import.meta.url)), env.PYTHON_BIN) : managedPython || (existsSync(bundledPython) ? bundledPython : 'python');
  const ttsConfigured = existsSync(pythonBin) || env.KOKORO_READY === '1';
  return { configured: sttConfigured && ttsConfigured, sttConfigured, ttsConfigured, sttProvider, sttLabel, whisperModelDir, pythonBin, crispasrBin, requestedMoonshineModel, moonshineModel, moonshineTokenizer, sttWarning, vadModel, model: env.LOCAL_LLM_MODEL || 'ling-local', ttsModel: env.KOKORO_REPO || 'hexgrad/Kokoro-82M', ttsVoice: env.KOKORO_VOICE || 'af_heart', sttStreamingArchitecture: sttProvider === 'whisper' ? 'faster-whisper Small INT8 utterance transcription' : 'CrispASR rolling-window streaming' };
}

export function localSttArguments(config, env = process.env) {
  return ['--backend', 'moonshine-streaming', '-m', config.moonshineModel, '--cache-dir', path.dirname(config.moonshineTokenizer), '--stream', '--stream-json', '--vad', '--vad-model', config.vadModel, '--stream-step', env.CRISPASR_STREAM_STEP_MS || '500', '--stream-length', env.CRISPASR_STREAM_LENGTH_MS || '4000', '--stream-partial-decode-ms', env.CRISPASR_PARTIAL_DECODE_MS || '4000', '--stream-partial-tail-sec', env.CRISPASR_PARTIAL_TAIL_SEC || '4', '--stream-final-on-silence-ms', env.END_SILENCE_MS || '800', '--stream-final-mode', env.CRISPASR_FINAL_MODE || 'redecode', '-t', env.CRISPASR_THREADS || env.LOCAL_THREADS || localThreadDefault(12)];
}

export function createPcmWriter(stream, onError, { maxBytes = 32000 * 8, stallMs = 8000 } = {}) {
  const queue = [];
  let queuedBytes = 0;
  let blocked = stream.writableNeedDrain;
  let disposed = false;
  let timer;
  function dispose() {
    disposed = true;
    clearTimeout(timer);
    queue.length = 0;
    queuedBytes = 0;
    stream.off('drain', drain);
    stream.off('error', pipeError);
    stream.off('close', pipeError);
  }
  function fail(message) {
    if (disposed) return;
    dispose();
    onError(message);
  }
  function pipeError() { fail('Speech recognition input pipe closed'); }
  function pump() {
    if (disposed) return;
    try {
      while (!blocked && queue.length) {
        const chunk = queue.shift();
        queuedBytes -= chunk.length;
        blocked = !stream.write(chunk);
      }
    } catch { return pipeError(); }
    if (blocked && !timer) {
      timer = setTimeout(() => fail('Speech recognition input stalled. Reconnect voice to retry.'), stallMs);
      timer.unref?.();
    }
  }
  function drain() {
    clearTimeout(timer);
    timer = undefined;
    blocked = false;
    pump();
  }
  stream.on('drain', drain);
  stream.on('error', pipeError);
  stream.on('close', pipeError);
  return {
    write(chunk) {
      if (disposed) return;
      if (!stream.writable) return pipeError();
      if (queuedBytes + stream.writableLength + chunk.length > maxBytes) {
        return fail('Speech recognition input exceeded its buffer. Reconnect voice to retry.');
      }
      queue.push(chunk);
      queuedBytes += chunk.length;
      pump();
    },
    dispose,
  };
}

export function createSttWriter(stream, provider, onError) {
  const whisper = provider === 'whisper';
  const writer = createPcmWriter(stream, onError, whisper ? { maxBytes: 32000 * 8 * 2 } : undefined);
  const packet = event => writer.write(Buffer.from(`${JSON.stringify(event)}\n`));
  return {
    write(pcm) { if (whisper) packet({ type: 'audio', data: pcm.toString('base64') }); else writer.write(pcm); },
    commit() { if (whisper) packet({ type: 'commit' }); else writer.write(Buffer.alloc(32000 * 2)); },
    dispose: writer.dispose,
  };
}

export function drainVoiceText(value, final = false) {
  let remainder = String(value || '').trimStart();
  const chunks = [];
  while (remainder) {
    let cut = -1;
    const boundaries = remainder.matchAll(final ? /[.!?;,](?:\s+|$)/g : /[.!?;,]\s+/g);
    for (const match of boundaries) {
      const end = match.index + match[0].length;
      if (end >= 24 && end <= 56) { cut = end; break; }
    }
    if (cut < 0 && remainder.length >= 56) {
      cut = remainder.lastIndexOf(' ', 56);
      if (cut < 24) cut = remainder.indexOf(' ', 56);
    }
    if (cut < 0) {
      if (final) chunks.push(remainder.trim());
      break;
    }
    const chunk = remainder.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remainder = remainder.slice(cut).trimStart();
  }
  return { chunks, remainder: final ? '' : remainder };
}

export function isVoiceResponsePlayable(response) {
  return response?.audioSent === true && response?.synthesisFailed !== true;
}

function spokenSummary(value) {
  const clean = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return sentences.slice(0, 2).join(' ').trim().slice(0, 360) || 'The action finished.';
}

export async function createLocalVoice({ send, callTool, provider = 'local', sttProvider = 'local', ttsProvider = 'local', model, allowCloud = false, persona = '', voiceTheme = '', env = process.env }) {
  const voicePreset = themeVoicePreset(voiceTheme);
  validateSpeechPipeline({ provider, sttProvider, ttsProvider, allowCloud }, env);
  const config = localConfiguration(env);
  if (sttProvider === 'local' && !config.sttConfigured) throw new Error(`Install ${config.sttLabel} and its runtime from Settings > Local voice.`);
  if (ttsProvider === 'local' && !config.ttsConfigured) throw new Error('Install Kokoro from Settings > Local voice.');
  const speechLifetime = new AbortController();
  const sessionId = randomUUID();
  let closed = false;
  let turn = 0;
  let controller;
  let generating = false;
  let stt;
  let tts;
  let ttsReader;
  let ttsLineHandler;
  let ttsExitHandler;
  let activePhrase;
  let activePhraseTimer;
  let activePhraseAbort;
  let lastSpeechAt = 0;
  let latestSpeechId;
  let recognizing = false;
  let pcmWriter;
  const phrases = [];
  const messages = [];
  const finalized = new Set();
  const readers = [];
  const responses = new Map();
  const announcementQueue = [];
  const acceptedNotifications = new Set();
  const announcementTimer = setInterval(() => pumpAnnouncements(), 250);
  announcementTimer.unref();
  const close = () => {
    closed = true;
    speechLifetime.abort();
    pcmWriter?.dispose();
    controller?.abort();
    clearInterval(announcementTimer);
    phrases.length = 0;
    announcementQueue.length = 0;
    clearTimeout(activePhraseTimer);
    for (const response of responses.values()) clearTimeout(response.playbackTimer);
    responses.clear();
    readers.forEach(reader => reader.close());
    if (ttsReader && ttsLineHandler) ttsReader.off('line', ttsLineHandler);
    if (tts && ttsExitHandler) tts.off('exit', ttsExitHandler);
    stopRuntime(stt);
  };
  const fail = message => { if (!closed) send({ type: 'error', message, fatal: true }); close(); };
  function interrupt() {
    const interruptedToken = turn;
    const hadActivity = generating || responses.size > 0 || phrases.some(item => item.token === interruptedToken) || activePhrase?.token === interruptedToken;
    turn += 1;
    controller?.abort();
    activePhraseAbort?.abort();
    generating = false;
    for (let index = phrases.length - 1; index >= 0; index -= 1) {
      if (phrases[index].token === interruptedToken) phrases.splice(index, 1);
    }
    for (const [responseId, response] of responses) {
      if (response.token !== interruptedToken) continue;
      if (response.announcement) announcementQueue.unshift({ ...response.announcement, transcript: false });
      clearTimeout(response.playbackTimer);
      responses.delete(responseId);
    }
    if (hadActivity) send({ type: 'interrupted' });
  }
  function pump() {
    if (closed || activePhrase || !phrases.length) return;
    activePhrase = phrases.shift();
    if (ttsProvider !== 'local') {
      const current = activePhrase;
      activePhraseAbort = new AbortController();
      const signal = AbortSignal.any([speechLifetime.signal, activePhraseAbort.signal]);
      synthesizeSpeech(current.text, { provider: ttsProvider, voicePreset, env, signal }).then(data => {
        ttsLineHandler(JSON.stringify({ type: 'audio', id: current.id, data }));
      }).catch(() => {
        if (!closed) ttsLineHandler(JSON.stringify({ type: 'error', id: current.id, error: 'Speech synthesis failed. Check provider access and retry.' }));
      }).finally(() => { activePhraseAbort = undefined; if (!closed) ttsLineHandler(JSON.stringify({ type: 'done', id: current.id })); });
      return;
    }
    if (!tts?.stdin.writable) return fail('Kokoro is not available');
    tts.stdin.write(`${JSON.stringify(activePhrase)}\n`);
    clearTimeout(activePhraseTimer);
    activePhraseTimer = setTimeout(() => fail('Kokoro did not finish speech synthesis. Reconnect voice to retry.'), 30000);
    activePhraseTimer.unref();
  }
  function phrase(text, token, responseId) {
    if (!text.trim() || closed || token !== turn) return;
    if (phrases.length >= 12) throw new Error('Speech queue is full; shorten the response');
    phrases.push({ id: `${sessionId}:${token}:${randomUUID()}`, text: text.trim().slice(0, 500), token, responseId, ...(voicePreset ? { voice: voicePreset.kokoro, speed: voicePreset.speed, pitch: voicePreset.pitch } : {}) });
    pump();
  }
  function finishResponse(responseId) {
    const response = responses.get(responseId);
    if (!response || response.ended || !response.generationDone) return;
    if (activePhrase?.responseId === responseId || phrases.some(item => item.responseId === responseId)) return;
    response.ended = true;
    send({ type: 'response_end', responseId, playable: isVoiceResponsePlayable(response) });
    response.playbackTimer = setTimeout(() => {
      if (!responses.has(responseId)) return;
      responses.delete(responseId);
      send({ type: 'error', message: 'Audio playback did not finish.' });
      send({ type: 'state', state: 'listening' });
      pumpAnnouncements();
    }, 30000);
    response.playbackTimer.unref();
  }
  function queueAnnouncement(text, { transcript = false, notificationId } = {}) {
    if (closed) return;
    announcementQueue.push({ text: spokenSummary(text), transcript, notificationId });
    pumpAnnouncements();
  }
  function pumpAnnouncements() {
    if (closed || recognizing || generating || activePhrase || phrases.length || announcementQueue.length === 0) return;
    if ([...responses.values()].some(response => response.ended) || Date.now() - lastSpeechAt < 600) return;
    const announcement = announcementQueue.shift();
    const responseId = randomUUID();
    const token = turn;
    responses.set(responseId, { token, generationDone: true, ended: false, audioSent: false, synthesisFailed: false, announcement });
    if (announcement.transcript) send({ type: 'transcript', role: 'assistant', text: announcement.text, partial: false });
    send({ type: 'state', state: 'speaking' });
    phrase(announcement.text, token, responseId);
    finishResponse(responseId);
  }
  async function reply(text) {
    interrupt();
    const token = turn;
    const responseId = randomUUID();
    controller = new AbortController();
    const signal = controller.signal;
    generating = true;
    messages.push({ role: 'user', content: text });
    messages.splice(0, Math.max(0, messages.length - 12));
    let transcriptText = '';
    let speechBuffer = '';
    responses.set(responseId, { token, generationDone: false, ended: false, audioSent: false, synthesisFailed: false });
    const flushSpeech = final => {
      const drained = drainVoiceText(speechBuffer, final);
      speechBuffer = drained.remainder;
      for (const chunk of drained.chunks) phrase(chunk, token, responseId);
    };
    send({ type: 'state', state: 'thinking' });
    try {
      for await (const event of streamReply({ provider, model, messages, callTool, signal, requestId: `${sessionId}:${token}`, env, profile: 'voice', persona })) {
        if (closed || signal.aborted || turn !== token) return;
        if (event.type === 'tool') send(event);
        if (event.type !== 'text') continue;
        transcriptText += event.text;
        speechBuffer += event.text;
        flushSpeech(false);
        if (transcriptText.trim()) send({ type: 'transcript', turnId: responseId, role: 'assistant', text: transcriptText.trim(), partial: true });
      }
      if (turn !== token || signal.aborted || closed) return;
      flushSpeech(true);
      messages.push({ role: 'assistant', content: transcriptText.trim() });
      messages.splice(0, Math.max(0, messages.length - 12));
      responses.get(responseId).generationDone = true;
      send({ type: 'transcript', turnId: responseId, role: 'assistant', text: transcriptText.trim(), partial: false });
      finishResponse(responseId);
    } catch (error) {
      if (!signal.aborted && !closed) {
        const response = responses.get(responseId);
        if (response) response.generationDone = true;
        finishResponse(responseId);
        send({ type: 'error', message: error.message });
      }
    }
    finally {
      if (turn === token) {
        generating = false;
        finishResponse(responseId);
        pumpAnnouncements();
      }
    }
  }
  try {
    ttsLineHandler = line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!activePhrase || event.id !== activePhrase.id) return;
      const current = activePhrase.token === turn;
      if (event.type === 'audio' && current && !closed && typeof event.data === 'string' && event.data.length > 0) {
        const response = responses.get(activePhrase.responseId);
        if (response) response.audioSent = true;
        send({ type: 'audio', data: event.data, mimeType: 'audio/pcm', sampleRate: 24000, responseId: activePhrase.responseId });
      }
      if (event.type === 'error' && current) {
        const response = responses.get(activePhrase.responseId);
        if (response) response.synthesisFailed = true;
        send({ type: 'error', message: event.error });
      }
      if (event.type === 'done') {
        const responseId = activePhrase.responseId;
        clearTimeout(activePhraseTimer);
        activePhrase = null;
        pump();
        finishResponse(responseId);
        pumpAnnouncements();
      }
    };
    if (ttsProvider === 'local') {
      const runtime = await getKokoroRuntime(config, env);
      tts = runtime.process;
      ttsReader = runtime.reader;
      ttsReader.on('line', ttsLineHandler);
      ttsExitHandler = () => { if (!closed) fail('Kokoro stopped unexpectedly'); };
      tts.once('exit', ttsExitHandler);
    }
    const onTranscription = event => {
      if (closed) return;
      if (event.type === 'error') {
        if (event.fatal !== false) return fail(event.message || 'Speech recognition failed');
        recognizing = false;
        send({ type: 'error', message: event.message });
        send({ type: 'state', state: 'listening' });
        return;
      }
      if (event.type === 'speech_start') {
        latestSpeechId = event.utterance_id;
        recognizing = true;
        lastSpeechAt = Date.now();
        interrupt();
        send({ type: 'state', state: 'listening' });
      }
      if (event.utterance_id === latestSpeechId && ['decoding', 'no_speech'].includes(event.type)) {
        recognizing = event.type === 'decoding';
        send({ type: 'state', state: event.type === 'decoding' ? 'thinking' : 'listening' });
        if (!recognizing) pumpAnnouncements();
      }
      const text = String(event.text || '').trim();
      if (event.type === 'final' && event.utterance_id === latestSpeechId) {
        recognizing = false;
        if (finalized.has(event.utterance_id)) {
          send({ type: 'state', state: 'listening' });
          pumpAnnouncements();
        }
      }
      if (event.type === 'partial' && text) {
        lastSpeechAt = Date.now();
        if (generating || phrases.length || activePhrase?.token === turn) interrupt();
        send({ type: 'transcript', role: 'user', text, partial: true });
      }
      if (event.type === 'final' && text && event.utterance_id !== undefined && !finalized.has(event.utterance_id)) {
        finalized.add(event.utterance_id);
        if (finalized.size > 1000) finalized.delete(finalized.values().next().value);
        if (latestSpeechId !== undefined && latestSpeechId !== event.utterance_id) {
          send({ type: 'error', message: 'Earlier speech was superseded by a new utterance before recognition finished. Repeat it if still needed.' });
          return;
        }
        recognizing = false;
        send({ type: 'transcript', role: 'user', text, partial: false });
        if (event.t1 - event.t0 > 55) { send({ type: 'error', message: 'Long utterance reached the STT cap. Please repeat a shorter complete request.' }); return; }
        void reply(text);
      }
    };
    if (sttProvider === 'local') {
      const sttRuntime = await claimSttRuntime(config, env);
      stt = sttRuntime.process;
      stt.on('error', error => fail(`${sttRuntime.name} failed: ${error.message}`));
      stt.on('exit', code => { if (!closed) fail(`${sttRuntime.name} exited (${code}): ${sttRuntime.diagnostic()}`); });
      pcmWriter = createSttWriter(stt.stdin, config.sttProvider, fail);
      const transcription = sttRuntime.transcription;
      readers.push(transcription);
      transcription.on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        onTranscription(event);
      });
    } else {
      pcmWriter = createCloudRecognizer({ provider: sttProvider, env, onEvent: onTranscription });
    }
    if (closed) throw new Error('Local voice startup was interrupted');
    send({ type: 'ready' });
    return {
      audio(base64) {
        if (closed) return;
        pcmWriter.write(Buffer.from(base64, 'base64'));
      },
      commit() { if (!closed) pcmWriter.commit(); },
      interrupt() {
        if (recognizing && latestSpeechId !== undefined) finalized.add(latestSpeechId);
        interrupt();
      },
      playbackDone(responseId) {
        const response = responses.get(responseId);
        if (!response?.ended) return;
        clearTimeout(response.playbackTimer);
        responses.delete(responseId);
        send({ type: 'state', state: 'listening' });
        pumpAnnouncements();
      },
      notify(text, notificationId) {
        if (closed || !text?.trim()) return false;
        if (notificationId && acceptedNotifications.has(notificationId)) {
          return true;
        }
        if (notificationId) {
          acceptedNotifications.add(notificationId);
          if (acceptedNotifications.size > 1000) acceptedNotifications.delete(acceptedNotifications.values().next().value);
        }
        queueAnnouncement(text, { notificationId });
        return true;
      },
      close,
    };
  } catch (error) { close(); throw error; }
}