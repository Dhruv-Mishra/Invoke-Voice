import { createApp, h, ref } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  BellOff, CalendarDays, CheckSquare, CircleDashed, createIcons, Edit2,
  ExternalLink, File, FileText, FlaskConical, FolderKanban, House, Keyboard,
  LayoutDashboard, MessageSquare, MessageSquarePlus, Mic, Play, Plus,
  PlusCircle, Radio, RefreshCw, Save, ScanSearch, Send, Settings,
  SlidersHorizontal, Sparkles, Square, Trash2, X,
} from 'lucide';
import VoiceSprite from './VoiceSprite.js';
import { applyTheme, themes } from './themes.js';
import './theme.css';

window.DOMPurify = DOMPurify;
window.marked = marked;
const appIcons = { BellOff, CalendarDays, CheckSquare, CircleDashed, Edit2, ExternalLink,
  File, FileText, FlaskConical, FolderKanban, House, Keyboard, LayoutDashboard,
  MessageSquare, MessageSquarePlus, Mic, Play, Plus, PlusCircle, Radio, RefreshCw,
  Save, ScanSearch, Send, Settings, SlidersHorizontal, Sparkles, Square, Trash2, X };
window.lucide = { createIcons: () => createIcons({ icons: appIcons }) };

const stateCopy = {
  idle: ['Ready when you are', 'A little less effort. A little more possibility.'],
  connecting: ['Connecting...', 'Getting your voice ready.'],
  listening: ['Listening...', "Speak naturally — I'm here to help."],
  thinking: ['Thinking...', 'A moment to bring it all together.'],
  speaking: ['Speaking...', 'Here\'s what I found.'],
};
const suggestions = [
  ['file-text', 'Summarize this document', 'Summarize this document:\n\n'],
  ['play', 'Create a presentation on renewable energy', 'Create a presentation on renewable energy'],
  ['sparkles', 'Find interesting facts about space', 'Find interesting facts about space'],
  ['message-square', 'Help me plan a trip', 'Help me plan a trip'],
  ['calendar-days', "What's on my calendar today?", "What's on my calendar today?"],
];

function icon(name) { return h('i', { 'data-lucide': name, 'aria-hidden': 'true' }); }

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const themeKey = 'voice-supervisor-theme-v2';
const soundsKey = 'voice-supervisor-sounds-v1';
const savedTheme = readPreference(themeKey);
const savedSounds = readPreference(soundsKey);
const theme = ref(themes.find(item => item.id === savedTheme) || themes[0]);
const state = ref('idle');
let soundsEnabled = savedSounds === 'true' ? true : savedSounds === 'false' ? false : null;
let interactionAudio = null;
let soundTimeout;

function soundSource(kind) {
  const source = theme.value.sounds[kind];
  if (typeof source !== 'string' || !source) return null;
  try {
    const url = new URL(source, import.meta.url);
    return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function syncSoundControls() {
  const available = Boolean(soundSource('navigation') || soundSource('action'));
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
  if (!audio) return;
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function voiceBusy() {
  return state.value !== 'idle' || document.getElementById('mic-toggle-btn')?.getAttribute('aria-pressed') === 'true';
}

function playSound(kind) {
  if (!(soundsEnabled ?? theme.value.preferences.soundsEnabled) || voiceBusy()
    || document.hidden || !document.hasFocus() || interactionAudio) return;
  const source = soundSource(kind);
  const volume = Math.max(0, Math.min(1, Number(theme.value.preferences.soundVolume) || 0));
  if (!source || !volume) return;
  const audio = new Audio();
  interactionAudio = audio;
  const finish = () => { if (interactionAudio === audio) stopSound(); };
  audio.preload = 'none';
  audio.volume = volume;
  audio.onended = finish;
  audio.onerror = finish;
  soundTimeout = window.setTimeout(finish, 1500);
  audio.src = source;
  try { audio.play()?.catch(finish); } catch { finish(); }
}

function onInteraction(event) {
  if (!event.isTrusted || event.defaultPrevented) return;
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
  if (button.id === 'mic-toggle-btn' || button.closest('#voice-options')) return;
  const kind = button.dataset.themeSound || (button.matches('[data-view], [data-open-view]') ? 'navigation' : null);
  if (kind === 'navigation' || kind === 'action') playSound(kind);
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
  if (voiceBusy()) stopSound();
}

function onTheme(event) {
  const next = themes.find(item => item.id === event.detail?.id);
  if (!next) return;
  stopSound();
  theme.value = next;
  applyTheme(next);
  for (const input of document.querySelectorAll('input[name="appearance"]')) input.checked = input.value === next.id;
  syncSoundControls();
  savePreference(themeKey, next.id);
}

function renderThemeOptions() {
  const options = document.querySelector('.appearance-options');
  if (!options) return;
  options.replaceChildren(...themes.map(item => {
    const label = document.createElement('label');
    label.className = 'appearance-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'appearance';
    input.value = item.id;
    input.checked = item.id === theme.value.id;
    const image = document.createElement('img');
    image.src = item.sprite;
    image.alt = '';
    label.append(input, image, document.createTextNode(item.label));
    return label;
  }));
}

const VoiceHome = {
  name: 'VoiceHome',
  setup() {
    return () => h('div', { class: 'home-composition' }, [
      h('section', { class: 'assistant-stage', 'aria-label': 'Voice assistant' }, [
        h(VoiceSprite, { state: state.value, source: theme.value.sprite, animations: theme.value.animations }),
        h('div', { class: 'presence-copy', role: 'status', 'aria-live': 'polite' }, [
          h('h1', stateCopy[state.value][0]),
          h('p', stateCopy[state.value][1]),
        ]),
      ]),
      h('aside', { class: 'suggestions', 'aria-labelledby': 'suggestions-title' }, [
        h('h2', { id: 'suggestions-title' }, 'Try saying:'),
        ...suggestions.map(([glyph, label, prompt]) => h('button', {
          class: 'suggestion', type: 'button', 'data-theme-sound': 'action',
          onClick: () => window.dispatchEvent(new CustomEvent('voice-supervisor:compose', { detail: { text: prompt } })),
        }, [icon(glyph), h('span', label)])),
      ]),
    ]);
  },
};

applyTheme(theme.value);
renderThemeOptions();
syncSoundControls();
const homeApp = createApp(VoiceHome);
homeApp.mount('#voice-personality-app');
const listeners = new AbortController();
const listenerOptions = { signal: listeners.signal };
window.addEventListener('voice-supervisor:agent-state', onState, listenerOptions);
window.addEventListener('voice-supervisor:theme', onTheme, listenerOptions);
document.addEventListener('click', onInteraction, listenerOptions);
document.addEventListener('change', onSoundPreference, listenerOptions);
document.addEventListener('visibilitychange', stopSound, listenerOptions);
window.addEventListener('blur', stopSound, listenerOptions);
window.addEventListener('pagehide', stopSound, listenerOptions);
if (import.meta.hot) import.meta.hot.dispose(() => {
  listeners.abort();
  stopSound();
  homeApp.unmount();
});
await import('./app.js');