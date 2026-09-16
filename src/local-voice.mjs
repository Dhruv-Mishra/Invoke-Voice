import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { streamReply } from './llm.mjs';

const worker = fileURLToPath(new URL('../scripts/kokoro_worker.py', import.meta.url));
const bundledPython = fileURLToPath(new URL('../.venv/Scripts/python.exe', import.meta.url));
const defaultMoonshineModel = fileURLToPath(new URL('../../LocalVoiceStack/STT_Models/moonshine-streaming-small-q4_k.gguf', import.meta.url));
let kokoroRuntimePromise;
let crispRuntimePromise;

async function startKokoroRuntime(config, env) {
  const process = spawn(config.pythonBin, ['-u', worker], { windowsHide: true, env: { ...env, LOCAL_THREADS: env.KOKORO_THREADS || env.LOCAL_THREADS || '8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  process.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-1000); });
  process.stdin.on('error', () => {});
  const reader = createInterface({ input: process.stdout });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kokoro startup exceeded 45s. Run its warm-up command first.')), 45000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
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
    process.kill();
    throw error;
  }
  return { process, reader };
}

function getKokoroRuntime(config, env) {
  if (!kokoroRuntimePromise) {
    const pending = startKokoroRuntime(config, env);
    kokoroRuntimePromise = pending;
    pending.then(runtime => {
      runtime.process.once('exit', () => { if (kokoroRuntimePromise === pending) kokoroRuntimePromise = undefined; });
    }).catch(() => { if (kokoroRuntimePromise === pending) kokoroRuntimePromise = undefined; });
  }
  return kokoroRuntimePromise;
}

async function startCrispRuntime(config, env) {
  const process = spawn(config.crispasrBin, localSttArguments(config, env), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  process.stdin.on('error', () => {});
  const transcription = createInterface({ input: process.stdout });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CrispASR did not become ready within 30s')), 30000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      process.stderr.on('data', chunk => {
        diagnostic = (diagnostic + chunk.toString()).slice(-1000);
        if (diagnostic.includes('reading raw s16le 16kHz mono PCM from stdin')) finish();
      });
      process.once('error', error => finish(new Error(`CrispASR failed: ${error.message}`)));
      process.once('exit', code => finish(new Error(`CrispASR stopped during startup (${code}): ${diagnostic}`)));
    });
  } catch (error) {
    transcription.close();
    process.kill();
    throw error;
  }
  return { process, transcription, diagnostic: () => diagnostic };
}

function getCrispRuntime(config, env) {
  if (!crispRuntimePromise) {
    const pending = startCrispRuntime(config, env);
    crispRuntimePromise = pending;
    pending.then(runtime => {
      runtime.process.once('exit', () => { if (crispRuntimePromise === pending) crispRuntimePromise = undefined; });
    }).catch(() => { if (crispRuntimePromise === pending) crispRuntimePromise = undefined; });
  }
  return crispRuntimePromise;
}

async function claimCrispRuntime(config, env) {
  const pending = getCrispRuntime(config, env);
  if (crispRuntimePromise === pending) crispRuntimePromise = undefined;
  const runtime = await pending;
  if (runtime.process.exitCode !== null) throw new Error(`CrispASR stopped before the voice session started (${runtime.process.exitCode})`);
  return runtime;
}

export async function warmLocalVoice(env = process.env) {
  const config = localConfiguration(env);
  const warmups = [];
  if (config.ttsConfigured) warmups.push(getKokoroRuntime(config, env));
  if (config.sttConfigured) warmups.push(getCrispRuntime(config, env));
  await Promise.all(warmups);
  return warmups.length > 0;
}

export function localConfiguration(env = process.env) {
  const home = path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VoiceSupervisor');
  const modelDir = env.MODEL_DIR || path.join(home, 'models');
  const runtimeDir = env.RUNTIME_DIR || path.join(home, 'runtimes');
  const crispasrBin = env.CRISPASR_BIN || path.join(runtimeDir, 'crispasr.exe');
  const requestedMoonshineModel = env.MOONSHINE_MODEL ? path.resolve(env.MOONSHINE_MODEL) : defaultMoonshineModel;
  const unsupportedQ8 = path.basename(requestedMoonshineModel).toLowerCase() === 'moonshine-streaming-small-q8_0.gguf';
  const moonshineModel = unsupportedQ8 && existsSync(defaultMoonshineModel) ? defaultMoonshineModel : requestedMoonshineModel;
  const sttWarning = unsupportedQ8 && moonshineModel !== requestedMoonshineModel ? 'Small Q8_0 crashes CrispASR 0.8.32; using canonical Small Q4_K.' : null;
  const siblingTokenizer = path.join(path.dirname(moonshineModel), 'tokenizer.bin');
  const moonshineTokenizer = existsSync(siblingTokenizer) ? siblingTokenizer : path.join(modelDir, 'tokenizer.bin');
  const vadModel = env.VAD_MODEL || path.join(modelDir, 'ggml-silero-v6.2.0.bin');
  const sttConfigured = [crispasrBin, moonshineModel, moonshineTokenizer, vadModel].every(existsSync);
  const pythonBin = (!env.PYTHON_BIN || env.PYTHON_BIN === 'python') && existsSync(bundledPython) ? bundledPython : (env.PYTHON_BIN || 'python');
  const ttsConfigured = existsSync(pythonBin) || env.KOKORO_READY === '1';
  return { configured: sttConfigured && ttsConfigured, sttConfigured, ttsConfigured, pythonBin, crispasrBin, requestedMoonshineModel, moonshineModel, moonshineTokenizer, sttWarning, vadModel, model: env.LOCAL_LLM_MODEL || 'ling-local', ttsModel: env.KOKORO_REPO || 'hexgrad/Kokoro-82M', ttsVoice: env.KOKORO_VOICE || 'af_heart', sttStreamingArchitecture: 'CrispASR rolling-window streaming' };
}

export function localSttArguments(config, env = process.env) {
  return ['--backend', 'moonshine-streaming', '-m', config.moonshineModel, '--cache-dir', path.dirname(config.moonshineTokenizer), '--stream', '--stream-json', '--vad', '--vad-model', config.vadModel, '--stream-step', env.CRISPASR_STREAM_STEP_MS || '500', '--stream-length', env.CRISPASR_STREAM_LENGTH_MS || '8000', '--stream-partial-decode-ms', env.CRISPASR_PARTIAL_DECODE_MS || '1000', '--stream-partial-tail-sec', env.CRISPASR_PARTIAL_TAIL_SEC || '6', '--stream-final-on-silence-ms', env.END_SILENCE_MS || '500', '--stream-final-mode', env.CRISPASR_FINAL_MODE || 'prefix', '-t', env.CRISPASR_THREADS || env.LOCAL_THREADS || '12'];
}

export function parseVoiceResponse(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(SAY|ACTION)\s*:\s*([\s\S]*)$/i);
  if (!match) return { route: 'say', text: raw || 'Okay.' };
  return { route: match[1].toLowerCase(), text: match[2].trim() || 'Okay.' };
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

export function retryPlaybackAction(action) {
  if (!action || (action.playbackRetries || 0) >= 1) return null;
  return { ...action, playbackRetries: (action.playbackRetries || 0) + 1 };
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

export async function createLocalVoice({ send, callTool, provider = 'local', model, allowCloud = false, env = process.env }) {
  if (provider !== 'local' && !allowCloud) throw new Error('Enable hybrid consent to send local speech transcripts to a cloud LLM');
  const config = localConfiguration(env);
  if (!config.sttConfigured) throw new Error('Install CrispASR, Moonshine Q4_K, tokenizer and Silero VAD with npm run models');
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
  let lastSpeechAt = 0;
  let sttBackpressured = false;
  let reportedBackpressure = false;
  let plannerRunning = false;
  const phrases = [];
  const messages = [];
  const finalized = new Set();
  const readers = [];
  const responses = new Map();
  const actionQueue = [];
  const pendingActions = new Map();
  const plannerControllers = new Set();
  const announcementQueue = [];
  const acceptedNotifications = new Set();
  const announcementTimer = setInterval(() => pumpAnnouncements(), 250);
  announcementTimer.unref();
  const close = () => {
    closed = true;
    controller?.abort();
    for (const plannerController of plannerControllers) plannerController.abort();
    clearInterval(announcementTimer);
    phrases.length = 0;
    actionQueue.length = 0;
    announcementQueue.length = 0;
    responses.clear();
    pendingActions.clear();
    readers.forEach(reader => reader.close());
    if (ttsReader && ttsLineHandler) ttsReader.off('line', ttsLineHandler);
    if (tts && ttsExitHandler) tts.off('exit', ttsExitHandler);
    stt?.kill();
  };
  const fail = message => { if (!closed) send({ type: 'error', message, fatal: true }); close(); };
  function interrupt() {
    const interruptedToken = turn;
    const hadActivity = generating || responses.size > 0 || phrases.some(item => item.token === interruptedToken) || activePhrase?.token === interruptedToken;
    turn += 1;
    controller?.abort();
    generating = false;
    for (let index = phrases.length - 1; index >= 0; index -= 1) {
      if (phrases[index].token === interruptedToken) phrases.splice(index, 1);
    }
    for (const [responseId, response] of responses) {
      if (response.token !== interruptedToken || response.ended) continue;
      if (response.announcement) announcementQueue.unshift({ ...response.announcement, transcript: false });
      pendingActions.delete(responseId);
      responses.delete(responseId);
    }
    if (hadActivity) send({ type: 'interrupted' });
  }
  function pump() {
    if (closed || activePhrase || !phrases.length) return;
    activePhrase = phrases.shift();
    if (!tts?.stdin.writable) return fail('Kokoro is not available');
    tts.stdin.write(`${JSON.stringify(activePhrase)}\n`);
  }
  function phrase(text, token, responseId) {
    if (!text.trim() || closed || token !== turn) return;
    if (phrases.length >= 12) throw new Error('Speech queue is full; shorten the response');
    phrases.push({ id: `${sessionId}:${token}:${randomUUID()}`, text: text.trim().slice(0, 500), token, responseId });
    pump();
  }
  function finishResponse(responseId) {
    const response = responses.get(responseId);
    if (!response || response.ended || !response.generationDone) return;
    if (activePhrase?.responseId === responseId || phrases.some(item => item.responseId === responseId)) return;
    response.ended = true;
    send({ type: 'response_end', responseId, playable: isVoiceResponsePlayable(response) });
  }
  function queueAnnouncement(text, { transcript = false, notificationId, action } = {}) {
    if (closed) return;
    announcementQueue.push({ text: spokenSummary(text), transcript, notificationId, action });
    pumpAnnouncements();
  }
  function pumpAnnouncements() {
    if (closed || generating || activePhrase || phrases.length || announcementQueue.length === 0) return;
    if ([...responses.values()].some(response => response.ended) || Date.now() - lastSpeechAt < 600) return;
    const announcement = announcementQueue.shift();
    const responseId = randomUUID();
    const token = turn;
    responses.set(responseId, { token, generationDone: true, ended: false, audioSent: false, synthesisFailed: false, announcement });
    if (announcement.action) pendingActions.set(responseId, announcement.action);
    if (announcement.transcript) send({ type: 'transcript', role: 'assistant', text: announcement.text, partial: false });
    send({ type: 'state', state: 'speaking' });
    phrase(announcement.text, token, responseId);
    finishResponse(responseId);
  }
  function queueAction(action) {
    if (actionQueue.length >= 8) {
      queueAnnouncement('I could not queue another action yet. Please try again.', { transcript: true });
      return;
    }
    actionQueue.push(action);
    void pumpActions();
  }
  async function pumpActions() {
    if (closed || plannerRunning || actionQueue.length === 0) return;
    plannerRunning = true;
    const action = actionQueue.shift();
    const plannerController = new AbortController();
    plannerControllers.add(plannerController);
    let complete = '';
    try {
      for await (const event of streamReply({ provider, model, messages: action.context, callTool, signal: plannerController.signal, requestId: `${sessionId}:action:${action.id}`, env })) {
        if (closed || plannerController.signal.aborted) return;
        if (event.type === 'text') complete += event.text;
        else if (event.type === 'tool') send(event);
      }
      queueAnnouncement(complete || 'The action finished.', { transcript: true });
    } catch (error) {
      if (!closed && !plannerController.signal.aborted) {
        send({ type: 'error', message: `Background action failed: ${error.message}` });
        queueAnnouncement('I could not complete that action.', { transcript: true });
      }
    } finally {
      plannerControllers.delete(plannerController);
      plannerRunning = false;
      if (!closed) void pumpActions();
    }
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
    let raw = '';
    let streamRoute;
    let speechBuffer = '';
    responses.set(responseId, { token, generationDone: false, ended: false, audioSent: false, synthesisFailed: false });
    const flushSpeech = final => {
      const drained = drainVoiceText(speechBuffer, final);
      speechBuffer = drained.remainder;
      for (const chunk of drained.chunks) phrase(chunk, token, responseId);
    };
    send({ type: 'state', state: 'thinking' });
    try {
      for await (const event of streamReply({ provider, model, messages, signal, requestId: `${sessionId}:${token}`, env, profile: 'voice-fast' })) {
        if (closed || signal.aborted || turn !== token) return;
        if (event.type !== 'text') continue;
        raw += event.text;
        if (!streamRoute) {
          const prefix = raw.match(/^\s*(SAY|ACTION)\s*:\s*/i);
          if (prefix) {
            streamRoute = prefix[1].toLowerCase();
            speechBuffer = raw.slice(prefix[0].length);
          }
        } else {
          speechBuffer += event.text;
        }
        if (streamRoute) flushSpeech(false);
      }
      if (turn !== token || signal.aborted || closed) return;
      const response = parseVoiceResponse(raw);
      if (!streamRoute) speechBuffer = response.text;
      flushSpeech(true);
      messages.push({ role: 'assistant', content: response.text });
      messages.splice(0, Math.max(0, messages.length - 12));
      responses.get(responseId).generationDone = true;
      if (response.route === 'action') pendingActions.set(responseId, { id: responseId, text, context: messages.slice(-6) });
      send({ type: 'transcript', role: 'assistant', text: response.text, partial: false });
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
    const runtime = await getKokoroRuntime(config, env);
    tts = runtime.process;
    ttsReader = runtime.reader;
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
        activePhrase = null;
        pump();
        finishResponse(responseId);
        pumpAnnouncements();
      }
    };
    ttsReader.on('line', ttsLineHandler);
    ttsExitHandler = () => { if (!closed) fail('Kokoro stopped unexpectedly'); };
    tts.once('exit', ttsExitHandler);
    const sttRuntime = await claimCrispRuntime(config, env);
    stt = sttRuntime.process;
    stt.on('error', error => fail(`CrispASR failed: ${error.message}`));
    stt.on('exit', code => { if (!closed) fail(`CrispASR exited (${code}): ${sttRuntime.diagnostic()}`); });
    stt.stdin.on('error', () => fail('CrispASR input pipe closed'));
    stt.stdin.on('drain', () => { sttBackpressured = false; });
    const transcription = sttRuntime.transcription;
    readers.push(transcription);
    transcription.on('line', line => {
      if (closed) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const text = String(event.text || '').trim();
      if (event.type === 'partial' && text) {
        lastSpeechAt = Date.now();
        if (generating || phrases.length || activePhrase?.token === turn) interrupt();
        send({ type: 'transcript', role: 'user', text, partial: true });
      }
      if (event.type === 'final' && text && event.utterance_id !== undefined && !finalized.has(event.utterance_id)) {
        finalized.add(event.utterance_id);
        if (finalized.size > 1000) finalized.delete(finalized.values().next().value);
        send({ type: 'transcript', role: 'user', text, partial: false });
        if (event.t1 - event.t0 > 55) { send({ type: 'error', message: 'Long utterance reached the STT cap. Please repeat a shorter complete request.' }); return; }
        void reply(text);
      }
    });
    if (closed) throw new Error('Local voice startup was interrupted');
    send({ type: 'ready' });
    return {
      audio(base64) {
        if (closed) return;
        if (sttBackpressured) {
          if (!reportedBackpressure) send({ type: 'error', message: 'Speech recognition briefly fell behind; keep speaking and it will recover.' });
          reportedBackpressure = true;
          return;
        }
        sttBackpressured = !stt.stdin.write(Buffer.from(base64, 'base64'));
      },
      commit() { if (!closed) stt.stdin.write(Buffer.alloc(32000 * 2)); },
      interrupt,
      playbackDone(responseId, outcome) {
        const response = responses.get(responseId);
        if (!response?.ended) return;
        responses.delete(responseId);
        const action = pendingActions.get(responseId);
        pendingActions.delete(responseId);
        if (outcome === 'played' && action) queueAction(action);
        if (outcome === 'interrupted' && response.announcement && !action) announcementQueue.unshift({ ...response.announcement, transcript: false });
        if (outcome === 'failed' && action) {
          const retry = retryPlaybackAction(action);
          if (retry) queueAnnouncement('I will try that now.', { transcript: true, action: retry });
          else send({ type: 'error', message: 'The action was not started because acknowledgement audio failed twice.' });
        }
        if (outcome === 'played' && response.announcement?.notificationId) send({ type: 'notify_ack', notificationId: response.announcement.notificationId });
        if (outcome === 'failed' && response.announcement?.notificationId) acceptedNotifications.delete(response.announcement.notificationId);
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