import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createCloudRecognizer, pcmWave, synthesizeSpeech, transcribeSpeech, validateSpeechPipeline } from '../src/speech-pipeline.mjs';
import { createLocalVoice } from '../src/local-voice.mjs';

test('dedicated pipeline validates every stage and requires cloud consent', () => {
  const env = { OPENAI_API_KEY: 'fixture', GEMINI_API_KEY: 'fixture' };
  validateSpeechPipeline({}, {});
  for (const stage of ['provider', 'sttProvider', 'ttsProvider']) {
    assert.throws(() => validateSpeechPipeline({ [stage]: 'custom', allowCloud: true }, env), /Unsupported/);
    assert.throws(() => validateSpeechPipeline({ [stage]: 'openai' }, env), /cloud processing/);
    assert.throws(() => validateSpeechPipeline({ [stage]: 'openai', allowCloud: true }, {}), /API key/);
    validateSpeechPipeline({ [stage]: 'gemini', allowCloud: true }, env);
  }
});

test('hosted speech keeps the mono 16kHz input and 24kHz PCM output contract', async context => {
  const pcm = Buffer.alloc(3200, 1);
  const wave = pcmWave(pcm);
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.readUInt32LE(24), 16000);
  assert.equal(wave.readUInt16LE(22), 1);
  assert.deepEqual(wave.subarray(44), pcm);
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return url.endsWith('/transcriptions') ? Response.json({ text: 'Hello there' }) : new Response(pcm);
  });
  const options = { provider: 'openai', env: { OPENAI_API_KEY: 'fixture' } };
  assert.equal(await transcribeSpeech(pcm, options), 'Hello there');
  assert.equal(requests[0].options.body.get('file').type, 'audio/wav');
  assert.equal(await synthesizeSpeech('Hello', options), pcm.toString('base64'));
  assert.equal(JSON.parse(requests[1].options.body).response_format, 'pcm');
});

test('hosted recognition commits once at silence, bounds input and cancels on close', async () => {
  const events = [];
  const calls = [];
  let finish;
  const recognizer = createCloudRecognizer({ provider: 'openai', onEvent: event => events.push(event), transcribe: (pcm, options) => {
    calls.push({ pcm, options });
    return new Promise(resolve => { finish = resolve; });
  } });
  const speech = Buffer.alloc(3200);
  for (let index = 0; index < speech.length; index += 2) speech.writeInt16LE(2000, index);
  recognizer.write(Buffer.alloc(32000));
  recognizer.write(speech);
  recognizer.write(Buffer.alloc(24000));
  recognizer.commit();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].pcm.length <= 9600 + 3200 + 24000);
  assert.deepEqual(events.map(event => event.type), ['speech_start', 'decoding']);
  finish('Hello');
  await setImmediate();
  assert.equal(events.at(-1).type, 'final');
  recognizer.write(speech);
  recognizer.commit();
  recognizer.dispose();
  assert.equal(calls.at(-1).options.signal.aborted, true);
  finish('Late text');
  await setImmediate();
  assert.equal(events.some(event => event.text === 'Late text'), false);
});

test('all-cloud dedicated voice starts without local speech runtimes or downloads', async () => {
  const events = [];
  const session = await createLocalVoice({ provider: 'openai', sttProvider: 'openai', ttsProvider: 'gemini', allowCloud: true,
    env: { OPENAI_API_KEY: 'fixture', GEMINI_API_KEY: 'fixture' }, send: event => events.push(event), callTool: async () => ({}) });
  try { assert.deepEqual(events, [{ type: 'ready' }]); }
  finally { session.close(); }
});

test('Google speech adapters preserve transcript and PCM responses and reject incompatible rates', async context => {
  const requests = [];
  let rate = 24000;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const parts = body.generationConfig?.responseModalities?.includes('AUDIO')
      ? [{ inlineData: { mimeType: `audio/L16;codec=pcm;rate=${rate}`, data: 'AAAAAA==' } }]
      : [{ text: 'A spoken request' }];
    return Response.json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
  });
  const options = { provider: 'gemini', env: { GEMINI_API_KEY: 'fixture' } };
  assert.equal(await transcribeSpeech(Buffer.alloc(3200), options), 'A spoken request');
  assert.equal(requests[0].contents[0].parts[0].inlineData.mimeType, 'audio/wav');
  assert.equal(await synthesizeSpeech('A response', options), 'AAAAAA==');
  rate = 48000;
  await assert.rejects(synthesizeSpeech('A response', options), /sample rate/);
});