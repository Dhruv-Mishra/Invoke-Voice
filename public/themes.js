import { defaultAnimations } from './VoiceSprite.js';

const alpineBackground = new URL('./alpine-lake.webp', import.meta.url).href;
const alpineTokens = {
  '--cp-bg': '#e8f2f7',
  '--cp-bg-elevated': '#eff6fa',
  '--cp-surface': '#ffffff',
  '--cp-surface-soft': '#e8f0f8',
  '--cp-text': '#18354b',
  '--cp-text-muted': '#48657b',
  '--cp-text-soft': '#607c90',
  '--cp-accent': '#3478ff',
  '--cp-accent-hover': '#2265e8',
  '--cp-accent-fg': '#ffffff',
  '--cp-accent-soft': 'rgba(100, 157, 255, 0.18)',
  '--cp-border': 'rgba(126, 162, 191, 0.23)',
  '--cp-border-strong': '#94b3cf',
  '--cp-panel': 'rgba(247, 252, 255, 0.43)',
  '--cp-panel-strong': 'rgba(247, 252, 255, 0.92)',
  '--cp-sidebar': 'rgba(236, 246, 251, 0.78)',
  '--cp-sheen': 'rgba(255, 255, 255, 0.74)',
  '--cp-overlay': 'rgba(214, 231, 240, 0.55)',
  '--cp-shadow': '0 12px 48px rgba(60, 104, 143, 0.12)',
  '--cp-glass-shadow': '0 2px 7px rgba(99, 143, 175, 0.06)',
  '--cp-wave': '#9ea9ed',
  '--cp-mic-glow': 'rgba(83, 135, 255, 0.24)',
  '--cp-voice-glass': 'rgba(227, 237, 255, 0.70)',
  '--cp-font': '"Segoe UI", Aptos, Calibri, sans-serif',
};

export const themes = Object.freeze([
  { id: 'alpine', label: 'Alpine', background: alpineBackground,
    sprite: new URL('./aurora-sprite.png', import.meta.url).href,
    animations: defaultAnimations, tokens: alpineTokens },
  { id: 'opal', label: 'Opal', background: alpineBackground,
    sprite: new URL('./opal-sprite.png', import.meta.url).href,
    animations: { ...defaultAnimations, idle: 'sprite-think' },
    tokens: { ...alpineTokens, '--cp-accent': '#537bce', '--cp-panel': 'rgba(255, 255, 255, 0.57)' } },
]);

export function applyTheme(theme) {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(token, value);
  root.style.setProperty('--cp-background-image', `url("${theme.background}")`);
  root.dataset.appearance = theme.id;
  root.style.colorScheme = 'light';
}