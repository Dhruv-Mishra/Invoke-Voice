import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import VoiceSprite, { defaultAnimations } from '../public/VoiceSprite.js';
import { motionPreference, themes } from '../public/themes.js';
import { createCaptionController } from '../public/conversation-ui.js';

test('frontend browser preserves conversation contracts and responsive preferences', { timeout: 60000 }, async context => {
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
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Browser validation timed out\n${output}`)); }, 55000);
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
      assert.ok(delay >= 6000 && delay <= 16000);
      pending.set(++sequence, callback);
      return sequence;
    },
    clearTimeout(id) {
      if (pending.has(id)) cancelled.push(pending.get(id));
      pending.delete(id);
    },
  });
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
  assert.equal(updates.at(-1).text.length, 280);
  captions.pause(true);
  assert.equal(pending.size, 0);
  captions.update('assistant', 'Still readable');
  assert.equal(pending.size, 0);
  captions.pause(false);
  assert.equal(pending.size, 1);
  [...pending.values()][0]();
  assert.equal(updates.at(-1), null);
  captions.update('user', 'Next session');
  captions.clear();
  assert.equal(pending.size, 0);
  for (const callback of cancelled) callback();
  assert.equal(updates.at(-1), null);
});

test('motion overrides validate persisted values and default to system preference', () => {
  for (const value of ['system', 'reduce', 'full']) assert.equal(motionPreference(value), value);
  for (const value of [null, undefined, '', 'false', 'invalid']) assert.equal(motionPreference(value), 'system');
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
    assert.equal(output.includes('class="voice-bars"'), state === 'listening');
    if (state === 'listening') {
      assert.equal((output.match(/--bar-index:/g) || []).length, 9);
      assert.ok(output.includes('class="voice-bars" aria-hidden="true"'));
    }
  }
});

test('themes supply local bitmap assets and can replace sprite animations', async () => {
  assert.equal(new Set(themes.map(theme => theme.id)).size, themes.length);
  for (const theme of themes) {
    assert.ok(existsSync(new URL(theme.background)));
    assert.ok(existsSync(new URL(theme.sprite)));
    assert.ok(theme.tokens['--cp-panel']);
    assert.ok(theme.tokens['--cp-font']);
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