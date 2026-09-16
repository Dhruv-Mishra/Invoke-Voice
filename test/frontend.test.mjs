import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import VoiceSprite, { defaultAnimations } from '../public/VoiceSprite.js';
import { themes } from '../public/themes.js';

test('voice sprite renders each state with its animation and accessible label', async () => {
  for (const [state, animation] of Object.entries(defaultAnimations)) {
    const output = await renderToString(createSSRApp({
      render: () => h(VoiceSprite, { state, source: '/sprite.png' }),
    }));
    assert.ok(output.includes(`data-state="${state}"`));
    assert.ok(output.includes(`aria-label="Agent ${state}"`));
    assert.ok(output.includes(`animation-name:${animation}`));
    assert.ok(output.includes('src="/sprite.png"'));
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