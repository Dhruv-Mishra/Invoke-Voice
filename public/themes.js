import { defaultAnimations } from './VoiceSprite.js';

export const captionTiming = Object.freeze({ minimum: 6000, maximum: 16000, perCharacter: 40, afterSpeech: 700, fade: 500 });
const alpineBackground = new URL('./immersive/copilot-background-1.webp', import.meta.url).href;
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
  '--cp-sidebar': 'rgba(245, 245, 247, 0.46)',
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
  '--cp-space-8': '32px',
  '--cp-control-height': '44px',
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
  '--cp-wallpaper-blend': 'normal',
  '--cp-wallpaper-opacity': '1',
  '--cp-sprite-ink': '#202124',
  '--cp-sprite-ring': '#68d7ee',
  '--cp-control-stroke': '1.75',
  '--cp-dock-radius': '28px',
  '--cp-dock-core-radius': '50%',
  '--cp-dock-accent': '#0066cc',
  '--cp-dock-fg': '#ffffff',
  '--cp-dock-shadow': '0 12px 40px rgba(29,29,31,0.16)',
};

const themeDefaults = Object.freeze({
  background: alpineBackground,
  sprite: new URL('./copilot-icon.webp', import.meta.url).href,
  tokens: Object.freeze(defaultTokens),
  animations: defaultAnimations,
  sounds: Object.freeze({ bootup: null, action: null }),
  preferences: Object.freeze({ colorScheme: 'light', soundsEnabled: true, soundVolume: 0.2 }),
  kind: 'copilot',
  icons: Object.freeze({ home: 'house', tasks: 'check-square', settings: 'settings', action: 'plus', progress: 'scan-search', continue: 'message-square', microphone: 'mic' }),
});

export function defineTheme(definition) {
  return Object.freeze({
    ...themeDefaults,
    ...definition,
    wallpapers: Object.freeze(definition.wallpapers || [{ id: 'default', label: 'Original', source: definition.background || themeDefaults.background }]),
    sprites: Object.freeze(definition.sprites || [{ id: 'default', label: 'Original', source: definition.sprite || themeDefaults.sprite }]),
    tokens: Object.freeze({ ...themeDefaults.tokens, ...definition.tokens }),
    animations: Object.freeze({ ...themeDefaults.animations, ...definition.animations }),
    sounds: Object.freeze({ ...themeDefaults.sounds, ...definition.sounds }),
    icons: Object.freeze({ ...themeDefaults.icons, ...definition.icons }),
    preferences: Object.freeze({ ...themeDefaults.preferences, ...definition.preferences }),
  });
}

const media = {
  reactor: new URL('./immersive/reactor.webp', import.meta.url).href,
  gold: new URL('./immersive/reactor-gold.webp', import.meta.url).href,
  companion: new URL('./immersive/companion.webp', import.meta.url).href,
  observatory: new URL('./immersive/jarvis-background-1.webp', import.meta.url).href,
  skyline: new URL('./immersive/jarvis-background-2.webp', import.meta.url).href,
  sanctuary: new URL('./immersive/baymax-background-1.webp', import.meta.url).href,
  garden: new URL('./immersive/baymax-background-2.webp', import.meta.url).href,
};
const neutralWallpapers = [
  { id: 'white', label: 'White', source: new URL('./immersive/white-background.webp', import.meta.url).href },
  { id: 'black', label: 'Black', source: new URL('./immersive/black-background.webp', import.meta.url).href },
];
const copilotWallpapers = [{ id: 'alpine', label: 'Dreamscape', source: alpineBackground }, { id: 'garden', label: 'Blush', source: new URL('./immersive/copilot-background-2.webp', import.meta.url).href }, ...neutralWallpapers];
const copilotSprites = [{ id: 'copilot', label: 'Copilot', source: themeDefaults.sprite }, { id: 'opal', label: 'Opal', source: new URL('./opal-icon.webp', import.meta.url).href }];
const copilotSounds = { bootup: new URL('./immersive/copilot-bootup.ogg', import.meta.url).href, action: new URL('./immersive/copilot-action.ogg', import.meta.url).href };

export const themes = Object.freeze([
  { id: 'alpine', label: 'Copilot', wallpapers: copilotWallpapers, sprites: copilotSprites, sounds: copilotSounds },
  { id: 'jarvis', label: 'Jarvis', kind: 'reactor', sprite: media.reactor, background: media.observatory,
    wallpapers: [{ id: 'observatory', label: 'Command center', source: media.observatory }, { id: 'skyline', label: 'Arc chamber', source: media.skyline }, ...neutralWallpapers],
    sprites: [{ id: 'arc', label: 'Arc core', source: media.reactor }, { id: 'palladium', label: 'Palladium core', source: media.gold }],
    animations: { idle: 'reactor-idle', connecting: 'reactor-connect', listening: 'reactor-listen', thinking: 'reactor-think', speaking: 'reactor-speak' },
    icons: { home: 'orbit', tasks: 'radar', settings: 'sliders-horizontal', action: 'zap', progress: 'radar', continue: 'terminal', microphone: 'audio-lines' },
    sounds: { bootup: new URL('./immersive/jarvis-bootup.ogg', import.meta.url).href, action: new URL('./immersive/jarvis-action.ogg', import.meta.url).href },
    preferences: { colorScheme: 'dark', soundVolume: 0.18, soundsEnabled: true },
    tokens: {
      '--cp-bg': '#101414', '--cp-bg-elevated': '#1a2020', '--cp-surface': '#202727', '--cp-surface-soft': '#293231',
      '--cp-text': '#eef5f2', '--cp-text-muted': '#b7c7c2', '--cp-text-soft': '#aabcb6', '--cp-accent': '#7fdfec', '--cp-accent-hover': '#b2eef5', '--cp-accent-fg': '#102629',
      '--cp-accent-soft': 'rgba(127,223,236,0.12)', '--cp-link': '#9ae5ef', '--cp-success': '#98d7aa', '--cp-warning': '#edc983', '--cp-danger': '#ff9c92',
      '--cp-border': 'rgba(190,225,216,0.18)', '--cp-border-strong': '#607b73', '--cp-panel': 'rgba(25,35,34,0.8)', '--cp-panel-strong': 'rgba(26,32,32,0.97)', '--cp-sidebar': 'rgba(16,24,23,0.52)',
      '--cp-sheen': 'rgba(182,232,226,0.24)', '--cp-overlay': 'rgba(7,14,13,0.7)', '--cp-highlight': 'rgba(7,14,13,0.55)', '--cp-wave': '#7fdfec', '--cp-listening-hue': '#7fdfec', '--cp-mic-glow': 'rgba(127,223,236,0.18)', '--cp-voice-glass': 'rgba(20,32,31,0.92)',
      '--cp-caption-assistant-bg': 'rgba(26,32,32,0.96)', '--cp-caption-assistant-bg-solid': '#1a2020', '--cp-caption-user-bg': 'rgba(32,57,58,0.96)', '--cp-caption-user-bg-solid': '#20393a', '--cp-caption-text': '#eef5f2',
      '--cp-font-display': 'Bahnschrift, "Segoe UI Variable Display", "Segoe UI", sans-serif', '--cp-wallpaper-blend': 'normal', '--cp-wallpaper-opacity': '1', '--cp-glass-blur': '12px', '--cp-control-stroke': '1.5',
      '--cp-dock-radius': '18px', '--cp-dock-core-radius': '18px', '--cp-dock-accent': '#7fdfec', '--cp-dock-fg': '#102629', '--cp-dock-shadow': '0 12px 40px rgba(0,0,0,0.28)',
    },
  },
  { id: 'baymax', label: 'Baymax', kind: 'companion', sprite: media.companion, background: media.sanctuary,
    wallpapers: [{ id: 'sanctuary', label: 'Workshop', source: media.sanctuary }, { id: 'garden', label: 'Sunlit studio', source: media.garden }, ...neutralWallpapers],
    sprites: [{ id: 'face', label: 'Baymax face', source: media.companion }],
    animations: { idle: 'companion-breathe', connecting: 'companion-listen', listening: 'companion-listen', thinking: 'companion-think', speaking: 'companion-speak' },
    icons: { home: 'heart', tasks: 'clipboard-check', settings: 'sliders-horizontal', action: 'sparkles', progress: 'activity', continue: 'messages-square', microphone: 'mic' },
    sounds: { bootup: new URL('./immersive/baymax-bootup.ogg', import.meta.url).href, action: new URL('./immersive/baymax-action.ogg', import.meta.url).href },
    preferences: { soundsEnabled: true, soundVolume: 0.16 },
    tokens: {
      '--cp-bg': '#eef2f1', '--cp-bg-elevated': '#fafcfb', '--cp-surface-soft': '#e8efec', '--cp-text': '#263b36', '--cp-text-muted': '#566d65', '--cp-text-soft': '#61776e',
      '--cp-accent': '#b3384b', '--cp-accent-hover': '#98263a', '--cp-accent-soft': 'rgba(179,56,75,0.08)', '--cp-link': '#287164', '--cp-success': '#287164', '--cp-border': 'rgba(38,59,54,0.13)', '--cp-border-strong': '#a7b9b0',
      '--cp-panel': 'rgba(255,255,255,0.8)', '--cp-sidebar': 'rgba(241,246,243,0.46)', '--cp-voice-glass': 'rgba(255,255,255,0.92)', '--cp-wave': '#b3384b', '--cp-listening-hue': '#b3384b', '--cp-mic-glow': 'rgba(179,56,75,0.12)',
      '--cp-caption-user-bg': 'rgba(249,234,236,0.96)', '--cp-caption-user-bg-solid': '#f9eaec', '--cp-caption-text': '#263b36', '--cp-control-stroke': '2', '--cp-wallpaper-blend': 'normal', '--cp-wallpaper-opacity': '1',
      '--cp-dock-radius': '48px', '--cp-dock-core-radius': '50%', '--cp-dock-accent': '#b3384b', '--cp-dock-fg': '#ffffff',
    },
  },
].map(defineTheme));

export function resolveTheme(id, { wallpaper, sprite } = {}) {
  if (id === 'opal') {
    id = 'alpine';
    sprite = 'opal';
  }
  const theme = themes.find(candidate => candidate.id === id) || themes[0];
  const selectedWallpaper = theme.wallpapers.find(candidate => candidate.id === wallpaper) || theme.wallpapers[0];
  const selectedSprite = theme.sprites.find(candidate => candidate.id === sprite) || theme.sprites[0];
  const surfaceTheme = selectedWallpaper.id === 'black' || (theme.id === 'baymax' && selectedWallpaper.id === 'sanctuary') ? themes[1] : selectedWallpaper.id === 'white' ? themes[0] : theme;
  const identityTokens = Object.fromEntries(Object.entries(theme.tokens).filter(([key]) => key.startsWith('--cp-dock-') || key === '--cp-font-display'));
  return { ...theme, tokens: { ...surfaceTheme.tokens, ...identityTokens }, preferences: { ...theme.preferences, colorScheme: surfaceTheme.preferences.colorScheme }, background: selectedWallpaper.source, sprite: selectedSprite.source, wallpaperId: selectedWallpaper.id, spriteId: selectedSprite.id };
}

export function motionPreference(value) {
  return ['system', 'reduce', 'full'].includes(value) ? value : 'full';
}

const appliedTokens = new Set();

export function applyTheme(theme, { transparency = true, wallpaperStrength = 100 } = {}) {
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
    tokens['--cp-caption-blur'] = '0px';
  }
  const strength = Number(wallpaperStrength);
  tokens['--cp-wallpaper-opacity'] = String(Number(tokens['--cp-wallpaper-opacity']) * (Number.isFinite(strength) ? Math.max(0, Math.min(100, strength)) / 100 : 1));
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