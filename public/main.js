import { createApp, h, reactive, ref } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  Activity, AppWindow, AudioLines, Bell, BellOff, CalendarDays, Check, CheckCheck, CheckSquare, ChevronLeft, ChevronRight, CircleDashed, ClipboardCheck, createIcons, Edit2, Folder,
  Database, ExternalLink, File, FileText, FlaskConical, FolderKanban, HardDriveDownload, House, KeyRound, Keyboard,
  LayoutDashboard, MessageSquare, MessageSquarePlus, Mic, MicOff, PanelLeftClose, Palette, Play, Plus,
  PhoneOff, PlusCircle, Radio, RefreshCw, Save, ScanSearch, Send, Settings,
  SlidersHorizontal, Sparkles, Square, Trash2, X, Heart, MessagesSquare, Orbit, Radar, Terminal, Volume2, Zap,
} from 'lucide';
import VoiceSprite from './VoiceSprite.js';
import { applyTheme, motionPreference, resolveTheme, themes } from './themes.js';
import { readPreference, savePreference } from './preferences.js';
import './theme.css';

window.DOMPurify = DOMPurify;
window.marked = marked;
const appIcons = { Activity, AppWindow, Folder, AudioLines, Bell, Check, CheckCheck, PhoneOff, ChevronLeft, ChevronRight, ClipboardCheck, Heart, MessagesSquare, Orbit, Radar, Terminal, Volume2, Zap, BellOff, CalendarDays, CheckSquare, CircleDashed, Edit2, ExternalLink,
  Database, File, FileText, FlaskConical, FolderKanban, HardDriveDownload, House, KeyRound, Keyboard, LayoutDashboard,
  MessageSquare, MessageSquarePlus, Mic, MicOff, PanelLeftClose, Palette, Play, Plus, PlusCircle, Radio, RefreshCw,
  Save, ScanSearch, Send, Settings, SlidersHorizontal, Sparkles, Square, Trash2, X };
window.lucide = { createIcons: () => {
  for (const [selector, name] of Object.entries({ '#home-tab': theme.value.icons.home, '#workspace-tab': theme.value.icons.tasks, '#settings-tab': theme.value.icons.settings, '#mic-toggle-btn': theme.value.icons.microphone })) {
    const glyph = document.querySelector(`${selector} [data-lucide]`);
    if (glyph && glyph.dataset.lucide !== name) {
      const replacement = document.createElement('i');
      replacement.dataset.lucide = name;
      replacement.setAttribute('aria-hidden', 'true');
      glyph.replaceWith(replacement);
    }
  }
  createIcons({ icons: appIcons });
} };
for (const input of document.querySelectorAll('.toggle-control input[type="checkbox"]')) input.setAttribute('role', 'switch');

const stateCopy = {
  idle: 'Ready when you are',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};
const suggestions = [
  ['plus', 'New task', 'Start a coding task in my default work area: '],
  ['scan-search', 'Check progress', 'Give me the status of my current coding tasks.'],
  ['message-square', 'Continue work', 'Help me continue an existing coding task.'],
];

function icon(name) {
  const key = name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
  return h('svg', { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, appIcons[key].map(([tag, attributes]) => h(tag, attributes)));
}

const themeKey = 'voice-supervisor-theme-v2';
const soundsKey = 'voice-supervisor-sounds-v1';
const motionKey = 'voice-supervisor-motion-v1';
const transparencyKey = 'voice-supervisor-transparency-v1';
const variantsKey = 'voice-supervisor-theme-variants-v1';
const volumeKey = 'voice-supervisor-sound-volume-v1';
const strengthKey = 'voice-supervisor-wallpaper-strength-v1';
const personaKey = 'voice-supervisor-theme-persona-v1';
const voiceKey = 'voice-supervisor-theme-voice-v1';
let variants;
try { variants = JSON.parse(readPreference(variantsKey)) || {}; } catch { variants = {}; }
if (typeof variants !== 'object' || Array.isArray(variants)) variants = {};
variants = reactive(variants);
function readPercent(key, fallback) {
  const saved = readPreference(key);
  const value = saved === null ? fallback : Number(saved);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}
let soundVolume = readPercent(volumeKey, 20);
let wallpaperStrength = readPercent(strengthKey, 100);
let personaEnabled = readPreference(personaKey) !== 'false';
let themeVoiceEnabled = readPreference(voiceKey) !== 'false';
let transparencyEnabled = readPreference(transparencyKey) !== 'false';
const savedTheme = readPreference(themeKey);
const savedSounds = readPreference(soundsKey);
const theme = ref(resolveTheme(savedTheme, variants[savedTheme] || {}));
if (savedTheme === 'opal') {
  variants.alpine = { wallpaper: theme.value.wallpaperId, sprite: 'opal' };
  delete variants.opal;
  savePreference(themeKey, theme.value.id);
  savePreference(variantsKey, JSON.stringify(variants));
}
window.getThemeSessionOptions = () => ({ theme: theme.value.id, themePersona: personaEnabled, themeVoice: themeVoiceEnabled });
const state = ref('idle');
const voiceActive = ref(false);
let soundsEnabled = savedSounds === 'true' ? true : savedSounds === 'false' ? false : null;
let interactionAudio = null;
let interactionKind = null;
let soundTimeout;
window.isThemeSoundPlaying = () => Boolean(interactionAudio);

function soundSource(kind) {
  const source = theme.value.sounds[kind];
  if (typeof source !== 'string' || !source) return null;
  try {
    const url = new URL(source, import.meta.url);
    return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function syncSoundControls() {
  const available = Boolean(soundSource('bootup') || soundSource('action'));
  for (const input of document.querySelectorAll('input[type="checkbox"][data-theme-sounds]')) {
    input.checked = available && (soundsEnabled ?? theme.value.preferences.soundsEnabled);
    input.disabled = !available;
    input.title = available ? '' : 'This theme has no interaction sounds.';
  }
}

function stopSound() {
  clearTimeout(soundTimeout);
  const audio = interactionAudio;
  interactionAudio = null;
  interactionKind = null;
  if (!audio) return;
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function playSound(kind, preview = false) {
  if ((!preview && !(soundsEnabled ?? theme.value.preferences.soundsEnabled))
    || (kind !== 'endCall' && (document.hidden || !document.hasFocus()))) return;
  const source = soundSource(kind);
  const volume = soundVolume / 100 * theme.value.preferences.soundVolume / 0.2;
  if (!source || !volume) return;
  stopSound();
  const audio = new Audio();
  interactionAudio = audio;
  interactionKind = kind;
  const finish = () => { if (interactionAudio === audio) stopSound(); };
  audio.preload = 'none';
  audio.volume = Math.min(1, volume);
  audio.onended = finish;
  audio.onerror = finish;
  soundTimeout = window.setTimeout(finish, 10000);
  audio.src = source;
  try { audio.play()?.catch(finish); } catch { finish(); }
}

function onSoundPreference(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches('input[type="checkbox"][data-theme-sounds]') || input.disabled) return;
  soundsEnabled = input.checked;
  savePreference(soundsKey, String(soundsEnabled));
  stopSound();
  syncSoundControls();
}

function onState(event) {
  state.value = stateCopy[event.detail?.state] ? event.detail.state : 'idle';
  voiceActive.value = event.detail?.active === true;
}

function onTheme(event) {
  const id = event.detail?.id;
  if (!themes.some(item => item.id === id)) return;
  const next = resolveTheme(id, variants[id] || {});
  const changed = next.id !== theme.value.id;
  stopSound();
  theme.value = next;
  applyTheme(next, { transparency: transparencyEnabled, wallpaperStrength });
  syncSoundControls();
  window.lucide.createIcons();
  savePreference(themeKey, next.id);
  if (changed) playSound('bootup');
}

function cycleThemeVariant(id, field, direction) {
  const current = resolveTheme(id, variants[id] || {});
  const choices = field === 'wallpaper' ? current.wallpapers : current.sprites;
  const index = choices.findIndex(choice => choice.id === current[`${field}Id`]);
  const next = choices[(index + direction + choices.length) % choices.length];
  variants[id] = { ...(variants[id] || {}), [field]: next.id };
  savePreference(variantsKey, JSON.stringify(variants));
  if (theme.value.id === id) onTheme({ detail: { id } });
}

const ThemeCards = {
  name: 'ThemeCards',
  setup() {
    return () => themes.map(item => {
      const preview = resolveTheme(item.id, variants[item.id] || {});
      const wallpaper = preview.wallpapers.find(choice => choice.id === preview.wallpaperId);
      const sprite = preview.sprites.find(choice => choice.id === preview.spriteId);
      const control = (action, glyph, label, field, direction) => h('button', {
        class: `theme-card-control theme-card-${action}`, type: 'button',
        'data-theme-control': action, 'data-theme-sound': 'action', 'aria-label': label, title: label,
        onClick: () => cycleThemeVariant(item.id, field, direction),
      }, [icon(glyph)]);
      return h('div', {
        key: item.id, class: 'theme-card', 'data-theme-card': item.id,
        'data-wallpaper': preview.wallpaperId, 'data-sprite': preview.spriteId,
        style: {
          '--cp-preview-surface': preview.tokens['--cp-panel-strong'],
          '--cp-preview-text': preview.tokens['--cp-text'],
          '--cp-preview-ink': preview.tokens['--cp-sprite-ink'],
        },
      }, [
        h('button', {
          class: 'theme-card-select', type: 'button', 'data-appearance': item.id, 'data-theme-sound': 'action',
          'aria-label': `${item.label} theme`, 'aria-pressed': theme.value.id === item.id,
          title: `${item.label}: ${wallpaper.label}, ${sprite.label}`,
          onClick: event => {
            window.dispatchEvent(new CustomEvent('voice-supervisor:theme', { detail: { id: item.id } }));
            event.currentTarget.closest('[popover]')?.hidePopover();
          },
        }, [
          h('img', { class: 'theme-card-wallpaper', src: preview.background, alt: '', decoding: 'async' }),
          h('span', { class: 'theme-card-shade', 'aria-hidden': 'true' }),
          h('span', { class: 'theme-card-name' }, item.label),
          h('span', { class: 'theme-card-check', 'aria-hidden': 'true' }, [icon('check')]),
          h('span', { class: ['theme-card-sprite', { 'theme-card-face': item.kind === 'companion' }], 'aria-hidden': 'true' }, [
            h('img', { src: preview.sprite, alt: '', decoding: 'async' }),
            item.kind === 'companion' ? h('span', { class: 'theme-card-eyes' }) : null,
          ]),
        ]),
        preview.wallpapers.length > 1 ? control('previous', 'chevron-left', `Previous ${item.label} wallpaper`, 'wallpaper', -1) : null,
        preview.wallpapers.length > 1 ? control('next', 'chevron-right', `Next ${item.label} wallpaper`, 'wallpaper', 1) : null,
        preview.sprites.length > 1 ? control('swap', 'refresh-cw', `Swap ${item.label} sprite`, 'sprite', 1) : null,
        h('span', { class: 'theme-card-position', 'aria-hidden': 'true' }, preview.wallpapers.map(choice => h('span', {
          key: choice.id, class: { current: choice.id === preview.wallpaperId },
        }))),
        h('span', { class: 'sr-only', role: 'status' }, `${item.label}: ${wallpaper.label}, ${sprite.label}`),
      ]);
    });
  },
};

const VoiceHome = {
  name: 'VoiceHome',
  setup() {
    return () => h('div', { class: 'home-composition' }, [
      h('section', { class: 'assistant-stage', 'aria-label': 'Voice assistant' }, [
        h('div', { class: 'assistant-artwork' }, [
          h('button', { id: 'assistant-toggle-btn', class: 'assistant-toggle', type: 'button', 'aria-label': 'Connect microphone', disabled: true }, [
            h(VoiceSprite, { state: state.value, active: voiceActive.value, source: theme.value.sprite, animations: theme.value.animations, kind: theme.value.kind, variant: theme.value.spriteId }),
          ]),
          h('button', { class: 'assistant-appearance btn btn-icon', type: 'button', popovertarget: 'appearance-popover', title: 'Change appearance', 'aria-label': 'Change appearance' }, [icon('palette')]),
        ]),
        h('div', { class: 'presence-copy', role: 'status', 'aria-live': 'polite' }, [
          h('h1', { key: state.value }, state.value === 'idle' ? 'Invoke' : stateCopy[state.value]),
        ]),
      ]),
      h('nav', { class: 'suggestions', 'aria-label': 'Quick actions' }, [
        ...suggestions.map(([glyph, label, prompt], index) => h('button', {
          class: 'suggestion', type: 'button', 'data-theme-sound': 'action',
          onClick: () => window.dispatchEvent(new CustomEvent('voice-supervisor:compose', { detail: { text: prompt } })),
        }, [icon(theme.value.icons[['action', 'progress', 'continue'][index]] || glyph), h('span', label)])),
      ]),
    ]);
  },
};

applyTheme(theme.value, { transparency: transparencyEnabled, wallpaperStrength });
const themeApps = [...document.querySelectorAll('.appearance-options')].map(options => {
  const app = createApp(ThemeCards);
  app.mount(options);
  return app;
});
document.getElementById('theme-art-license').href = new URL('./immersive/fluent-license.txt', import.meta.url).href;
syncSoundControls();
const motionSelect = document.getElementById('motion-preference');
motionSelect.value = motionPreference(readPreference(motionKey));
document.documentElement.dataset.motion = motionSelect.value;
const homeApp = createApp(VoiceHome);
homeApp.mount('#voice-personality-app');
const listeners = new AbortController();
const listenerOptions = { signal: listeners.signal };
for (const [id, key, checked, update] of [
  ['theme-persona', personaKey, personaEnabled, value => { personaEnabled = value; }],
  ['theme-voice', voiceKey, themeVoiceEnabled, value => { themeVoiceEnabled = value; }],
]) {
  const input = document.getElementById(id);
  input.checked = checked;
  input.addEventListener('change', () => { update(input.checked); savePreference(key, String(input.checked)); }, listenerOptions);
}
for (const [id, key, initial, update] of [
  ['theme-volume', volumeKey, soundVolume, value => { soundVolume = value; stopSound(); }],
  ['wallpaper-strength', strengthKey, wallpaperStrength, value => { wallpaperStrength = value; applyTheme(theme.value, { transparency: transparencyEnabled, wallpaperStrength }); }],
]) {
  const input = document.getElementById(id);
  const output = document.getElementById(`${id}-value`);
  input.value = initial;
  output.value = `${initial}%`;
  input.addEventListener('input', () => {
    const value = Number(input.value);
    update(value);
    output.value = `${value}%`;
    savePreference(key, String(value));
  }, listenerOptions);
}
document.getElementById('theme-sound-preview').addEventListener('click', () => { stopSound(); playSound('action', true); }, listenerOptions);
document.getElementById('theme-new-chat').addEventListener('click', () => window.dispatchEvent(new Event('voice-supervisor:themed-chat')), listenerOptions);
const sidebarToggle = document.getElementById('sidebar-toggle');
function setSidebar(collapsed) {
  document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
}
setSidebar(readPreference('voice-supervisor-sidebar-v1') === 'collapsed');
sidebarToggle.addEventListener('click', () => {
  const collapsed = document.documentElement.dataset.sidebar !== 'collapsed';
  setSidebar(collapsed);
  savePreference('voice-supervisor-sidebar-v1', collapsed ? 'collapsed' : 'expanded');
}, listenerOptions);
const transparencyInput = document.getElementById('transparency-preference');
transparencyInput.checked = transparencyEnabled;
transparencyInput.addEventListener('change', () => {
  transparencyEnabled = transparencyInput.checked;
  savePreference(transparencyKey, String(transparencyEnabled));
  applyTheme(theme.value, { transparency: transparencyEnabled, wallpaperStrength });
}, listenerOptions);
window.addEventListener('voice-supervisor:agent-state', onState, listenerOptions);
window.addEventListener('voice-supervisor:theme', onTheme, listenerOptions);
window.addEventListener('voice-supervisor:voice-start', () => playSound('bootup'), listenerOptions);
window.addEventListener('voice-supervisor:tool-activity', () => playSound('action'), listenerOptions);
window.addEventListener('voice-supervisor:call-ended', () => playSound('endCall'), listenerOptions);
document.addEventListener('change', onSoundPreference, listenerOptions);
motionSelect.addEventListener('change', () => {
  const preference = motionPreference(motionSelect.value);
  document.documentElement.dataset.motion = preference;
  savePreference(motionKey, preference);
}, listenerOptions);
const stopBackgroundSound = () => { if (interactionKind !== 'endCall') stopSound(); };
document.addEventListener('visibilitychange', stopBackgroundSound, listenerOptions);
const syncVisibility = () => { document.documentElement.dataset.pageVisible = document.hidden ? 'false' : 'true'; };
syncVisibility();
document.addEventListener('visibilitychange', syncVisibility, listenerOptions);
window.addEventListener('blur', stopBackgroundSound, listenerOptions);
window.addEventListener('pagehide', stopSound, listenerOptions);
if (import.meta.hot) import.meta.hot.dispose(() => {
  listeners.abort();
  stopSound();
  for (const app of themeApps) app.unmount();
  homeApp.unmount();
});
await import('./app.js');