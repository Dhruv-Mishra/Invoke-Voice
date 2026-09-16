import { createApp, h, onBeforeUnmount, onMounted, ref } from 'vue';
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

const VoiceHome = {
  name: 'VoiceHome',
  setup() {
    let savedTheme;
    try { savedTheme = localStorage.getItem('voice-supervisor-theme-v2'); } catch {}
    const theme = ref(themes.find(item => item.id === savedTheme) || themes[0]);
    const state = ref('idle');
    const onState = event => { state.value = stateCopy[event.detail?.state] ? event.detail.state : 'idle'; };
    const onTheme = event => {
      const next = themes.find(item => item.id === event.detail?.id);
      if (!next) return;
      theme.value = next;
      applyTheme(next);
      try { localStorage.setItem('voice-supervisor-theme-v2', next.id); } catch {}
    };
    onMounted(() => {
      applyTheme(theme.value);
      window.addEventListener('voice-supervisor:agent-state', onState);
      window.addEventListener('voice-supervisor:theme', onTheme);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('voice-supervisor:agent-state', onState);
      window.removeEventListener('voice-supervisor:theme', onTheme);
    });
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
          class: 'suggestion', type: 'button',
          onClick: () => window.dispatchEvent(new CustomEvent('voice-supervisor:compose', { detail: { text: prompt } })),
        }, [icon(glyph), h('span', label)])),
      ]),
    ]);
  },
};

createApp(VoiceHome).mount('#voice-personality-app');
await import('./app.js');