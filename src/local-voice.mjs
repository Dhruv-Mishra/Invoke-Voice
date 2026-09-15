import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { streamReply } from './llm.mjs';

const worker = fileURLToPath(new URL('../scripts/kokoro_worker.py', import.meta.url));
export function localConfiguration(env = process.env) {
  const home = path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VoiceSupervisor');
  const modelDir = env.MODEL_DIR || path.join(home, 'models');
  const runtimeDir = env.RUNTIME_DIR || path.join(home, 'runtimes');
  const crispasrBin = env.CRISPASR_BIN || path.join(runtimeDir, 'crispasr.exe');
  const moonshineModel = env.MOONSHINE_MODEL || path.join(modelDir, 'moonshine-streaming-tiny-q4_k.gguf');
  const vadModel = env.VAD_MODEL || path.join(modelDir, 'ggml-silero-v6.2.0.bin');
  const sttConfigured = [crispasrBin, moonshineModel, path.join(path.dirname(moonshineModel), 'tokenizer.bin'), vadModel].every(existsSync);
  return { configured: sttConfigured && env.KOKORO_READY === '1', sttConfigured, ttsConfigured: env.KOKORO_READY === '1', crispasrBin, moonshineModel, vadModel, model: env.LOCAL_LLM_MODEL || 'ling-local', sttStreamingArchitecture: 'CrispASR rolling-window streaming' };
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
  let activePhrase;
  let lastSpeechAt = 0;
  const phrases = [];
  const messages = [];
  const finalized = new Set();
  const readers = [];
  const close = () => { closed = true; controller?.abort(); phrases.length = 0; readers.forEach(reader => reader.close()); stt?.kill(); tts?.kill(); };
  const fail = message => { if (!closed) send({ type: 'error', message, fatal: true }); close(); };
  function interrupt() {
    turn += 1;
    controller?.abort();
    generating = false;
    phrases.length = 0;
    send({ type: 'interrupted' });
  }
  function pump() {
    if (closed || activePhrase || !phrases.length) return;
    activePhrase = phrases.shift();
    tts.stdin.write(`${JSON.stringify(activePhrase)}\n`);
  }
  function phrase(text, token) {
    if (!text.trim() || closed || token !== turn) return;
    if (phrases.length >= 12) throw new Error('Speech queue is full; shorten the response');
    phrases.push({ id: `${token}:${randomUUID()}`, text: text.trim().slice(0, 500) });
    pump();
  }
  async function reply(text) {
    interrupt();
    const token = turn;
    controller = new AbortController();
    const signal = controller.signal;
    generating = true;
    messages.push({ role: 'user', content: text });
    messages.splice(0, Math.max(0, messages.length - 12));
    let complete = '';
    let pending = '';
    send({ type: 'state', state: 'thinking' });
    try {
      for await (const event of streamReply({ provider, model, messages, callTool, signal, requestId: `${sessionId}:${token}`, env })) {
        if (closed || signal.aborted || turn !== token) return;
        if (event.type === 'text') {
          complete += event.text;
          pending += event.text;
          send({ type: 'transcript', role: 'assistant', text: complete, partial: true });
          const boundary = pending.match(/^(.{25,100}?[.!?,;:]\s|.{70,110}\s)/s);
          if (boundary) { phrase(boundary[0], token); pending = pending.slice(boundary[0].length); }
        } else if (event.type === 'tool') send(event);
      }
      if (turn !== token || signal.aborted || closed) return;
      phrase(pending, token);
      messages.push({ role: 'assistant', content: complete });
      send({ type: 'transcript', role: 'assistant', text: complete, partial: false });
    } catch (error) { if (!signal.aborted && !closed) send({ type: 'error', message: error.message }); }
    finally { if (turn === token) generating = false; }
  }
  try {
    tts = spawn(env.PYTHON_BIN || 'python', ['-u', worker], { windowsHide: true, env: { ...env, LOCAL_THREADS: env.LOCAL_THREADS || '4' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostic = '';
    tts.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-1000); });
    tts.stdin.on('error', () => fail('Kokoro input pipe closed'));
    const reader = createInterface({ input: tts.stdout });
    readers.push(reader);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kokoro startup exceeded 45s. Run its warm-up command first.')), 45000);
      const rejectStartup = error => { clearTimeout(timer); reject(error); };
      tts.once('error', error => rejectStartup(new Error(`Kokoro failed to start: ${error.message}`)));
      tts.once('exit', code => rejectStartup(new Error(`Kokoro exited (${code}). ${diagnostic}`)));
      reader.on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'ready') { clearTimeout(timer); resolve(); return; }
        if (!activePhrase || event.id !== activePhrase.id) return;
        const current = event.id.startsWith(`${turn}:`);
        if (event.type === 'audio' && current && !closed) send({ type: 'audio', data: event.data, mimeType: 'audio/pcm', sampleRate: 24000 });
        if (event.type === 'error' && current) send({ type: 'error', message: event.error });
        if (event.type === 'done') { activePhrase = null; pump(); if (!generating && !phrases.length) send({ type: 'state', state: 'listening' }); }
      });
    });
    tts.on('exit', () => { if (!closed) fail('Kokoro stopped unexpectedly'); });
    stt = spawn(config.crispasrBin, ['--backend', 'moonshine-streaming', '-m', config.moonshineModel, '--stream', '--stream-json', '--vad', '--vad-model', config.vadModel, '--stream-step', env.CRISPASR_STREAM_STEP_MS || '500', '--stream-length', '10000', '--stream-final-on-silence-ms', env.END_SILENCE_MS || '800', '-t', env.LOCAL_THREADS || '4'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let sttDiagnostic = '';
    stt.stderr.on('data', chunk => { sttDiagnostic = (sttDiagnostic + chunk.toString()).slice(-1000); });
    stt.on('error', error => fail(`CrispASR failed: ${error.message}`));
    stt.on('exit', code => { if (!closed) fail(`CrispASR exited (${code}): ${sttDiagnostic}`); });
    stt.stdin.on('error', () => fail('CrispASR input pipe closed'));
    const transcription = createInterface({ input: stt.stdout });
    readers.push(transcription);
    transcription.on('line', line => {
      if (closed) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const text = String(event.text || '').trim();
      if (event.type === 'partial' && text) {
        lastSpeechAt = Date.now();
        if (generating || phrases.length || activePhrase?.id.startsWith(`${turn}:`)) interrupt();
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
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CrispASR did not process startup audio within 30s')), 30000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      transcription.once('line', () => finish());
      stt.once('error', finish);
      stt.once('exit', code => finish(new Error(`CrispASR stopped during startup (${code})`)));
      stt.stdin.write(Buffer.alloc(32000));
    });
    if (closed) throw new Error('Local voice startup was interrupted');
    send({ type: 'ready' });
    return {
      audio(base64) {
        if (closed) return;
        if (stt.stdin.writableLength > 32000 * 3) return fail('STT cannot keep up with microphone audio; increase the stream step');
        stt.stdin.write(Buffer.from(base64, 'base64'));
      },
      commit() { if (!closed) stt.stdin.write(Buffer.alloc(32000 * 2)); },
      interrupt,
      notify(text) { if (closed || generating || activePhrase || phrases.length || Date.now() - lastSpeechAt < 2000) return; turn += 1; phrase(text, turn); },
      close,
    };
  } catch (error) { close(); throw error; }
}