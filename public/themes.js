import { defaultAnimations } from './VoiceSprite.js';

export const captionTiming = Object.freeze({ minimum: 6000, maximum: 16000, perCharacter: 40, afterSpeech: 700, fade: 500 });
const alpineBackground = new URL('./alpine-lake.webp', import.meta.url).href;
const defaultTokens = {
  '--cp-bg': '#f5f5f7',
  '--cp-bg-elevated': '#fafafc',
  '--cp-surface': '#ffffff',
  '--cp-surface-soft': '#f0f0f2',
  '--cp-text': '#1d1d1f',
  '--cp-text-muted': '#626268',
  '--cp-text-soft': '#737379',
  '--cp-accent': '#0066cc',
  '--cp-accent-hover': '#0071e3',
  '--cp-accent-fg': '#ffffff',
  '--cp-accent-soft': 'rgba(0, 102, 204, 0.08)',
  '--cp-link': '#0066cc',
  '--cp-success': '#287a46',
  '--cp-warning': '#996000',
  '--cp-danger': '#c42b32',
  '--cp-border': 'rgba(29, 29, 31, 0.10)',
  '--cp-border-strong': '#b8b8be',
  '--cp-panel': 'rgba(255, 255, 255, 0.72)',
  '--cp-panel-strong': 'rgba(250, 250, 252, 0.97)',
  '--cp-sidebar': 'rgba(245, 245, 247, 0.92)',
  '--cp-sheen': 'rgba(255, 255, 255, 0.70)',
  '--cp-overlay': 'rgba(29, 29, 31, 0.16)',
  '--cp-highlight': 'rgba(29, 29, 31, 0.12)',
  '--cp-shadow': 'none',
  '--cp-glass-shadow': 'none',
  '--cp-wave': '#0066cc',
  '--cp-listening-hue': '#0066cc',
  '--cp-mic-glow': 'rgba(0, 102, 204, 0.12)',
  '--cp-voice-glass': 'rgba(250, 250, 252, 0.88)',
  '--cp-font': '"Segoe UI Variable", "Segoe UI", Aptos, Calibri, sans-serif',
  '--cp-font-display': '"Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", Aptos, Calibri, sans-serif',
  '--cp-font-mono': 'Consolas, "Courier New", Courier, monospace',
  '--cp-type-xs': '12px',
  '--cp-type-sm': '13px',
  '--cp-type-base': '15px',
  '--cp-type-md': '16px',
  '--cp-type-lg': '18px',
  '--cp-type-xl': '24px',
  '--cp-type-2xl': '32px',
  '--cp-leading-tight': '1.25',
  '--cp-leading-base': '1.5',
  '--cp-leading-relaxed': '1.6',
  '--cp-weight-medium': '400',
  '--cp-weight-semibold': '600',
  '--cp-weight-bold': '700',
  '--cp-radius-control': '8px',
  '--cp-radius-surface': '16px',
  '--cp-space-1': '4px',
  '--cp-space-2': '8px',
  '--cp-space-3': '12px',
  '--cp-space-4': '16px',
  '--cp-space-5': '20px',
  '--cp-space-6': '24px',
  '--cp-opacity-disabled': '0.5',
  '--cp-duration-fast': '160ms',
  '--cp-duration-enter': '280ms',
  '--cp-duration-layout': '320ms',
  '--cp-ease': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  '--cp-glass-blur': '20px',
  '--cp-caption-width': '360px',
  '--cp-caption-max-height': 'min(126px, 16dvh)',
  '--cp-caption-stack-gap': '6px',
  '--cp-caption-padding': '12px 16px',
  '--cp-caption-radius': '12px',
  '--cp-caption-blur': '14px',
  '--cp-caption-control-size': '28px',
  '--cp-caption-assistant-bg': 'rgba(250, 250, 252, 0.96)',
  '--cp-caption-assistant-bg-solid': '#fafafc',
  '--cp-caption-user-bg': 'rgba(232, 241, 252, 0.96)',
  '--cp-caption-user-bg-solid': '#e8f1fc',
  '--cp-caption-text': '#1d1d1f',
  '--cp-caption-font-size': '15px',
  '--cp-caption-font-weight': '400',
  '--cp-caption-fade-duration': `${captionTiming.fade}ms`,
  '--cp-voice-edge-strength': '68%',
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
  },
  { id: 'jarvis', label: 'Jarvis', sprite: new URL('./jarvis-icon.webp', import.meta.url).href },
].map(defineTheme));

export function motionPreference(value) {
  return ['system', 'reduce', 'full'].includes(value) ? value : 'full';
}

const appliedTokens = new Set();

export function applyTheme(theme, { transparency = true } = {}) {
  const root = document.documentElement;
  for (const token of appliedTokens) root.style.removeProperty(token);
  appliedTokens.clear();
  const tokens = { ...theme.tokens };
  if (!transparency) {
    for (const [token, surface] of Object.entries({
      '--cp-panel': '--cp-surface', '--cp-panel-strong': '--cp-bg-elevated',
      '--cp-sidebar': '--cp-bg-elevated', '--cp-voice-glass': '--cp-surface-soft',
      '--cp-overlay': '--cp-bg', '--cp-border': '--cp-border-strong', '--cp-sheen': '--cp-border-strong',
    })) tokens[token] = tokens[surface];
    tokens['--cp-highlight'] = tokens['--cp-bg'];
    tokens['--cp-accent-soft'] = `color-mix(in srgb, ${tokens['--cp-accent']} 12%, ${tokens['--cp-surface']})`;
    tokens['--cp-caption-assistant-bg'] = tokens['--cp-caption-assistant-bg-solid'];
    tokens['--cp-caption-user-bg'] = tokens['--cp-caption-user-bg-solid'];
    tokens['--cp-glass-blur'] = '0px';
  }
  for (const [token, value] of Object.entries(tokens)) {
    if (!token.startsWith('--cp-') || value == null) continue;
    root.style.setProperty(token, value);
    appliedTokens.add(token);
  }
  root.style.setProperty('--cp-background-image', theme.background ? `url(${JSON.stringify(theme.background)})` : 'none');
  root.dataset.appearance = theme.id;
  root.dataset.transparency = transparency ? 'on' : 'off';
  root.style.colorScheme = theme.preferences.colorScheme;
}