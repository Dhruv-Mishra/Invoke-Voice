import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import VoiceSprite, { defaultAnimations } from '../public/VoiceSprite.js';
import { captionTiming, motionPreference, resolveTheme, themes } from '../public/themes.js';
import { createCaptionController } from '../public/captions/controller.js';
import { shouldForwardCapturedAudio } from '../public/voice-session.js';
import { createVoiceCaptionBridge } from '../public/captions/voice-bridge.js';

test('frontend browser preserves conversation contracts and responsive preferences', { timeout: 90000 }, async context => {
  const electronDirectory = path.dirname(fileURLToPath(import.meta.resolve('electron')));
  const pathFile = path.join(electronDirectory, 'path.txt');
  const electronPath = existsSync(pathFile) ? path.join(electronDirectory, 'dist', readFileSync(pathFile, 'utf8').trim()) : '';
  if (!electronPath || !existsSync(electronPath)) {
    context.skip('Electron binary is not installed; browser checks require the existing desktop runtime.');
    return;
  }
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    context.skip('Run npm run build before the production browser check.');
    return;
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [fileURLToPath(new URL('./frontend-browser.mjs', import.meta.url))], { env: environment, windowsHide: false });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Browser validation timed out\n${output}`)); }, 85000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Browser validation exited ${code}\n${output}`));
    });
  });
});

test('captions replace partials, ignore tools, expire and cannot be cleared by stale timers', () => {
  const updates = [];
  const pending = new Map();
  const cancelled = [];
  let sequence = 0;
  const captions = createCaptionController(value => updates.push(value), {
    setTimeout(callback, delay) {
      assert.ok([captionTiming.afterSpeech, captionTiming.fade].includes(delay) || (delay >= captionTiming.minimum && delay <= captionTiming.maximum));
      pending.set(++sequence, callback);
      return sequence;
    },
    clearTimeout(id) {
      if (pending.has(id)) cancelled.push(pending.get(id));
      pending.delete(id);
    },
  });
  const expireNext = () => {
    const [id, callback] = pending.entries().next().value;
    pending.delete(id);
    callback();
  };
  captions.update('user', 'Hello', true);
  assert.deepEqual(updates.at(-1), { role: 'user', text: 'Hello', partial: true });
  captions.update('user', 'Hello again');
  assert.equal(pending.size, 1);
  assert.equal(updates.at(-1).partial, false);
  cancelled[0]();
  assert.equal(updates.at(-1).text, 'Hello again');
  captions.update('assistant', '<img src=x onerror=alert(1)>');
  assert.equal(updates.at(-1).text, '<img src=x onerror=alert(1)>');
  for (const role of ['tool', 'system', 'unknown']) captions.update(role, 'Not a caption');
  captions.update('user', ' ');
  captions.update('user', null);
  assert.equal(updates.length, 3);
  captions.update('assistant', 'a'.repeat(1000));
  assert.equal(updates.at(-1).text, 'a'.repeat(1000));
  expireNext();
  assert.equal(updates.at(-1).fading, true);
  captions.pause(true);
  assert.equal(updates.at(-1).fading, false);
  assert.equal(pending.size, 0);
  cancelled.at(-1)();
  assert.equal(updates.at(-1).text.length, 1000);
  captions.update('assistant', 'Still readable');
  assert.equal(pending.size, 0);
  captions.pause(false);
  assert.equal(pending.size, 1);
  expireNext();
  assert.equal(updates.at(-1).fading, true);
  captions.update('assistant', 'New text cancels the fade');
  cancelled.at(-1)();
  assert.equal(updates.at(-1).text, 'New text cancels the fade');
  expireNext();
  expireNext();
  assert.equal(updates.at(-1), null);
  captions.update('user', 'Next session');
  captions.clear();
  assert.equal(pending.size, 0);
  for (const callback of cancelled) callback();
  assert.equal(updates.at(-1), null);
});

test('speaker captions retain separate text, fade and dismissal lifecycles', () => {
  const updates = new Map();
  const pending = new Map();
  const delays = [];
  let sequence = 0;
  const timers = {
    setTimeout(callback, delay) { delays.push(delay); pending.set(++sequence, callback); return sequence; },
    clearTimeout(id) { pending.delete(id); },
  };
  const user = createCaptionController(value => updates.set('user', value), timers);
  const assistant = createCaptionController(value => updates.set('assistant', value), timers);
  user.update('user', 'A complete question');
  assistant.update('assistant', 'First partial', true);
  assistant.update('assistant', 'Updated partial', true);
  assert.equal(updates.get('user').text, 'A complete question');
  assert.equal(updates.get('assistant').text, 'Updated partial');
  assistant.finish();
  assert.equal(delays.at(-1), captionTiming.afterSpeech);
  assert.equal([...pending.keys()].length, 2);
  const expire = pending.get(1);
  pending.delete(1);
  expire();
  assert.equal(updates.get('user').fading, true);
  assert.equal(updates.get('assistant').fading, undefined);
  assistant.clear();
  assert.equal(updates.get('assistant'), null);
  assert.equal(updates.get('user').text, 'A complete question');
  user.clear();
  assert.equal(pending.size, 0);
});

test('motion overrides validate persisted values and default to full motion', () => {
  for (const value of ['system', 'reduce', 'full']) assert.equal(motionPreference(value), value);
  for (const value of [null, undefined, '', 'false', 'invalid']) assert.equal(motionPreference(value), 'full');
  assert.ok(themes.some(theme => theme.id === 'jarvis' && theme.label === 'Jarvis'));
});

test('voice sprite renders each state with its animation and accessible label', async () => {
  for (const [state, animation] of Object.entries(defaultAnimations)) {
    const output = await renderToString(createSSRApp({
      render: () => h(VoiceSprite, { state, source: '/sprite.png' }),
    }));
    assert.ok(output.includes(`data-state="${state}"`));
    assert.ok(output.includes(`aria-label="Agent ${state}"`));
    assert.ok(output.includes(`animation-name:${animation}`));
    assert.ok(output.includes('src="/sprite.png"'));
    assert.equal(output.includes('class="voice-bars"'), false);
    assert.equal((output.match(/class="sprite-image"/g) || []).length, 1);
  }
});

test('Baymax renders only the face even with a legacy body variant', async () => {
  for (const variant of ['face', 'companion', 'default']) {
    const output = await renderToString(createSSRApp({
      render: () => h(VoiceSprite, { kind: 'companion', variant, source: '/face.webp' }),
    }));
    assert.equal((output.match(/<img/g) || []).length, 1);
    assert.ok(output.includes('companion-head') && output.includes('companion-eyes'));
    assert.doesNotMatch(output, /companion-(body|arm|foot|badge)/);
  }
});

test('themes resolve bounded variants and preserve the default', () => {
  assert.equal(resolveTheme('unknown').id, 'alpine');
  assert.equal(resolveTheme('alpine').tokens['--cp-font'], themes[0].tokens['--cp-font']);
  assert.equal(resolveTheme('jarvis', { sprite: 'palladium', wallpaper: 'skyline' }).spriteId, 'palladium');
  assert.equal(resolveTheme('jarvis', { sprite: '../bad', wallpaper: 'garden' }).wallpaperId, 'observatory');
  assert.equal(resolveTheme('baymax').kind, 'companion');
  assert.deepEqual(themes.map(theme => theme.id), ['alpine', 'jarvis', 'baymax']);
  assert.equal(resolveTheme('opal').id, 'alpine');
  assert.equal(resolveTheme('opal', { wallpaper: 'garden' }).spriteId, 'opal');
  assert.equal(resolveTheme('opal', { wallpaper: 'garden' }).wallpaperId, 'garden');
  assert.equal(resolveTheme('baymax', { sprite: 'companion' }).spriteId, 'face');
  assert.deepEqual(resolveTheme('baymax').sprites.map(sprite => sprite.id), ['face']);
  for (const theme of themes) {
    assert.equal(theme.wallpapers.length, 4);
    assert.deepEqual(theme.wallpapers.slice(2).map(wallpaper => wallpaper.id), ['white', 'black']);
    assert.equal(resolveTheme(theme.id, { wallpaper: 'black' }).preferences.colorScheme, 'dark');
    assert.equal(resolveTheme(theme.id, { wallpaper: 'white' }).preferences.colorScheme, 'light');
    for (const wallpaper of ['white', 'black']) {
      assert.equal(resolveTheme(theme.id, { wallpaper }).tokens['--cp-dock-radius'], theme.tokens['--cp-dock-radius']);
      assert.equal(resolveTheme(theme.id, { wallpaper }).tokens['--cp-dock-accent'], theme.tokens['--cp-dock-accent']);
    }
    assert.ok(theme.sounds.bootup && theme.sounds.action);
    for (const variant of [...theme.wallpapers, ...theme.sprites]) assert.ok(existsSync(new URL(variant.source)));
    for (const source of Object.values(theme.sounds)) if (source) assert.ok(existsSync(new URL(source)));
  }
});

test('themes supply local bitmap assets and can replace sprite animations', async () => {
  assert.equal(new Set(themes.map(theme => theme.id)).size, themes.length);
  for (const theme of themes) {
    assert.ok(existsSync(new URL(theme.background)));
    assert.ok(existsSync(new URL(theme.sprite)));
    assert.ok(theme.tokens['--cp-panel']);
    assert.ok(theme.tokens['--cp-glass-surface']);
    assert.equal(theme.tokens['--cp-voice-glass'], 'var(--cp-glass-surface)');
    assert.ok(theme.tokens['--cp-font']);
    assert.notEqual(theme.tokens['--cp-caption-user-bg'], theme.tokens['--cp-caption-assistant-bg']);
    assert.equal(theme.tokens['--cp-caption-user-bg'].includes('gradient'), false);
    assert.equal(theme.tokens['--cp-caption-assistant-bg'].includes('gradient'), false);
    assert.equal(theme.tokens['--cp-caption-font-weight'], '400');
    for (const token of ['--cp-caption-width', '--cp-caption-padding', '--cp-caption-radius', '--cp-caption-blur', '--cp-caption-stack-gap', '--cp-caption-control-size', '--cp-caption-font-size', '--cp-caption-font-weight']) assert.ok(theme.tokens[token]);
    for (const state of Object.keys(defaultAnimations)) assert.ok(theme.animations[state]);
  }
  const output = await renderToString(createSSRApp({
    render: () => h(VoiceSprite, {
      state: 'listening', source: '/alternate.png', animations: { listening: 'alternate-listen' },
    }),
  }));
  assert.ok(output.includes('animation-name:alternate-listen'));
  assert.ok(output.includes('src="/alternate.png"'));
});

test('hands-free capture pauses for playback while push to talk remains explicit', () => {
  assert.equal(shouldForwardCapturedAudio({ muted: false, pttMode: false, pttHeld: false, assistantSpeaking: false }), true);
  assert.equal(shouldForwardCapturedAudio({ muted: false, pttMode: false, pttHeld: false, assistantSpeaking: true }), false);
  assert.equal(shouldForwardCapturedAudio({ muted: false, pttMode: true, pttHeld: true, assistantSpeaking: true }), true);
  assert.equal(shouldForwardCapturedAudio({ muted: true, pttMode: true, pttHeld: true, assistantSpeaking: false }), false);
});

test('voice caption bridge presents partials and commits final transcripts', () => {
  const events = [];
  const partialTranscript = { hidden: true, textContent: '' };
  const bridge = createVoiceCaptionBridge({
    partialTranscript,
    conversationUI: {
      preview: (role, text) => events.push(['preview', role, text]),
      clearCaption: () => events.push(['clear']),
      clear: () => events.push(['reset']),
    },
    appendMessage: (role, text) => events.push(['message', role, text]),
  });

  bridge.transcript({ role: 'user', text: 'Working', partial: true });
  assert.equal(partialTranscript.hidden, false);
  assert.equal(partialTranscript.textContent, 'user: Working...');
  bridge.transcript({ role: 'user', text: 'Working now' });
  assert.equal(partialTranscript.hidden, true);
  assert.equal(partialTranscript.textContent, '');
  bridge.clear();
  bridge.reset();
  assert.deepEqual(events, [
    ['preview', 'user', 'Working'],
    ['message', 'user', 'Working now'],
    ['clear'],
    ['reset'],
  ]);
});
