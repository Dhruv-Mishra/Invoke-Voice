import { defaultAnimations } from './VoiceSprite.js';

const alpineBackground = new URL('./alpine-lake.webp', import.meta.url).href;
const defaultTokens = {
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
  '--cp-listening-hue': '#8066d9',
  '--cp-mic-glow': 'rgba(83, 135, 255, 0.24)',
  '--cp-voice-glass': 'rgba(227, 237, 255, 0.70)',
  '--cp-font': '"Segoe UI Variable", "Segoe UI", Aptos, Calibri, sans-serif',
  '--cp-font-display': '"Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", Aptos, Calibri, sans-serif',
  '--cp-font-mono': 'Consolas, "Courier New", Courier, monospace',
  '--cp-type-xs': '11px',
  '--cp-type-sm': '13px',
  '--cp-type-base': '14px',
  '--cp-type-md': '16px',
  '--cp-type-lg': '18px',
  '--cp-type-xl': '24px',
  '--cp-type-2xl': '30px',
  '--cp-leading-tight': '1.25',
  '--cp-leading-base': '1.5',
  '--cp-leading-relaxed': '1.6',
  '--cp-weight-medium': '500',
  '--cp-weight-semibold': '600',
  '--cp-weight-bold': '700',
  '--cp-radius-control': '10px',
  '--cp-radius-surface': '24px',
  '--cp-space-1': '4px',
  '--cp-space-2': '8px',
  '--cp-space-3': '12px',
  '--cp-space-4': '16px',
  '--cp-space-5': '20px',
  '--cp-space-6': '24px',
  '--cp-opacity-disabled': '0.5',
  '--cp-duration-fast': '140ms',
};

const themeDefaults = Object.freeze({
  background: alpineBackground,
  sprite: new URL('./copilot-icon.webp', import.meta.url).href,
  tokens: Object.freeze(defaultTokens),
  animations: defaultAnimations,
  sounds: Object.freeze({ navigation: null, action: null }),
  preferences: Object.freeze({ colorScheme: 'light', soundsEnabled: false, soundVolume: 0.2 }),
});

export function defineTheme(definition) {
  return Object.freeze({
    ...themeDefaults,
    ...definition,
    tokens: Object.freeze({ ...themeDefaults.tokens, ...definition.tokens }),
    animations: Object.freeze({ ...themeDefaults.animations, ...definition.animations }),
    sounds: Object.freeze({ ...themeDefaults.sounds, ...definition.sounds }),
    preferences: Object.freeze({ ...themeDefaults.preferences, ...definition.preferences }),
  });
}

export const themes = Object.freeze([
  { id: 'alpine', label: 'Alpine' },
  { id: 'opal', label: 'Opal',
    sprite: new URL('./opal-icon.webp', import.meta.url).href,
    animations: { idle: 'sprite-think' },
    tokens: { '--cp-accent': '#537bce', '--cp-panel': 'rgba(255, 255, 255, 0.57)' } },
  { id: 'jarvis', label: 'Jarvis', sprite: new URL('./jarvis-icon.webp', import.meta.url).href },
].map(defineTheme));

export function motionPreference(value) {
  return ['system', 'reduce', 'full'].includes(value) ? value : 'system';
}

const appliedTokens = new Set();

export function applyTheme(theme) {
  const root = document.documentElement;
  for (const token of appliedTokens) root.style.removeProperty(token);
  appliedTokens.clear();
  for (const [token, value] of Object.entries(theme.tokens)) {
    if (!token.startsWith('--cp-') || value == null) continue;
    root.style.setProperty(token, value);
    appliedTokens.add(token);
  }
  root.style.setProperty('--cp-background-image', theme.background ? `url(${JSON.stringify(theme.background)})` : 'none');
  root.dataset.appearance = theme.id;
  root.style.colorScheme = theme.preferences.colorScheme;
}