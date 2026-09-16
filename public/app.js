// Voice Work Supervisor Frontend Application
// Follows Clawpilot theme and local-only zero-build plain JS architecture

import { createConversationUI } from './conversation-ui.js';

let appConfig = null;
let appState = { areas: [], tasks: [] };
let conversation = []; // [{role, content}]

// Voice session state
let voiceSocket = null;
let audioContext = null;
let mediaStream = null;
let workletNode = null;
let playbackContext = null;
let activeSources = [];
let nextPlayTime = 0;
let isQuietMode = false;
let isCapturing = false;
let isServerReady = false;
let isVoiceThinking = false;
let isVoiceStarting = false;
const pendingNotifications = [];
const pendingPlaybackResponses = new Map();
const responsePlaybackGenerations = new Map();
const playbackFailures = new Set();
let notificationInFlight = null;

// Audio session token & queue
let currentSessionToken = 0;
let audioQueuePromise = Promise.resolve();

// PTT & Mute state
let isMuted = false;
let isPttMode = false;
let isPttHeld = false;

// Active speech tracking for proactive notifications
let lastUserSpeechTime = 0;
const USER_SPEAKING_THRESHOLD = 0.04;
const USER_SPEAKING_COOLDOWN_MS = 2000;

// Chat abort & generation token
let currentChatAbortController = null;
let currentChatToken = 0;

// DOM Elements
const providerSelect = document.getElementById('provider-select');
const modelInput = document.getElementById('model-input');
const modelLabel = document.getElementById('model-label');
const voiceModeSelect = document.getElementById('voice-mode-select');
const allowCloudOpt = document.getElementById('allow-cloud-opt');
const muteMicOpt = document.getElementById('mute-mic-opt');
const pttModeOpt = document.getElementById('ptt-mode-opt');
const quietModeBtn = document.getElementById('quiet-mode-btn');
const quietBadge = document.getElementById('quiet-badge');
const micCanvas = document.getElementById('mic-canvas');
const micToggleBtn = document.getElementById('mic-toggle-btn');
const micBtnLabel = document.getElementById('mic-btn-label');
const pttBtn = document.getElementById('ptt-btn');
const pttBtnLabel = document.getElementById('ptt-btn-label');
const interruptBtn = document.getElementById('interrupt-btn');
const routeStatusBadge = document.getElementById('route-status-badge');
const sessionResetNotice = document.getElementById('session-reset-notice');
const agentSprite = document.getElementById('agent-sprite');
const routeConfigBtn = document.getElementById('route-config-btn');
const routeConfigDialog = document.getElementById('route-config-dialog');
const routeConfigClose = document.getElementById('route-config-close');

const areasList = document.getElementById('areas-list');
const areasDisclosure = document.getElementById('areas-disclosure');
const btnNewArea = document.getElementById('btn-new-area');
const areaDialog = document.getElementById('area-dialog');
const areaForm = document.getElementById('area-form');
const areaDialogTitle = document.getElementById('area-dialog-title');
const areaIdInput = document.getElementById('area-id-input');
const areaNameInput = document.getElementById('area-name-input');
const areaRepoInput = document.getElementById('area-repo-input');
const areaAliasesInput = document.getElementById('area-aliases-input');
const areaInstructionsInput = document.getElementById('area-instructions-input');
const areaAgentSelect = document.getElementById('area-agent-select');
const areaCustomAgentGroup = document.getElementById('area-custom-agent-group');
const areaAgentInput = document.getElementById('area-agent-input');
const areaBaseRefInput = document.getElementById('area-base-ref-input');
const areaAllowPublishInput = document.getElementById('area-allow-publish-input');
const areaDefaultInput = document.getElementById('area-default-input');
const areaDeleteBtn = document.getElementById('area-delete-btn');
const areaCancelBtn = document.getElementById('area-cancel-btn');
const areaDialogClose = document.getElementById('area-dialog-close');

const tasksList = document.getElementById('tasks-list');
const btnNewTask = document.getElementById('btn-new-task');
const btnRefreshTasks = document.getElementById('btn-refresh-tasks');
const newTaskDialog = document.getElementById('new-task-dialog');
const newTaskForm = document.getElementById('new-task-form');
const taskAreaSelect = document.getElementById('task-area-select');
const taskBackendSelect = document.getElementById('task-backend-select');
const taskObjectiveInput = document.getElementById('task-objective-input');
const taskModelSelect = document.getElementById('task-model-select');
const taskContextSelect = document.getElementById('task-context-select');
const taskAgentSelect = document.getElementById('task-agent-select');
const taskCancelBtn = document.getElementById('task-cancel-btn');
const taskDialogClose = document.getElementById('task-dialog-close');

const taskDetailDialog = document.getElementById('task-detail-dialog');
const detailContent = document.getElementById('detail-content');
const detailDeleteTaskBtn = document.getElementById('detail-delete-task-btn');
const detailContinueTaskBtn = document.getElementById('detail-continue-task-btn');
const detailCloseBtn = document.getElementById('detail-close-btn');
const detailDialogClose = document.getElementById('detail-dialog-close');
const detailOpenWorktreeBtn = document.getElementById('detail-open-worktree-btn');

const continueThreadDialog = document.getElementById('continue-thread-dialog');
const continueThreadForm = document.getElementById('continue-thread-form');
const continueDialogTitle = document.getElementById('continue-dialog-title');
const continueTaskIdInput = document.getElementById('continue-task-id');
const continueTaskContext = document.getElementById('continue-task-context');
const continueMessageInput = document.getElementById('continue-message-input');
const continueCancelBtn = document.getElementById('continue-cancel-btn');
const continueDialogClose = document.getElementById('continue-dialog-close');
const continueSendBtn = document.getElementById('continue-send-btn');

const settingsView = document.getElementById('settings-view');
const settingsForm = document.getElementById('settings-form');
const settingsDefaultArea = document.getElementById('settings-default-area');
const settingsDefaultBackend = document.getElementById('settings-default-backend');
const settingsCopilotModel = document.getElementById('settings-copilot-model');
const settingsCopilotContext = document.getElementById('settings-copilot-context');
const settingsNotifyCompleted = document.getElementById('settings-notify-completed');
const settingsNotifyNeedsInput = document.getElementById('settings-notify-needs-input');
const settingsNotifyFailed = document.getElementById('settings-notify-failed');
const settingsVoiceNotifications = document.getElementById('settings-voice-notifications');
const settingsBrowserNotifications = document.getElementById('settings-browser-notifications');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsFeedback = document.getElementById('settings-feedback');
const integrationsTableBody = document.getElementById('integrations-table-body');

const chatMessages = document.getElementById('chat-messages');
const partialTranscript = document.getElementById('partial-transcript');
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');
const btnClearChat = document.getElementById('btn-clear-chat');

const viewTabs = [...document.querySelectorAll('.view-tab')];
const workspaceView = document.getElementById('workspace-view');
const toolLabView = document.getElementById('tool-lab-view');
const toolCount = document.getElementById('tool-count');
const toolList = document.getElementById('tool-list');
const toolName = document.getElementById('tool-name');
const toolDescription = document.getElementById('tool-description');
const toolKindBadge = document.getElementById('tool-kind-badge');
const toolForm = document.getElementById('tool-form');
const toolRunStatus = document.getElementById('tool-run-status');
const toolResult = document.getElementById('tool-result');
let availableTools = [];
let selectedTool = null;

function getCodingBackends() {
  if (Array.isArray(appConfig?.codingBackends) && appConfig.codingBackends.length > 0) {
    return appConfig.codingBackends;
  }
  return [
    { id: 'copilot', label: 'Copilot CLI', description: 'GitHub Copilot CLI backend' },
    { id: 'agency', label: 'Agency', description: 'Agency shared backend' }
  ];
}

function backendLabel(id) {
  const found = getCodingBackends().find(b => b.id === id);
  if (found?.label) return found.label;
  return id === 'agency' ? 'Agency' : id === 'copilot' ? 'Copilot' : (id || 'Copilot');
}

function setAgentState(state) {
  if (!agentSprite) return;
  const next = ['idle', 'connecting', 'listening', 'thinking', 'speaking'].includes(state) ? state : 'idle';
  agentSprite.dataset.state = next;
  const label = agentSprite.querySelector('.agent-state-label');
  if (label) label.textContent = next;
  agentSprite.setAttribute('aria-label', `Agent ${next}`);
  agentSprite.title = `Agent ${next}`;
  document.querySelector('.voice-strip').dataset.state = next;
  const active = isVoiceStarting || Boolean(voiceSocket);
  const microphoneLabel = active ? 'Disconnect microphone' : micToggleBtn.disabled ? `Microphone unavailable: ${routeStatusBadge.textContent}` : 'Connect microphone';
  micToggleBtn.title = microphoneLabel;
  micToggleBtn.setAttribute('aria-label', microphoneLabel);
  micToggleBtn.setAttribute('aria-pressed', String(active));
  document.getElementById('voice-route-status').textContent = routeStatusBadge.textContent;
  window.dispatchEvent(new CustomEvent('voice-supervisor:agent-state', { detail: { state: next } }));
}

const MARKDOWN_TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'em', 'strong', 'i', 'b', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'pre', 'a', 'hr'];

function renderSafeMarkdown(target, text) {
  const source = text == null ? '' : String(text);
  try {
    if (!target || !window.marked || !window.DOMPurify) {
      if (target) target.textContent = source;
      return;
    }
    const parsed = window.marked.parse(source, { async: false, gfm: true, breaks: true });
    const clean = window.DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: ['href', 'title'],
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ['img', 'svg', 'math', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'script', 'style', 'link', 'meta', 'base'],
      FORBID_ATTR: ['style', 'class', 'id']
    });
    target.innerHTML = clean;
    target.classList.add('md-content');
    for (const anchor of target.querySelectorAll('a')) {
      const href = anchor.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) {
        anchor.removeAttribute('href');
        continue;
      }
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  } catch (_) {
    target.textContent = source;
  }
}

function applyState(state) {
  appState = state && typeof state === 'object' ? state : { areas: [], tasks: [], settings: {} };
  if (!Array.isArray(appState.areas)) appState.areas = [];
  if (!Array.isArray(appState.tasks)) appState.tasks = [];
  if (!appState.settings || typeof appState.settings !== 'object') appState.settings = {};
  renderAreas();
  renderTasks();
  renderFiles();
  populateSettingsView();
  updateIcons();
}

// Safe icon refreshment
function updateIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
updateIcons();

function activateView(viewName) {
  document.body.dataset.view = viewName;
  workspaceView.hidden = viewName !== 'workspace';
  toolLabView.hidden = viewName !== 'tool-lab';
  if (settingsView) settingsView.hidden = viewName !== 'settings';
  document.getElementById('calendar-view').hidden = viewName !== 'calendar';
  document.getElementById('files-view').hidden = viewName !== 'files';
  for (const tab of viewTabs) {
    const selected = tab.dataset.view === (viewName === 'tool-lab' ? 'settings' : viewName);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  if (viewName === 'settings') {
    populateSettingsView();
  }
  updateIcons();
}

viewTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateView(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? viewTabs.length - 1 : index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1);
    nextIndex = (nextIndex + viewTabs.length) % viewTabs.length;
    viewTabs[nextIndex].focus();
    activateView(viewTabs[nextIndex].dataset.view);
  });
});

document.querySelectorAll('[data-open-view]').forEach(button => {
  button.addEventListener('click', () => activateView(button.dataset.openView));
});
document.getElementById('settings-route-btn').addEventListener('click', () => routeConfigBtn.click());
document.getElementById('dock-route-btn').addEventListener('click', () => {
  closeVoiceOptions();
  routeConfigBtn.click();
});
document.getElementById('calendar-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
window.addEventListener('voice-supervisor:theme', () => drawMicLevel(0));

const conversationDialog = document.getElementById('conversation-dialog');
function openConversation(text) {
  if (typeof text === 'string') chatInput.value = text;
  if (!conversationDialog.open) conversationDialog.showModal();
  chatInput.focus();
}
const conversationUI = createConversationUI(document, openConversation);
document.getElementById('open-chat-btn').addEventListener('click', () => openConversation());
document.getElementById('close-chat-btn').addEventListener('click', () => conversationDialog.close());
window.addEventListener('voice-supervisor:compose', event => openConversation(event.detail?.text));
const voiceOptions = document.getElementById('voice-options');
const voiceOptionsButton = document.getElementById('voice-options-btn');
function closeVoiceOptions() {
  voiceOptions.hidden = true;
  voiceOptionsButton.setAttribute('aria-expanded', 'false');
}
voiceOptionsButton.addEventListener('click', () => {
  voiceOptions.hidden = !voiceOptions.hidden;
  voiceOptionsButton.setAttribute('aria-expanded', String(!voiceOptions.hidden));
});
document.addEventListener('click', event => {
  if (!voiceOptions.contains(event.target) && !voiceOptionsButton.contains(event.target)) closeVoiceOptions();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !voiceOptions.hidden) { closeVoiceOptions(); voiceOptionsButton.focus(); }
});

function renderFiles() {
  const list = document.getElementById('files-list');
  list.replaceChildren();
  for (const area of appState.areas) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const glyph = document.createElement('i');
    glyph.dataset.lucide = 'folder-kanban';
    const detail = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = area.name;
    const path = document.createElement('p');
    path.textContent = area.repoPath || area.repo || '';
    detail.append(title, path);
    row.append(glyph, detail);
    list.appendChild(row);
  }
  if (!appState.areas.length) list.textContent = 'No work areas registered.';
}
const documentInput = document.getElementById('document-input');
document.getElementById('import-document-btn').addEventListener('click', () => documentInput.click());
documentInput.addEventListener('change', async () => {
  const file = documentInput.files?.[0];
  if (!file) return;
  const feedback = document.getElementById('document-feedback');
  try {
    if (!/\.(txt|md|json|csv|log)$/i.test(file.name)) throw new Error('Choose a text, Markdown, JSON, CSV, or log file.');
    if (file.size > 100000) throw new Error('Choose a document smaller than 100 KB.');
    const text = await file.text();
    openConversation(`Summarize this document (${file.name}):\n\n${text}`);
    feedback.textContent = `${file.name} is ready to send.`;
  } catch (error) { feedback.textContent = error.message; }
  documentInput.value = '';
});
activateView('home');

// Microphone Level Visualizer
const canvasCtx = micCanvas.getContext('2d');
function drawMicLevel(level) {
  if (micCanvas.hidden) return;
  const width = micCanvas.width;
  const height = micCanvas.height;
  canvasCtx.clearRect(0, 0, width, height);
  canvasCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--cp-wave').trim();
  for (let index = 0; index < 42; index++) {
    const sideIndex = index % 21;
    const envelope = Math.exp(-Math.pow((sideIndex - 10) / 6, 2));
    const variation = 0.55 + 0.45 * Math.abs(Math.sin(index * 2.3 + level * 15));
    const barHeight = 5 + envelope * (height * .85) * variation * (0.85 + Math.min(level * 4, .15));
    const position = index < 21 ? 8 + index * 10 : width - 208 + sideIndex * 10;
    canvasCtx.globalAlpha = .25 + envelope * .6;
    canvasCtx.beginPath();
    canvasCtx.roundRect(position, (height - barHeight) / 2, 5, barHeight, 3);
    canvasCtx.fill();
  }
  canvasCtx.globalAlpha = 1;
}
drawMicLevel(0);

// Base64 helper for PCM16 audio chunks
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function isIntegratedVoiceMode(modeId) {
  return modeId === 'gemini-live' || modeId === 'openai-realtime';
}

// Check selected route configuration
function getSelectedRouteStatus() {
  if (!appConfig) return { configured: false, label: 'Loading...' };
  const mode = voiceModeSelect.value;
  const vm = appConfig.voiceModes?.find(v => v.id === mode);
  const isVmConfigured = Boolean(vm?.configured);

  // Integrated realtime modes operate independently of the text provider
  if (isIntegratedVoiceMode(mode)) {
    if (!isVmConfigured) {
      return { configured: false, label: 'Voice Mode Unconfigured' };
    }
    return { configured: true, label: 'Route Ready' };
  }

  // Local / cascade mode requires voice mode + text provider
  const prov = appConfig.providers?.find(p => p.id === providerSelect.value);
  const isProvConfigured = Boolean(prov?.configured);

  if (!isVmConfigured) {
    return { configured: false, label: 'Voice Mode Unconfigured' };
  }
  if (!isProvConfigured) {
    return { configured: false, label: 'Provider Unconfigured' };
  }
  return { configured: true, label: 'Route Ready' };
}

function updateRouteReadiness() {
  const status = getSelectedRouteStatus();
  if (voiceSocket) {
    if (isServerReady) {
      routeStatusBadge.textContent = 'Voice Live';
      routeStatusBadge.className = 'badge badge-success';
      if (!isVoiceThinking && activeSources.length === 0) setAgentState('listening');
    } else {
      routeStatusBadge.textContent = 'Connecting...';
      routeStatusBadge.className = 'badge badge-warning';
      setAgentState('connecting');
    }
  } else {
    routeStatusBadge.textContent = status.label;
    if (status.configured) {
      routeStatusBadge.className = 'badge badge-success';
      micToggleBtn.disabled = false;
    } else {
      routeStatusBadge.className = 'badge badge-warning';
      micToggleBtn.disabled = true;
    }
    setAgentState('idle');
  }

  const mode = voiceModeSelect?.value;
  const vm = appConfig?.voiceModes?.find(v => v.id === mode);
  const isIntegrated = isIntegratedVoiceMode(mode);
  if (modelLabel) {
    modelLabel.textContent = 'Model';
  }
  if (isIntegrated && vm?.model) {
    modelInput.title = `Text chat model (${providerSelect.value}). Realtime voice uses env model: ${vm.model}`;
  } else {
    modelInput.title = 'Model identifier for text chat and local/cascade voice LLM';
  }
}

// Conversation rendering
function appendMessage(role, text, options = {}) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  if ((role === 'assistant' || role === 'tool') && !options.plain) {
    renderSafeMarkdown(bubble, text);
  } else {
    bubble.textContent = text;
  }
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  conversationUI.message(role, text, bubble);
}

function notifyReset(reason) {
  sessionResetNotice.style.display = 'inline-flex';
  sessionResetNotice.textContent = `Session Reset: ${reason}`;
  appendMessage('system', `[Session context reset due to ${reason}]`);
}

// Provider / Mode Switch Reset Handler
function handleRouteSwitch(reason) {
  if (currentChatAbortController) {
    currentChatAbortController.abort();
    currentChatAbortController = null;
  }
  currentChatToken++;

  if (voiceSocket) {
    stopVoiceSession();
  }
  conversation = [];
  chatMessages.replaceChildren();
  conversationUI.clear();
  partialTranscript.style.display = 'none';
  partialTranscript.textContent = '';
  notifyReset(reason);
  updateRouteReadiness();
}

// Audio Playback Queue
function getPlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (playbackContext.state === 'suspended') {
    playbackContext.resume();
  }
  return playbackContext;
}

let playbackGeneration = 0;
let pendingCommit = false;

function sendPlaybackOutcome(responseId, outcome) {
  if (!pendingPlaybackResponses.has(responseId)) return;
  pendingPlaybackResponses.delete(responseId);
  responsePlaybackGenerations.delete(responseId);
  if (voiceSocket?.readyState === WebSocket.OPEN) {
    voiceSocket.send(JSON.stringify({ type: 'playback_done', responseId, outcome }));
  }
}

function maybeCompletePlayback(responseId) {
  const pending = pendingPlaybackResponses.get(responseId);
  if (!pending) return;
  if (pending.generation !== playbackGeneration) return sendPlaybackOutcome(responseId, 'interrupted');
  if (activeSources.some(source => source.voiceResponseId === responseId)) return;
  sendPlaybackOutcome(responseId, pending.failed || playbackFailures.delete(responseId) ? 'failed' : 'played');
}

function markResponseEnd(responseId, playable = true) {
  if (!responseId || pendingPlaybackResponses.has(responseId)) return;
  const generation = responsePlaybackGenerations.get(responseId)?.generation ?? playbackGeneration;
  pendingPlaybackResponses.set(responseId, { generation, failed: !playable });
  audioQueuePromise.then(() => {
    maybeCompletePlayback(responseId);
  });
}

function scheduleAudioBuffer(buffer, token, responseId) {
  if (token !== undefined && token !== playbackGeneration) return;
  const ctx = getPlaybackContext();
  const now = ctx.currentTime;
  if (nextPlayTime < now) {
    nextPlayTime = now + 0.02;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.voiceResponseId = responseId;
  source.connect(ctx.destination);
  source.start(nextPlayTime);
  setAgentState('speaking');
  activeSources.push(source);
  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx !== -1) activeSources.splice(idx, 1);
    if (responseId) maybeCompletePlayback(responseId);
    if (isServerReady && activeSources.length === 0 && !isVoiceThinking) setAgentState('listening');
  };
  nextPlayTime += buffer.duration;
}

function clearPlayback() {
  for (const responseId of [...pendingPlaybackResponses.keys()]) sendPlaybackOutcome(responseId, 'interrupted');
  playbackFailures.clear();
  playbackGeneration++;
  audioQueuePromise = Promise.resolve();
  for (const src of activeSources) {
    try { src.stop(); src.disconnect(); } catch (_) {}
  }
  activeSources = [];
  if (playbackContext) {
    nextPlayTime = playbackContext.currentTime;
  }
}

async function playAudioChunk(base64Data, mimeType, sampleRate, token, responseId) {
  if (token !== playbackGeneration) return;
  const ctx = getPlaybackContext();
  const binary = atob(base64Data);
  const len = binary.length;
  if (len === 0) throw new Error('Received an empty audio chunk');
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (mimeType === 'audio/wav') {
    try {
      const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
      if (token !== playbackGeneration) return;
      scheduleAudioBuffer(decoded, token, responseId);
    } catch (e) {
      if (token === playbackGeneration) throw e;
    }
  } else {
    if (token !== playbackGeneration) return;
    if (len % 2 !== 0) throw new Error('Received an invalid PCM audio chunk');
    // PCM 16-bit mono
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      const val = int16[i];
      float32[i] = val < 0 ? val / 32768 : val / 32767;
    }
    const rate = sampleRate || 24000;
    const buf = ctx.createBuffer(1, float32.length, rate);
    buf.copyToChannel(float32, 0);
    scheduleAudioBuffer(buf, token, responseId);
  }
}

function queueAudioChunk(data, token) {
  if (data.responseId && !responsePlaybackGenerations.has(data.responseId)) {
    responsePlaybackGenerations.set(data.responseId, { generation: token, seenAt: Date.now() });
    if (responsePlaybackGenerations.size > 100) responsePlaybackGenerations.delete(responsePlaybackGenerations.keys().next().value);
  }
  audioQueuePromise = audioQueuePromise.then(async () => {
    if (token !== playbackGeneration) return;
    await playAudioChunk(data.data, data.mimeType, data.sampleRate, token, data.responseId);
  }).catch((err) => {
    if (data.responseId) playbackFailures.add(data.responseId);
    console.error('Audio playback queue error:', err);
  });
}

// Gating and Hold State for Push-to-Talk and Mute
function shouldForwardAudio() {
  if (isMuted) return false;
  if (isPttMode) return isPttHeld;
  return true;
}

function startPttHold() {
  if (!isPttMode || isPttHeld) return;
  if (!voiceSocket || voiceSocket.readyState !== WebSocket.OPEN || !isServerReady) return;
  if (isMuted || pendingCommit) return;
  workletNode?.port.postMessage({ type: 'reset' });
  isPttHeld = true;
  pttBtn.classList.add('btn-accent');
}

function flushAndCommit() {
  if (!workletNode || pendingCommit || !isServerReady) return;
  pendingCommit = true;
  workletNode.port.postMessage({ type: 'flush' });
}

function endPttHold() {
  if (!isPttHeld) return;
  isPttHeld = false;
  pttBtn.classList.remove('btn-accent');
  if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN && isServerReady) {
    flushAndCommit();
  }
}

// Proactive Speech Activity Tracking
function isUserSpeaking() {
  if (isMuted) return false;
  if (isPttMode && isPttHeld) return true;
  return (Date.now() - lastUserSpeechTime) < USER_SPEAKING_COOLDOWN_MS;
}

function isAssistantSpeaking() {
  if (activeSources.length > 0) return true;
  if (playbackContext && nextPlayTime > playbackContext.currentTime) return true;
  return false;
}

// Voice Session & AudioWorklet capture
async function startVoiceSession() {
  if (isVoiceStarting || voiceSocket || isCapturing) return;
  const route = getSelectedRouteStatus();
  if (!route.configured) {
    alert('Selected route is not configured.');
    return;
  }

  const mode = voiceModeSelect.value;
  const provider = providerSelect.value;
  const textModel = modelInput.value.trim();
  const allowCloud = allowCloudOpt.checked;
  const isIntegrated = isIntegratedVoiceMode(mode);
  const vm = appConfig.voiceModes?.find(v => v.id === mode);
  const effectiveModel = isIntegrated ? (vm?.model || textModel) : textModel;

  if (mode === 'local' && provider !== 'local' && !allowCloud) {
    const confirmHybrid = confirm('Local voice with cloud LLM requires sending transcripts to hosted service. Enable Allow Cloud Hybrid?');
    if (confirmHybrid) {
      allowCloudOpt.checked = true;
    } else {
      return;
    }
  }

  const sessionToken = ++currentSessionToken;
  isServerReady = false;
  isVoiceStarting = true;
  let sessionAudioContext;
  let sessionMediaStream;

  try {
    micBtnLabel.textContent = 'Connecting...';
    micToggleBtn.disabled = false;
    micToggleBtn.className = 'btn btn-danger';
    routeStatusBadge.textContent = 'Connecting...';
    routeStatusBadge.className = 'badge badge-warning';
    setAgentState('connecting');

    sessionAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (sessionAudioContext.state === 'suspended') {
      await sessionAudioContext.resume();
    }
    if (sessionToken !== currentSessionToken) {
      await sessionAudioContext.close().catch(() => {});
      return;
    }
    await sessionAudioContext.audioWorklet.addModule('/capture-worklet.js');
    if (sessionToken !== currentSessionToken) {
      await sessionAudioContext.close().catch(() => {});
      return;
    }

    sessionMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    if (sessionToken !== currentSessionToken) {
      sessionMediaStream.getTracks().forEach(track => track.stop());
      await sessionAudioContext.close().catch(() => {});
      return;
    }
    for (const track of sessionMediaStream.getAudioTracks()) track.enabled = !isMuted;

    const source = sessionAudioContext.createMediaStreamSource(sessionMediaStream);
    const sessionWorkletNode = new AudioWorkletNode(sessionAudioContext, 'capture-worklet');

    sessionWorkletNode.port.onmessage = (event) => {
      if (sessionToken !== currentSessionToken) return;
      const msg = event.data;
      if (msg.type === 'level') {
        drawMicLevel(isMuted ? 0 : msg.peak);
        if (msg.peak > USER_SPEAKING_THRESHOLD && !isMuted) {
          lastUserSpeechTime = Date.now();
        }
      } else if (msg.type === 'audio') {
        // Forward PCM only when socket open, server is ready, and mute/PTT permits
        if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN && isServerReady && !isMuted && (shouldForwardAudio() || (msg.flushed && pendingCommit))) {
          const b64 = arrayBufferToBase64(msg.audioData);
          voiceSocket.send(JSON.stringify({ type: 'audio', data: b64 }));
        }
      } else if (msg.type === 'flushed' && pendingCommit) {
        pendingCommit = false;
        if (voiceSocket?.readyState === WebSocket.OPEN && isServerReady) voiceSocket.send(JSON.stringify({ type: 'commit' }));
      }
    };

    source.connect(sessionWorkletNode);
    // Connect worklet to a mute gain so audio keeps flowing without speaker feedback
    const muteGain = sessionAudioContext.createGain();
    muteGain.gain.value = 0;
    sessionWorkletNode.connect(muteGain);
    muteGain.connect(sessionAudioContext.destination);

    audioContext = sessionAudioContext;
    mediaStream = sessionMediaStream;
    workletNode = sessionWorkletNode;

    // WebSocket connection
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sessionSocket = new WebSocket(`${proto}//${window.location.host}/voice`);
    voiceSocket = sessionSocket;

    sessionSocket.onopen = () => {
      if (sessionToken !== currentSessionToken) {
        try { sessionSocket.close(); } catch (_) {}
        return;
      }
      // Send start handshake; do NOT send PCM or claim connected until server sends 'ready'
      sessionSocket.send(JSON.stringify({
        type: 'start',
        mode,
        provider,
        model: effectiveModel,
        allowCloud: allowCloudOpt.checked
      }));
    };

    sessionSocket.onmessage = (event) => {
      if (sessionToken !== currentSessionToken) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ready') {
          isVoiceStarting = false;
          isServerReady = true;
          isCapturing = true;
          micBtnLabel.textContent = 'Disconnect Mic';
          micToggleBtn.disabled = false;
          micToggleBtn.className = 'btn btn-danger';
          pttBtn.disabled = false;
          interruptBtn.disabled = false;
          routeStatusBadge.textContent = 'Voice Live';
          routeStatusBadge.className = 'badge badge-success';
          setAgentState('listening');
          sessionResetNotice.style.display = 'none';
          appendMessage('system', 'Voice session initialized & ready.');
        } else if (data.type === 'audio') {
          isVoiceThinking = false;
          setAgentState('speaking');
          queueAudioChunk(data, playbackGeneration);
        } else if (data.type === 'response_end') {
          markResponseEnd(data.responseId, data.playable !== false);
        } else if (data.type === 'notify_ack') {
          const index = pendingNotifications.findIndex(notification => notification.id === data.notificationId);
          if (index !== -1) pendingNotifications.splice(index, 1);
          if (notificationInFlight?.id === data.notificationId) notificationInFlight = null;
        } else if (data.type === 'transcript') {
          if (data.role === 'user' && !data.partial) { isVoiceThinking = true; setAgentState('thinking'); }
          else if (data.role === 'user') setAgentState('listening');
          if (data.partial) {
            partialTranscript.style.display = 'block';
            partialTranscript.textContent = `${data.role}: ${data.text}...`;
            conversationUI.preview(data.role || 'assistant', data.text);
          } else {
            partialTranscript.style.display = 'none';
            partialTranscript.textContent = '';
            appendMessage(data.role || 'assistant', data.text);
          }
        } else if (data.type === 'interrupted') {
          conversationUI.clearCaption();
          isVoiceThinking = false;
          setAgentState('listening');
          clearPlayback();
          partialTranscript.style.display = 'none';
          appendMessage('system', '[Speech interrupted]');
        } else if (data.type === 'tool') {
          console.debug('Voice tool completed', data.name);
        } else if (data.type === 'state') {
          isVoiceThinking = data.state === 'thinking';
          setAgentState(['thinking', 'speaking', 'listening'].includes(data.state) ? data.state : 'listening');
          routeStatusBadge.textContent = `Voice: ${data.state}`;
        } else if (data.type === 'error') {
          conversationUI.clearCaption();
          appendMessage('system', `Voice Error: ${data.message || 'Unknown error'}`);
          if (data.fatal) {
            stopVoiceSession();
          }
        }
      } catch (err) {
        console.error('Error handling voice socket message', err);
      }
    };

    sessionSocket.onerror = (err) => {
      if (sessionToken !== currentSessionToken) return;
      console.error('Voice socket error', err);
      appendMessage('system', 'Voice WebSocket connection error.');
      stopVoiceSession();
    };

    sessionSocket.onclose = () => {
      if (sessionToken !== currentSessionToken) return;
      stopVoiceSession();
      appendMessage('system', 'Voice disconnected.');
    };

  } catch (err) {
    if (sessionMediaStream && sessionMediaStream !== mediaStream) sessionMediaStream.getTracks().forEach(track => track.stop());
    if (sessionAudioContext && sessionAudioContext !== audioContext) await sessionAudioContext.close().catch(() => {});
    if (sessionToken !== currentSessionToken) return;
    console.error('Failed to start voice', err);
    alert(`Could not start microphone: ${err.message}`);
    stopVoiceSession();
  }
}

function stopVoiceSession() {
  conversationUI.clearCaption();
  currentSessionToken++;
  isVoiceStarting = false;
  pendingCommit = false;
  isVoiceThinking = false;
  notificationInFlight = null;
  isServerReady = false;
  isCapturing = false;
  isPttHeld = false;
  setAgentState('idle');
  if (pttBtn) pttBtn.classList.remove('btn-accent');

  if (voiceSocket) {
    if (voiceSocket.readyState === WebSocket.OPEN) {
      try {
        if (workletNode) workletNode.port.postMessage({ type: 'flush' });
        voiceSocket.send(JSON.stringify({ type: 'stop' }));
      } catch (_) {}
    }
    voiceSocket.onopen = null;
    voiceSocket.onmessage = null;
    voiceSocket.onerror = null;
    voiceSocket.onclose = null;
    try { voiceSocket.close(); } catch (_) {}
    voiceSocket = null;
  }

  if (workletNode) {
    try { workletNode.disconnect(); } catch (_) {}
    workletNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  clearPlayback();
  drawMicLevel(0);

  micBtnLabel.textContent = 'Connect Mic';
  micToggleBtn.className = 'btn btn-accent';
  pttBtn.disabled = true;
  interruptBtn.disabled = true;
  updateRouteReadiness();
}

// Push to Talk, Mute & Interrupt
muteMicOpt.addEventListener('change', () => {
  isMuted = muteMicOpt.checked;
  if (isMuted && isPttHeld) {
    endPttHold();
  }
  for (const track of mediaStream?.getAudioTracks() || []) track.enabled = !isMuted;
  workletNode?.port.postMessage({ type: 'reset' });
  drawMicLevel(0);
});

pttModeOpt.addEventListener('change', () => {
  isPttMode = pttModeOpt.checked;
  if (isPttMode) {
    pttBtnLabel.textContent = 'Push to Talk';
    pttBtn.title = 'Hold while speaking or hold Spacebar, release to commit';
  } else {
    pttBtnLabel.textContent = 'Commit';
    pttBtn.title = 'Click to flush and commit speech';
    if (isPttHeld) {
      endPttHold();
    }
  }
});

pttBtn.addEventListener('pointerdown', (e) => {
  if (!voiceSocket || voiceSocket.readyState !== WebSocket.OPEN || !isServerReady) return;
  if (!isPttMode) {
    flushAndCommit();
    return;
  }
  startPttHold();
  try { pttBtn.setPointerCapture(e.pointerId); } catch (_) {}
});

pttBtn.addEventListener('pointerup', (e) => {
  if (isPttMode) {
    endPttHold();
    try { pttBtn.releasePointerCapture(e.pointerId); } catch (_) {}
  }
});

pttBtn.addEventListener('pointercancel', (e) => {
  if (isPttMode) {
    endPttHold();
    try { pttBtn.releasePointerCapture(e.pointerId); } catch (_) {}
  }
});

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], dialog'));
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && isPttMode && !isPttHeld && !e.repeat) {
    if (!isInteractiveTarget(e.target) && voiceSocket && voiceSocket.readyState === WebSocket.OPEN && isServerReady) {
      e.preventDefault();
      startPttHold();
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && isPttMode && isPttHeld) {
    if (!isInteractiveTarget(e.target)) e.preventDefault();
    endPttHold();
  }
});

window.addEventListener('blur', endPttHold);
document.addEventListener('visibilitychange', () => { if (document.hidden) endPttHold(); });

interruptBtn.addEventListener('click', () => {
  conversationUI.clearCaption();
  clearPlayback();
  if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
    voiceSocket.send(JSON.stringify({ type: 'interrupt' }));
  }
});

micToggleBtn.addEventListener('click', () => {
  if (isVoiceStarting || voiceSocket || isCapturing) {
    stopVoiceSession();
  } else {
    startVoiceSession();
  }
});

// Quiet Mode
quietModeBtn.addEventListener('click', () => {
  isQuietMode = !isQuietMode;
  if (isQuietMode) {
    pendingNotifications.length = 0;
    quietBadge.style.display = 'inline-flex';
    quietModeBtn.classList.add('btn-accent');
  } else {
    quietBadge.style.display = 'none';
    quietModeBtn.classList.remove('btn-accent');
  }
});

// Event Source for state and notifications
function initEventSource() {
  const events = new EventSource('/api/events');
  events.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'state' && data.state) {
        applyState(data.state);
      } else if (data.type === 'notification' && data.notification) {
        handleNotification(data.notification);
      }
    } catch (e) {
      console.error('Failed parsing event data', e);
    }
  };
  events.onerror = () => {
    // EventSource will auto-reconnect
  };
}

function isNotificationScenarioEnabled(state) {
  const settings = appState?.settings || {};
  if (state === 'completed' || state === 'result_ready') {
    return settings.notifyCompleted !== false;
  }
  if (state === 'needs_input') {
    return settings.notifyNeedsInput !== false;
  }
  if (state === 'failed' || state === 'agent_failed') {
    return settings.notifyFailed !== false;
  }
  return true;
}

function handleNotification(n) {
  if (!n) return;
  const settings = appState?.settings || {};

  if (isNotificationScenarioEnabled(n.state)) {
    const text = `[Notification] ${n.title}: ${n.text || n.state}`;
    appendMessage('system', text);
  }

  if (settings.browserNotifications && isNotificationScenarioEnabled(n.state) && typeof window.Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(n.title || 'Voice Supervisor', {
        body: n.text || n.state || 'Task update'
      });
    } catch (_) {}
  }

  if (settings.voiceNotifications !== false && isNotificationScenarioEnabled(n.state) && !isQuietMode) {
    pendingNotifications.push({ id: crypto.randomUUID(), text: `${n.title}: ${n.text || n.state}` });
  }
}

setInterval(() => {
  if (!pendingNotifications.length || isQuietMode || !isServerReady || isVoiceThinking || isUserSpeaking() || isAssistantSpeaking()) return;
  if (voiceSocket?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  const notification = pendingNotifications[0];
  if (notificationInFlight?.id === notification.id && now - notificationInFlight.sentAt < 2000) return;
  notificationInFlight = { id: notification.id, sentAt: now };
  voiceSocket.send(JSON.stringify({ type: 'notify', notificationId: notification.id, text: notification.text }));
}, 750);

function populateSettingsOptions() {
  if (!appConfig) return;
  if (settingsDefaultBackend) {
    settingsDefaultBackend.replaceChildren();
    getCodingBackends().forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.label || b.id;
      settingsDefaultBackend.appendChild(opt);
    });
  }

  if (settingsCopilotModel) {
    settingsCopilotModel.replaceChildren();
    (appConfig.copilotModels || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      settingsCopilotModel.appendChild(opt);
    });
  }

  if (settingsCopilotContext) {
    settingsCopilotContext.replaceChildren();
    (appConfig.copilotContexts || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label || c.id;
      settingsCopilotContext.appendChild(opt);
    });
  }
}

function populateIntegrationsTable() {
  if (!appConfig || !integrationsTableBody) return;
  integrationsTableBody.replaceChildren();
  const list = appConfig.integrations || [];
  if (list.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'empty-detail';
    td.textContent = 'No integrations reported.';
    tr.appendChild(td);
    integrationsTableBody.appendChild(tr);
    return;
  }
  list.forEach(item => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.label || item.id;

    const tdStatus = document.createElement('td');
    const statusBadge = document.createElement('span');
    const isOk = ['configured', 'workspace_configured'].includes(item.status);
    statusBadge.className = `badge ${isOk ? 'badge-success' : 'badge-warning'}`;
    statusBadge.textContent = item.status || 'unknown';
    tdStatus.appendChild(statusBadge);

    const tdMode = document.createElement('td');
    const modeBadge = document.createElement('span');
    modeBadge.className = 'badge';
    modeBadge.textContent = item.mode || 'read_only';
    tdMode.appendChild(modeBadge);

    tr.append(tdName, tdStatus, tdMode);
    integrationsTableBody.appendChild(tr);
  });
}

function populateSettingsView() {
  if (!settingsDefaultArea) return;
  settingsDefaultArea.replaceChildren();
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '(No default area)';
  settingsDefaultArea.appendChild(emptyOpt);

  (appState.areas || []).forEach(area => {
    const opt = document.createElement('option');
    opt.value = area.id;
    opt.textContent = area.name;
    settingsDefaultArea.appendChild(opt);
  });

  settingsDefaultArea.value = appState.settings?.defaultAreaId || '';

  if (settingsDefaultBackend) {
    if (settingsDefaultBackend.options.length === 0) {
      getCodingBackends().forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.label || b.id;
        settingsDefaultBackend.appendChild(opt);
      });
    }
    settingsDefaultBackend.value = appState.settings?.defaultBackend || appConfig?.defaults?.codingBackend || 'copilot';
  }

  if (appConfig) {
    if (settingsCopilotModel.options.length === 0) populateSettingsOptions();
    if (appState.settings?.copilotModel) {
      settingsCopilotModel.value = appState.settings.copilotModel;
    } else if (appConfig.defaults?.copilotModel) {
      settingsCopilotModel.value = appConfig.defaults.copilotModel;
    }

    if (appState.settings?.copilotContext) {
      settingsCopilotContext.value = appState.settings.copilotContext;
    } else if (appConfig.defaults?.copilotContext) {
      settingsCopilotContext.value = appConfig.defaults.copilotContext;
    }
  }
  const s = appState.settings || {};
  if (settingsNotifyCompleted) settingsNotifyCompleted.checked = s.notifyCompleted !== false;
  if (settingsNotifyNeedsInput) settingsNotifyNeedsInput.checked = s.notifyNeedsInput !== false;
  if (settingsNotifyFailed) settingsNotifyFailed.checked = s.notifyFailed !== false;
  if (settingsVoiceNotifications) settingsVoiceNotifications.checked = s.voiceNotifications !== false;
  if (settingsBrowserNotifications) settingsBrowserNotifications.checked = s.browserNotifications !== false;

  populateIntegrationsTable();
}

if (settingsForm) {
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (settingsFeedback) {
      settingsFeedback.textContent = '';
      settingsFeedback.className = 'settings-feedback';
    }

    const defaultAreaId = settingsDefaultArea.value || null;
    const defaultBackend = settingsDefaultBackend ? settingsDefaultBackend.value : (appState.settings?.defaultBackend || 'copilot');
    const copilotModel = settingsCopilotModel.value;
    const copilotContext = settingsCopilotContext.value;
    const notifyCompleted = settingsNotifyCompleted.checked;
    const notifyNeedsInput = settingsNotifyNeedsInput.checked;
    const notifyFailed = settingsNotifyFailed.checked;
    const voiceNotifications = settingsVoiceNotifications.checked;
    const browserNotifications = settingsBrowserNotifications.checked;

    if (browserNotifications && typeof window.Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch (_) {}
    }
    const browserAllowed = browserNotifications && typeof window.Notification !== 'undefined' && Notification.permission === 'granted';

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultAreaId,
          defaultBackend,
          copilotModel,
          copilotContext,
          notifyCompleted,
          notifyNeedsInput,
          notifyFailed,
          voiceNotifications,
          browserNotifications: browserAllowed
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const updated = await res.json();
      appState.settings = updated;
      if (settingsFeedback) {
        settingsFeedback.textContent = browserNotifications && !browserAllowed ? 'Settings saved; browser notifications were not permitted.' : 'Settings saved.';
      }
      await loadState();
    } catch (err) {
      if (settingsFeedback) {
        settingsFeedback.textContent = `Error: ${err.message}`;
        settingsFeedback.className = 'settings-feedback error';
      }
    }
  });
}

// REST: Config and State Loading
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    appConfig = await res.json();

    providerSelect.replaceChildren();
    (appConfig.providers || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.label || p.id}${p.configured ? '' : ' (unconfigured)'}`;
      providerSelect.appendChild(opt);
    });
    if (appConfig.defaults?.provider) {
      providerSelect.value = appConfig.defaults.provider;
    }

    voiceModeSelect.replaceChildren();
    (appConfig.voiceModes || []).forEach(vm => {
      const opt = document.createElement('option');
      opt.value = vm.id;
      const modelSuffix = vm.model ? ` [${vm.model}]` : '';
      opt.textContent = `${vm.label || vm.id}${modelSuffix}${vm.configured ? '' : ' (unconfigured)'}`;
      voiceModeSelect.appendChild(opt);
    });
    if (appConfig.defaults?.voiceMode) {
      voiceModeSelect.value = appConfig.defaults.voiceMode;
    }

    const currentProv = appConfig.providers?.find(p => p.id === providerSelect.value);
    if (currentProv?.model) {
      modelInput.value = currentProv.model;
    }

    populateSettingsOptions();
    populateTaskModalOptions();
    populateIntegrationsTable();
    updateRouteReadiness();
  } catch (err) {
    routeStatusBadge.textContent = 'Config Error';
    routeStatusBadge.className = 'badge badge-danger';
  }
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyState(await res.json());
  } catch (err) {
    tasksList.replaceChildren();
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.textContent = `Failed to load state: ${err.message}`;
    tasksList.appendChild(errDiv);
  }
}

function populateTaskAreaChoices() {
  taskAreaSelect.replaceChildren();
  const defaultId = appState.settings?.defaultAreaId;
  const defaultArea = appState.areas?.find(a => a.id === defaultId);

  if (defaultArea) {
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = `Use default area (${defaultArea.name})`;
    taskAreaSelect.appendChild(defaultOpt);
  }

  (appState.areas || []).forEach(area => {
    const opt = document.createElement('option');
    opt.value = area.id;
    opt.textContent = `${area.name}${area.id === defaultId ? ' (default)' : ''}`;
    taskAreaSelect.appendChild(opt);
  });
}

// Render Work Areas
function renderAreas() {
  areasList.replaceChildren();
  populateTaskAreaChoices();
  if (areasDisclosure && (!appState.areas || appState.areas.length === 0)) areasDisclosure.open = true;

  if (!appState.areas || appState.areas.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'folder-kanban');
    const title = document.createElement('span');
    title.className = 'empty-title';
    title.textContent = 'No work areas';
    const detail = document.createElement('span');
    detail.className = 'empty-detail';
    detail.textContent = 'Repositories you supervise appear here.';
    empty.append(icon, title, detail);
    areasList.appendChild(empty);
    return;
  }

  appState.areas.forEach(area => {
    const row = document.createElement('article');
    row.className = 'item-row';
    row.setAttribute('aria-label', `Work area ${area.name}`);

    const top = document.createElement('div');
    top.className = 'item-title-bar';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = area.name;

    const editBtn = document.createElement('button');
    editBtn.className = 'btn';
    editBtn.type = 'button';
    editBtn.title = 'Edit Work Area';
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'edit-2');
    editBtn.appendChild(icon);

    top.appendChild(nameSpan);
    top.appendChild(editBtn);

    const meta = document.createElement('div');
    meta.className = 'item-meta';

    if (appState.settings?.defaultAreaId === area.id) {
      const defBadge = document.createElement('span');
      defBadge.className = 'badge badge-accent';
      defBadge.textContent = 'Default';
      meta.appendChild(defBadge);
    }

    const pathSpan = document.createElement('span');
    pathSpan.className = 'mono';
    pathSpan.textContent = area.repoPath;
    meta.appendChild(pathSpan);

    if (area.aliases && area.aliases.length > 0) {
      const aliasSpan = document.createElement('span');
      aliasSpan.textContent = `Aliases: ${area.aliases.join(', ')}`;
      meta.appendChild(aliasSpan);
    }

    const agentSpan = document.createElement('span');
    agentSpan.textContent = `[${area.agent || 'agent'} @ ${area.baseRef || 'HEAD'}]`;
    meta.appendChild(agentSpan);

    if (area.instructions) {
      const instSpan = document.createElement('span');
      instSpan.textContent = `Instructions: ${area.instructions.slice(0, 30)}${area.instructions.length > 30 ? '...' : ''}`;
      meta.appendChild(instSpan);
    }

    if (area.allowPublish) {
      const pubBadge = document.createElement('span');
      pubBadge.className = 'badge badge-accent';
      pubBadge.textContent = 'Publish allowed';
      meta.appendChild(pubBadge);
    }

    row.appendChild(top);
    row.appendChild(meta);

    editBtn.setAttribute('aria-label', `Edit work area ${area.name}`);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAreaModal(area);
    });
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      openAreaModal(area);
    });

    areasList.appendChild(row);
  });
}

async function openAreaModal(area = null) {
  if (areaAgentSelect) {
    areaAgentSelect.replaceChildren();
    const defaultAgentOpt = document.createElement('option');
    defaultAgentOpt.value = 'agent';
    defaultAgentOpt.textContent = 'Default agent (agent)';
    areaAgentSelect.appendChild(defaultAgentOpt);
  }

  if (area) {
    areaDialogTitle.textContent = 'Edit Work Area';
    areaIdInput.value = area.id;
    areaNameInput.value = area.name;
    areaRepoInput.value = area.repoPath;
    areaAliasesInput.value = (area.aliases || []).join(', ');
    if (areaInstructionsInput) areaInstructionsInput.value = area.instructions || '';
    areaAgentInput.value = area.agent || 'agent';
    areaBaseRefInput.value = area.baseRef || 'HEAD';
    areaAllowPublishInput.checked = Boolean(area.allowPublish);
    if (areaDefaultInput) areaDefaultInput.checked = Boolean(appState.settings?.defaultAreaId === area.id);
    if (areaDeleteBtn) areaDeleteBtn.style.display = 'inline-flex';

    try {
      const res = await fetch(`/api/areas/${encodeURIComponent(area.id)}/agents`);
      if (res.ok) {
        const agents = await res.json();
        for (const ag of agents) {
          if (ag.id === 'agent') continue;
          const opt = document.createElement('option');
          opt.value = ag.id;
          opt.textContent = `${ag.name}${ag.id !== ag.name ? ` (${ag.id})` : ''}${ag.model ? ` [${ag.model}]` : ''}`;
          areaAgentSelect.appendChild(opt);
        }
      }
    } catch (_) {}

    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom agent identifier...';
    areaAgentSelect.appendChild(customOpt);

    const currentAgent = area.agent || 'agent';
    const hasAgentOpt = [...areaAgentSelect.options].some(o => o.value === currentAgent);
    if (hasAgentOpt) {
      areaAgentSelect.value = currentAgent;
      if (areaCustomAgentGroup) areaCustomAgentGroup.style.display = 'none';
    } else {
      areaAgentSelect.value = '__custom__';
      if (areaCustomAgentGroup) areaCustomAgentGroup.style.display = 'flex';
      areaAgentInput.value = currentAgent;
    }
  } else {
    areaDialogTitle.textContent = 'Register Work Area';
    areaIdInput.value = '';
    areaNameInput.value = '';
    areaRepoInput.value = '';
    areaAliasesInput.value = '';
    if (areaInstructionsInput) areaInstructionsInput.value = '';
    areaAgentInput.value = 'agent';
    areaBaseRefInput.value = 'HEAD';
    areaAllowPublishInput.checked = false;
    if (areaDefaultInput) areaDefaultInput.checked = false;
    if (areaDeleteBtn) areaDeleteBtn.style.display = 'none';

    if (areaAgentSelect) {
      const customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = 'Custom agent identifier...';
      areaAgentSelect.appendChild(customOpt);

      areaAgentSelect.value = 'agent';
      if (areaCustomAgentGroup) areaCustomAgentGroup.style.display = 'none';
    }
  }
  areaDialog.showModal();
  updateIcons();
}

if (areaAgentSelect) {
  areaAgentSelect.addEventListener('change', () => {
    if (areaAgentSelect.value === '__custom__') {
      if (areaCustomAgentGroup) areaCustomAgentGroup.style.display = 'flex';
      areaAgentInput.focus();
    } else {
      if (areaCustomAgentGroup) areaCustomAgentGroup.style.display = 'none';
      areaAgentInput.value = areaAgentSelect.value;
    }
  });
}

if (areaDeleteBtn) {
  areaDeleteBtn.addEventListener('click', async () => {
    const areaId = areaIdInput.value;
    if (!areaId) return;
    const name = areaNameInput.value || 'this work area';
    if (!confirm(`Delete work area "${name}"?`)) return;

    try {
      const res = await fetch(`/api/areas/${encodeURIComponent(areaId)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      areaDialog.close();
      await loadState();
    } catch (err) {
      alert(`Failed to delete area: ${err.message}`);
    }
  });
}

areaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const selectedAgent = areaAgentSelect?.value === '__custom__'
    ? areaAgentInput.value.trim()
    : (areaAgentSelect?.value || areaAgentInput.value.trim());
  const agent = selectedAgent || 'agent';
  const instructions = areaInstructionsInput ? areaInstructionsInput.value.trim() : '';

  const areaData = {
    name: areaNameInput.value.trim(),
    repoPath: areaRepoInput.value.trim(),
    aliases: areaAliasesInput.value.split(',').map(s => s.trim()).filter(Boolean),
    agent,
    baseRef: areaBaseRefInput.value.trim() || 'HEAD',
    instructions,
    allowPublish: areaAllowPublishInput.checked
  };
  if (areaIdInput.value) {
    areaData.id = areaIdInput.value;
  }

  try {
    const res = await fetch('/api/areas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(areaData)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const savedArea = await res.json();

    if (areaDefaultInput) {
      const isDefault = areaDefaultInput.checked;
      const currentDefault = appState.settings?.defaultAreaId;
      if (isDefault && currentDefault !== savedArea.id) {
        const settingsResponse = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultAreaId: savedArea.id })
        });
        if (!settingsResponse.ok) throw new Error((await settingsResponse.json().catch(() => ({}))).error || `HTTP ${settingsResponse.status}`);
      } else if (!isDefault && currentDefault === savedArea.id) {
        const settingsResponse = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultAreaId: null })
        });
        if (!settingsResponse.ok) throw new Error((await settingsResponse.json().catch(() => ({}))).error || `HTTP ${settingsResponse.status}`);
      }
    }

    areaDialog.close();
    await loadState();
  } catch (err) {
    alert(`Failed to save area: ${err.message}`);
  }
});

btnNewArea.addEventListener('click', () => openAreaModal(null));
areaCancelBtn.addEventListener('click', () => areaDialog.close());
areaDialogClose.addEventListener('click', () => areaDialog.close());

const TERMINAL_STATES = new Set(['completed', 'result_ready', 'failed', 'agent_failed', 'agent_stopped']);
const RESUMABLE_STATES = new Set(['result_ready', 'completed', 'failed', 'agent_failed', 'agent_stopped', 'needs_input']);
function isTaskFinished(task) {
  return TERMINAL_STATES.has(task?.state);
}
function isTaskDeletable(task) {
  return task?.deletable === true;
}
function isTaskResumable(task) {
  return RESUMABLE_STATES.has(task?.state);
}

async function deleteTask(taskId, taskTitle = 'task') {
  if (!confirm(`Delete task "${taskTitle}"?`)) return;
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    if (taskDetailDialog?.open) taskDetailDialog.close();
    await loadState();
  } catch (err) {
    alert(`Failed to delete task: ${err.message}`);
  }
}

// Render Tasks
function renderTasks() {
  tasksList.replaceChildren();

  if (!appState.tasks || appState.tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'circle-dashed');
    const title = document.createElement('span');
    title.className = 'empty-title';
    title.textContent = 'No tasks in flight';
    const detail = document.createElement('span');
    detail.className = 'empty-detail';
    detail.textContent = 'Agent sessions and progress appear here.';
    empty.append(icon, title, detail);
    tasksList.appendChild(empty);
    return;
  }

  // Newest tasks first
  const sorted = [...appState.tasks].reverse();
  sorted.forEach(task => {
    const card = document.createElement('div');
    const isStale = Boolean(task.stale);
    card.className = `task-card state-${task.state || 'unknown'} ${isStale ? 'stale' : ''}`;

    const header = document.createElement('div');
    header.className = 'task-header';

    const titleGroup = document.createElement('div');
    titleGroup.style.display = 'flex';
    titleGroup.style.alignItems = 'center';
    titleGroup.style.gap = '8px';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'task-title';
    titleSpan.textContent = task.title || task.objective || 'Task';
    titleGroup.appendChild(titleSpan);

    const backendBadge = document.createElement('span');
    backendBadge.className = 'badge';
    backendBadge.textContent = backendLabel(task.backend);
    backendBadge.title = `Backend: ${task.backend || 'copilot'}`;
    titleGroup.appendChild(backendBadge);

    const stateBadge = document.createElement('span');
    stateBadge.className = `badge badge-${['completed', 'result_ready'].includes(task.state) ? 'success' : ['failed', 'agent_failed'].includes(task.state) ? 'danger' : 'accent'}`;
    stateBadge.textContent = task.state || 'unknown';
    titleGroup.appendChild(stateBadge);

    if (isStale) {
      const staleBadge = document.createElement('span');
      staleBadge.className = 'badge badge-warning';
      staleBadge.textContent = 'stale';
      titleGroup.appendChild(staleBadge);
    }
    header.appendChild(titleGroup);

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    // Status query button
    const statusBtn = document.createElement('button');
    statusBtn.className = 'btn';
    statusBtn.type = 'button';
    statusBtn.title = 'Query Task Status';
    statusBtn.setAttribute('aria-label', `Status for ${task.title}`);
    const statusIcon = document.createElement('i');
    statusIcon.setAttribute('data-lucide', 'refresh-cw');
    statusBtn.appendChild(statusIcon);
    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      queryTaskStatus(task.id);
    });
    actions.appendChild(statusBtn);

    // Open worktree button
    if (task.worktree) {
      const openBtn = document.createElement('button');
      openBtn.className = 'btn';
      openBtn.type = 'button';
      openBtn.title = 'Open Worktree in VS Code';
      openBtn.setAttribute('aria-label', `Open worktree for ${task.title}`);
      const openIcon = document.createElement('i');
      openIcon.setAttribute('data-lucide', 'external-link');
      openBtn.appendChild(openIcon);
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openWorktree(task.id);
      });
      actions.appendChild(openBtn);
    }

    // Continue thread button
    if (isTaskResumable(task)) {
      const continueBtn = document.createElement('button');
      continueBtn.className = 'btn';
      continueBtn.type = 'button';
      continueBtn.title = 'Continue Thread';
      continueBtn.setAttribute('aria-label', `Continue thread for ${task.title}`);
      const continueIcon = document.createElement('i');
      continueIcon.setAttribute('data-lucide', 'message-square-plus');
      continueBtn.appendChild(continueIcon);
      continueBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openContinueDialog(task);
      });
      actions.appendChild(continueBtn);
    }

    if (isTaskDeletable(task)) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger';
      deleteBtn.type = 'button';
      deleteBtn.title = 'Delete Task';
      deleteBtn.setAttribute('aria-label', `Delete ${task.title || 'task'}`);
      const deleteIcon = document.createElement('i');
      deleteIcon.setAttribute('data-lucide', 'trash-2');
      deleteBtn.appendChild(deleteIcon);
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteTask(task.id, task.title);
      });
      actions.appendChild(deleteBtn);
    }

    header.appendChild(actions);
    card.appendChild(header);

    // Summary of latest observation or error
    const summary = document.createElement('div');
    summary.className = 'task-summary';
    if (task.error) {
      summary.textContent = `Error: ${task.error}`;
      summary.style.color = 'var(--cp-danger)';
    } else if (task.observations && task.observations.length > 0) {
      const lastObs = task.observations[task.observations.length - 1];
      const label = document.createElement('span');
      label.className = 'task-summary-label';
      label.textContent = lastObs.kind || 'observation';
      const content = document.createElement('div');
      renderSafeMarkdown(content, lastObs.summary || 'Update observed');
      summary.append(label, content);
    } else if (task.result && typeof task.result === 'object') {
      summary.textContent = `Result: ${JSON.stringify(task.result)}`;
    } else if (task.result) {
      const label = document.createElement('span');
      label.className = 'task-summary-label';
      label.textContent = 'result';
      const content = document.createElement('div');
      renderSafeMarkdown(content, task.result);
      summary.append(label, content);
    } else {
      summary.textContent = 'Awaiting initial observer event...';
    }
    card.appendChild(summary);

    // Footer metadata
    const footer = document.createElement('div');
    footer.className = 'task-footer';

    const area = appState.areas?.find(a => a.id === task.areaId);
    const areaInfo = document.createElement('span');
    areaInfo.textContent = `Area: ${area ? area.name : (task.areaId || 'None')}`;
    footer.appendChild(areaInfo);

    const backendInfo = document.createElement('span');
    backendInfo.textContent = `Backend: ${backendLabel(task.backend)}`;
    footer.appendChild(backendInfo);

    if (task.worktree) {
      const wtInfo = document.createElement('span');
      wtInfo.className = 'mono';
      wtInfo.textContent = task.worktree;
      footer.appendChild(wtInfo);
    }

    const timeInfo = document.createElement('span');
    const timeVal = task.lastObservedAt || task.createdAt;
    timeInfo.textContent = timeVal ? new Date(timeVal).toLocaleTimeString() : '';
    footer.appendChild(timeInfo);

    card.appendChild(footer);

    // Click card to open detail view
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      showTaskDetail(task);
    });
    tasksList.appendChild(card);
  });
}

// Show Task Detail Modal
function showTaskDetail(task) {
  detailContent.replaceChildren();

  const addField = (label, val, isMono = false) => {
    const p = document.createElement('p');
    const b = document.createElement('strong');
    b.textContent = `${label}: `;
    p.appendChild(b);
    const s = document.createElement('span');
    if (isMono) s.className = 'mono';
    s.textContent = val || 'None';
    p.appendChild(s);
    detailContent.appendChild(p);
  };

  addField('Title', task.title);
  addField('Backend', backendLabel(task.backend));
  addField('State', task.state);
  addField('Stale', task.stale ? 'Yes' : 'No');
  if (task.capabilities && typeof task.capabilities === 'object') {
    const caps = Object.entries(task.capabilities)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    addField('Capabilities', caps);
  }
  if (task.error) addField('Error', task.error);
  if (task.result) {
    const resultBlock = document.createElement('div');
    const resultLabel = document.createElement('strong');
    resultLabel.textContent = 'Result: ';
    const resultBody = document.createElement('div');
    if (typeof task.result === 'object') {
      resultBody.className = 'mono';
      resultBody.textContent = JSON.stringify(task.result, null, 2);
    } else {
      renderSafeMarkdown(resultBody, task.result);
    }
    resultBlock.append(resultLabel, resultBody);
    detailContent.appendChild(resultBlock);
  }

  const advanced = document.createElement('details');
  advanced.className = 'advanced-disclosure';
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = 'Advanced';
  advanced.appendChild(advancedSummary);
  const advancedBody = document.createElement('div');
  const addAdvanced = (label, val, isMono = false) => {
    const p = document.createElement('p');
    const b = document.createElement('strong');
    b.textContent = `${label}: `;
    p.appendChild(b);
    const s = document.createElement('span');
    if (isMono) s.className = 'mono';
    s.textContent = val || 'None';
    p.appendChild(s);
    advancedBody.appendChild(p);
  };
  addAdvanced('Task ID', task.id, true);
  addAdvanced('Backend', task.backend || 'copilot');
  addAdvanced('Model', task.model);
  addAdvanced('Context', task.context);
  addAdvanced('Worktree', task.worktree, true);
  addAdvanced('Session ID', task.sessionId, true);
  addAdvanced('Created At', task.createdAt ? new Date(task.createdAt).toLocaleString() : '');
  addAdvanced('Last Observed', task.lastObservedAt ? new Date(task.lastObservedAt).toLocaleString() : '');
  advanced.appendChild(advancedBody);
  detailContent.appendChild(advanced);

  const obsHeader = document.createElement('h4');
  obsHeader.textContent = 'Recent Observations';
  detailContent.appendChild(obsHeader);

  if (!task.observations || task.observations.length === 0) {
    const noObs = document.createElement('p');
    noObs.style.fontStyle = 'italic';
    noObs.textContent = 'No observations recorded.';
    detailContent.appendChild(noObs);
  } else {
    const obsList = document.createElement('div');
    obsList.className = 'detail-observations';
    task.observations.forEach(obs => {
      const item = document.createElement('div');
      item.className = 'item-row';
      const time = obs.at ? new Date(obs.at).toLocaleTimeString() : '';
      const t = document.createElement('span');
      t.className = 'mono';
      t.textContent = `[${time}] ${obs.kind || 'event'}: `;
      const desc = document.createElement('div');
      renderSafeMarkdown(desc, obs.summary || '');
      item.appendChild(t);
      item.appendChild(desc);
      obsList.appendChild(item);
    });
    detailContent.appendChild(obsList);
  }

  if (detailDeleteTaskBtn) {
    if (isTaskDeletable(task)) {
      detailDeleteTaskBtn.style.display = 'inline-flex';
      detailDeleteTaskBtn.onclick = async () => {
        await deleteTask(task.id, task.title);
      };
    } else {
      detailDeleteTaskBtn.style.display = 'none';
    }
  }

  if (detailContinueTaskBtn) {
    if (isTaskResumable(task)) {
      detailContinueTaskBtn.style.display = 'inline-flex';
      detailContinueTaskBtn.onclick = () => {
        taskDetailDialog.close();
        openContinueDialog(task);
      };
    } else {
      detailContinueTaskBtn.style.display = 'none';
    }
  }

  if (task.worktree) {
    detailOpenWorktreeBtn.style.display = 'inline-flex';
    detailOpenWorktreeBtn.onclick = () => openWorktree(task.id);
  } else {
    detailOpenWorktreeBtn.style.display = 'none';
  }

  taskDetailDialog.showModal();
}

detailCloseBtn.addEventListener('click', () => taskDetailDialog.close());
detailDialogClose.addEventListener('click', () => taskDetailDialog.close());

function openContinueDialog(task) {
  if (!continueThreadDialog) return;
  continueTaskIdInput.value = task.id;
  continueMessageInput.value = '';

  continueTaskContext.replaceChildren();

  const titleP = document.createElement('p');
  const strongTitle = document.createElement('strong');
  strongTitle.textContent = 'Task: ';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = task.title || task.objective || task.id;
  titleP.append(strongTitle, titleSpan);

  const metaP = document.createElement('p');
  metaP.className = 'item-meta';

  const strongBackend = document.createElement('strong');
  strongBackend.textContent = 'Backend: ';
  const backendBadge = document.createElement('span');
  backendBadge.className = 'badge';
  backendBadge.textContent = backendLabel(task.backend);

  const strongState = document.createElement('strong');
  strongState.textContent = 'State: ';
  const stateBadge = document.createElement('span');
  stateBadge.className = `badge badge-${['completed', 'result_ready'].includes(task.state) ? 'success' : ['failed', 'agent_failed'].includes(task.state) ? 'danger' : 'accent'}`;
  stateBadge.textContent = task.state;

  metaP.append(strongBackend, backendBadge, strongState, stateBadge);

  const area = appState.areas?.find(a => a.id === task.areaId);
  if (area) {
    const areaP = document.createElement('p');
    const strongArea = document.createElement('strong');
    strongArea.textContent = 'Area: ';
    const areaSpan = document.createElement('span');
    areaSpan.textContent = area.name;
    areaP.append(strongArea, areaSpan);
    continueTaskContext.append(titleP, metaP, areaP);
  } else {
    continueTaskContext.append(titleP, metaP);
  }

  continueThreadDialog.showModal();
  continueMessageInput.focus();
  updateIcons();
}

if (continueCancelBtn) continueCancelBtn.addEventListener('click', () => continueThreadDialog.close());
if (continueDialogClose) continueDialogClose.addEventListener('click', () => continueThreadDialog.close());

if (continueThreadForm) {
  continueThreadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const taskId = continueTaskIdInput.value;
    const message = continueMessageInput.value.trim();
    if (!taskId || !message) return;

    const task = appState.tasks?.find(t => t.id === taskId);
    const taskName = task ? (task.title || task.id.slice(0, 8)) : taskId.slice(0, 8);
    if (continueSendBtn) continueSendBtn.disabled = true;

    try {
      const requestId = crypto.randomUUID();
      const receipt = await callSupervisorTool('send_work_message', { taskId, message }, requestId);
      continueThreadDialog.close();
      appendMessage('user', `Continue [${taskName}]: ${message}`);
      appendMessage('tool', `Tool [send_work_message]: ${JSON.stringify(receipt)}`, { plain: true });
      appendMessage('system', `Follow-up sent for task "${taskName}". State: ${receipt.state || 'dispatching'}.`);
      await loadState();
    } catch (err) {
      alert(`Failed to send follow-up message: ${err.message}`);
    } finally {
      if (continueSendBtn) continueSendBtn.disabled = false;
    }
  });
}

// Tools API Calls
async function callSupervisorTool(name, args = {}, requestId = crypto.randomUUID()) {
  const response = await fetch('/api/tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args, requestId })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

const actionTools = new Set(['start_work', 'send_work_message', 'open_work', 'delete_work', 'invoke_vscode']);

function toolLabel(name) {
  return name.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function addToolChoice(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function createToolField(propertyName, schema, required) {
  const field = document.createElement('div');
  field.className = 'tool-field';
  const id = `tool-arg-${propertyName}`;
  const label = document.createElement('label');
  label.className = 'tool-field-label';
  label.htmlFor = id;
  label.textContent = toolLabel(propertyName);
  if (required) {
    const marker = document.createElement('span');
    marker.className = 'tool-field-required';
    marker.textContent = ' *';
    label.appendChild(marker);
  }

  let control;
  if (propertyName === 'areaId' && appState.areas.length) {
    control = document.createElement('select');
    if (!required) addToolChoice(control, '', 'Not set');
    for (const area of appState.areas) addToolChoice(control, area.id, `${area.name} / ${area.id.slice(0, 8)}`);
  } else if (propertyName === 'taskId' && appState.tasks.length) {
    control = document.createElement('select');
    if (!required) addToolChoice(control, '', 'Not set');
    for (const task of [...appState.tasks].reverse()) addToolChoice(control, task.id, `${task.title} / ${task.state}`);
  } else if (schema.enum) {
    control = document.createElement('select');
    for (const value of schema.enum) addToolChoice(control, value, toolLabel(value));
    if (propertyName === 'context') control.value = appConfig?.defaults?.copilotContext || 'long_context';
    if (propertyName === 'backend') control.value = appState?.settings?.defaultBackend || appConfig?.defaults?.codingBackend || 'copilot';
  } else if (['objective', 'prompt'].includes(propertyName)) {
    control = document.createElement('textarea');
    control.rows = 4;
  } else {
    control = document.createElement('input');
    control.type = 'text';
    if (propertyName === 'model') control.value = appConfig?.defaults?.copilotModel || 'gpt-5.6-sol';
  }
  control.id = id;
  control.name = propertyName;
  control.required = required;
  control.setAttribute('aria-label', toolLabel(propertyName));

  const help = document.createElement('p');
  help.className = 'tool-field-help';
  help.textContent = schema.description || schema.type || 'Argument';
  field.append(label, control, help);
  return { field, control };
}

function selectToolDefinition(definition) {
  selectedTool = definition;
  const { name, description, parameters } = definition.function;
  toolName.textContent = name;
  toolDescription.textContent = description;
  toolKindBadge.textContent = actionTools.has(name) ? 'Action' : 'Read only';
  toolKindBadge.className = actionTools.has(name) ? 'badge badge-warning' : 'badge badge-success';
  toolRunStatus.textContent = 'Idle';
  toolRunStatus.className = 'badge';
  toolResult.textContent = 'Ready';
  toolForm.replaceChildren();

  for (const [propertyName, schema] of Object.entries(parameters.properties || {})) {
    const { field } = createToolField(propertyName, schema, parameters.required?.includes(propertyName));
    toolForm.appendChild(field);
  }

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const run = document.createElement('button');
  run.type = 'submit';
  run.className = 'btn btn-accent';
  run.innerHTML = '<i data-lucide="play"></i><span>Run Tool</span>';
  actions.appendChild(run);
  toolForm.appendChild(actions);

  for (const item of toolList.querySelectorAll('.tool-list-item')) {
    item.setAttribute('aria-selected', String(item.dataset.tool === name));
  }
}

function renderToolCatalog() {
  toolList.replaceChildren();
  toolCount.textContent = String(availableTools.length);
  for (const definition of availableTools) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tool-list-item';
    item.dataset.tool = definition.function.name;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    const icon = document.createElement('span');
    icon.className = 'tool-list-icon';
    icon.innerHTML = `<i data-lucide="${actionTools.has(definition.function.name) ? 'play' : 'scan-search'}"></i>`;
    const copy = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'tool-list-name';
    name.textContent = definition.function.name;
    const description = document.createElement('span');
    description.className = 'tool-list-description';
    description.textContent = definition.function.description;
    copy.append(name, description);
    item.append(icon, copy);
    item.addEventListener('click', () => {
      selectToolDefinition(definition);
      updateIcons();
    });
    toolList.appendChild(item);
  }
  if (availableTools.length) selectToolDefinition(availableTools[0]);
}

async function loadTools() {
  try {
    const response = await fetch('/api/tools');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    availableTools = result;
    renderToolCatalog();
    updateIcons();
  } catch (error) {
    toolName.textContent = 'Tools unavailable';
    toolDescription.textContent = error.message;
    toolRunStatus.textContent = 'Error';
    toolRunStatus.className = 'badge badge-danger';
  }
}

toolForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedTool) return;
  const name = selectedTool.function.name;
  if (actionTools.has(name) && !window.confirm(`Run ${name}? This tool can change local session state or open VS Code.`)) return;
  const args = {};
  for (const [key, value] of new FormData(toolForm)) {
    if (typeof value !== 'string' || value.trim()) args[key] = typeof value === 'string' ? value.trim() : value;
  }
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const submit = toolForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  toolRunStatus.textContent = 'Running';
  toolRunStatus.className = 'badge badge-warning';
  toolResult.textContent = `${name} running...`;
  try {
    const result = await callSupervisorTool(name, args, requestId);
    toolRunStatus.textContent = `${Math.round(performance.now() - startedAt)} ms`;
    toolRunStatus.className = 'badge badge-success';
    toolResult.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (name === 'start_work' || name === 'send_work_message') await loadState();
  } catch (error) {
    toolRunStatus.textContent = 'Failed';
    toolRunStatus.className = 'badge badge-danger';
    toolResult.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

async function openWorktree(taskId) {
  try {
    await callSupervisorTool('open_work', { taskId });
    appendMessage('system', `Opened worktree for task ${taskId.slice(0, 8)} in a new window.`);
  } catch (err) {
    alert(`Could not open worktree: ${err.message}`);
  }
}

async function queryTaskStatus(taskId) {
  try {
    const result = await callSupervisorTool('get_work_status', { taskId });
    const detail = result.result || result.error || result.update;
    appendMessage('tool', `Status [${taskId.slice(0, 8)}]: ${result.state}${result.stale ? ' (stale)' : ''}${detail ? ` — ${detail}` : ''}`);
    await loadState();
  } catch (err) {
    alert(`Could not get status: ${err.message}`);
  }
}

function populateTaskModalOptions() {
  if (taskBackendSelect) {
    taskBackendSelect.replaceChildren();
    getCodingBackends().forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.label || b.id;
      taskBackendSelect.appendChild(opt);
    });
  }

  if (!appConfig) return;
  if (taskModelSelect) {
    taskModelSelect.replaceChildren();
    (appConfig.copilotModels || []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      taskModelSelect.appendChild(opt);
    });
  }

  if (taskContextSelect) {
    taskContextSelect.replaceChildren();
    (appConfig.copilotContexts || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label || c.id;
      taskContextSelect.appendChild(opt);
    });
  }
}

async function updateTaskAgents(areaId) {
  if (!taskAgentSelect) return;
  taskAgentSelect.replaceChildren();
  if (!areaId) {
    const opt = document.createElement('option');
    opt.value = 'agent';
    opt.textContent = 'Default agent (agent)';
    taskAgentSelect.appendChild(opt);
    return;
  }
  try {
    const res = await fetch(`/api/areas/${encodeURIComponent(areaId)}/agents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const agents = await res.json();
    (agents || []).forEach(ag => {
      const opt = document.createElement('option');
      opt.value = ag.id;
      opt.textContent = `${ag.name}${ag.id !== ag.name ? ` (${ag.id})` : ''}${ag.model ? ` [${ag.model}]` : ''}`;
      taskAgentSelect.appendChild(opt);
    });
    const currentArea = appState.areas?.find(a => a.id === areaId);
    if (currentArea?.agent && [...taskAgentSelect.options].some(o => o.value === currentArea.agent)) {
      taskAgentSelect.value = currentArea.agent;
    }
  } catch (_) {
    const opt = document.createElement('option');
    opt.value = 'agent';
    opt.textContent = 'Default agent (agent)';
    taskAgentSelect.appendChild(opt);
  }
}

if (taskAreaSelect) {
  taskAreaSelect.addEventListener('change', async () => {
    const effectiveAreaId = taskAreaSelect.value || appState.settings?.defaultAreaId;
    await updateTaskAgents(effectiveAreaId);
  });
}

btnNewTask.addEventListener('click', async () => {
  if (!appState.areas || appState.areas.length === 0) {
    alert('Please register at least one Work Area before dispatching a task.');
    return;
  }
  populateTaskAreaChoices();
  populateTaskModalOptions();

  const defaultId = appState.settings?.defaultAreaId;
  if (defaultId && appState.areas.some(a => a.id === defaultId)) {
    taskAreaSelect.value = '';
  } else {
    taskAreaSelect.value = appState.areas[0]?.id || '';
  }

  if (taskBackendSelect) {
    taskBackendSelect.value = appState.settings?.defaultBackend || appConfig?.defaults?.codingBackend || 'copilot';
  }

  taskObjectiveInput.value = '';
  if (taskModelSelect) {
    taskModelSelect.value = appState.settings?.copilotModel || appConfig?.defaults?.copilotModel || 'gpt-5.6-sol';
  }
  if (taskContextSelect) {
    taskContextSelect.value = appState.settings?.copilotContext || appConfig?.defaults?.copilotContext || 'default';
  }

  const effectiveAreaId = taskAreaSelect.value || appState.settings?.defaultAreaId || appState.areas[0]?.id;
  await updateTaskAgents(effectiveAreaId);

  newTaskDialog.showModal();
  updateIcons();
});

taskCancelBtn.addEventListener('click', () => newTaskDialog.close());
taskDialogClose.addEventListener('click', () => newTaskDialog.close());

newTaskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const areaId = taskAreaSelect.value ? taskAreaSelect.value : undefined;
  const backend = taskBackendSelect ? taskBackendSelect.value : (appState.settings?.defaultBackend || 'copilot');
  const objective = taskObjectiveInput.value.trim();
  const model = taskModelSelect ? taskModelSelect.value : (appState.settings?.copilotModel || 'gpt-5.6-sol');
  const context = taskContextSelect ? taskContextSelect.value : (appState.settings?.copilotContext || 'default');
  const agent = taskAgentSelect?.value || 'agent';

  if (!areaId && !appState.settings?.defaultAreaId) {
    alert('Please select a work area or configure a default work area in Settings.');
    return;
  }
  if (!objective) return;

  try {
    const args = { objective, backend, model, context, agent };
    if (areaId) args.areaId = areaId;
    const result = await callSupervisorTool('start_work', args);
    newTaskDialog.close();
    appendMessage('system', `Dispatched task [${result.taskId}]: state=${result.state}`);
    await loadState();
  } catch (err) {
    alert(`Failed to dispatch task: ${err.message}`);
  }
});

btnRefreshTasks.addEventListener('click', () => loadState());

// Typed Chat (SSE streaming via POST /api/chat)
async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';

  appendMessage('user', text);
  conversation.push({ role: 'user', content: text });

  const provider = providerSelect.value;
  const model = modelInput.value.trim();

  // Abort previous in-flight chat request
  if (currentChatAbortController) {
    currentChatAbortController.abort();
    currentChatAbortController = null;
  }
  const chatToken = ++currentChatToken;
  const abortController = new AbortController();
  currentChatAbortController = abortController;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model,
        messages: conversation,
        requestId: crypto.randomUUID()
      }),
      signal: abortController.signal
    });

    if (chatToken !== currentChatToken || abortController.signal.aborted) return;

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantBubble = null;
    let accumulated = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done || chatToken !== currentChatToken || abortController.signal.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        if (chatToken !== currentChatToken || abortController.signal.aborted) break;
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payloadStr = trimmed.slice(5).trim();
        if (!payloadStr) continue;

        try {
          const evt = JSON.parse(payloadStr);
          if (chatToken !== currentChatToken || abortController.signal.aborted) break;
          if (evt.type === 'text') {
            if (!assistantBubble) {
              assistantBubble = document.createElement('div');
              assistantBubble.className = 'chat-bubble assistant';
              chatMessages.appendChild(assistantBubble);
            }
            accumulated += evt.text;
            renderSafeMarkdown(assistantBubble, accumulated);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            conversationUI.preview('assistant', accumulated);
          } else if (evt.type === 'tool') {
            const toolStr = typeof evt.result === 'object' ? JSON.stringify(evt.result) : String(evt.result);
            appendMessage('tool', `Tool [${evt.name}]: ${toolStr}`, { plain: typeof evt.result === 'object' });
          } else if (evt.type === 'error') {
            conversationUI.clearCaption();
            appendMessage('system', `Chat Error: ${evt.message}`);
          } else if (evt.type === 'done') {
            // Done
          }
        } catch (_) {}
      }
    }

    if (chatToken === currentChatToken && !abortController.signal.aborted && accumulated) {
      conversation.push({ role: 'assistant', content: accumulated });
      conversationUI.message('assistant', accumulated, assistantBubble);
    }
  } catch (err) {
    if (chatToken !== currentChatToken || abortController.signal.aborted || err.name === 'AbortError') {
      return;
    }
    conversationUI.clearCaption();
    appendMessage('system', `Error sending message: ${err.message}`);
  } finally {
    if (currentChatAbortController === abortController) {
      currentChatAbortController = null;
    }
  }
}

btnSendChat.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChatMessage();
  }
});

btnClearChat.addEventListener('click', () => {
  if (currentChatAbortController) {
    currentChatAbortController.abort();
    currentChatAbortController = null;
  }
  currentChatToken++;
  conversation = [];
  chatMessages.replaceChildren();
  conversationUI.clear();
  partialTranscript.style.display = 'none';
  sessionResetNotice.style.display = 'none';
});

// Route controls event listeners
providerSelect.addEventListener('change', () => {
  const currentProv = appConfig?.providers?.find(p => p.id === providerSelect.value);
  if (currentProv?.model) {
    modelInput.value = currentProv.model;
  }
  handleRouteSwitch('provider change');
});

voiceModeSelect.addEventListener('change', () => {
  handleRouteSwitch('voice mode change');
});

modelInput.addEventListener('change', () => {
  handleRouteSwitch('model change');
});

if (routeConfigBtn && routeConfigDialog) {
  routeConfigBtn.addEventListener('click', () => routeConfigDialog.showModal());
}
if (routeConfigClose && routeConfigDialog) {
  routeConfigClose.addEventListener('click', () => routeConfigDialog.close());
}

async function initialize() {
  await loadConfig();
  await loadState();
  await loadTools();
  initEventSource();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  void initialize();
}
