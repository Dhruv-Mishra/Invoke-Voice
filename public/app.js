// Voice Work Supervisor Frontend Application
// Follows Clawpilot theme and local-only zero-build plain JS architecture

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
const pendingNotifications = [];

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

const areasList = document.getElementById('areas-list');
const btnNewArea = document.getElementById('btn-new-area');
const areaDialog = document.getElementById('area-dialog');
const areaForm = document.getElementById('area-form');
const areaDialogTitle = document.getElementById('area-dialog-title');
const areaIdInput = document.getElementById('area-id-input');
const areaNameInput = document.getElementById('area-name-input');
const areaRepoInput = document.getElementById('area-repo-input');
const areaAliasesInput = document.getElementById('area-aliases-input');
const areaAgentInput = document.getElementById('area-agent-input');
const areaBaseRefInput = document.getElementById('area-base-ref-input');
const areaAllowPublishInput = document.getElementById('area-allow-publish-input');
const areaCancelBtn = document.getElementById('area-cancel-btn');
const areaDialogClose = document.getElementById('area-dialog-close');

const tasksList = document.getElementById('tasks-list');
const btnNewTask = document.getElementById('btn-new-task');
const btnRefreshTasks = document.getElementById('btn-refresh-tasks');
const newTaskDialog = document.getElementById('new-task-dialog');
const newTaskForm = document.getElementById('new-task-form');
const taskAreaSelect = document.getElementById('task-area-select');
const taskObjectiveInput = document.getElementById('task-objective-input');
const taskModelInput = document.getElementById('task-model-input');
const taskContextSelect = document.getElementById('task-context-select');
const taskCancelBtn = document.getElementById('task-cancel-btn');
const taskDialogClose = document.getElementById('task-dialog-close');

const taskDetailDialog = document.getElementById('task-detail-dialog');
const detailContent = document.getElementById('detail-content');
const detailCloseBtn = document.getElementById('detail-close-btn');
const detailDialogClose = document.getElementById('detail-dialog-close');
const detailOpenWorktreeBtn = document.getElementById('detail-open-worktree-btn');

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

const selectShells = new Set();
function closeSelectShells(except = null) {
  for (const shell of selectShells) if (shell !== except) shell.classList.remove('open');
}

function enhanceSelect(select) {
  if (select.dataset.enhanced === 'true') return;
  select.dataset.enhanced = 'true';
  const shell = document.createElement('div');
  shell.className = 'select-shell';
  select.before(shell);
  shell.appendChild(select);
  select.classList.add('select-native');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'select-menu';
  menu.setAttribute('role', 'listbox');
  shell.append(trigger, menu);
  selectShells.add(shell);

  const close = () => {
    shell.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  };
  const sync = () => {
    const selected = select.selectedOptions[0];
    trigger.textContent = selected?.textContent || 'Select';
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || selected?.textContent || 'Select');
    menu.replaceChildren();
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `select-option${option.selected ? ' selected' : ''}`;
      item.textContent = option.textContent;
      item.disabled = option.disabled;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        close();
        trigger.focus();
      });
      menu.appendChild(item);
    }
  };

  trigger.addEventListener('click', () => {
    const opening = !shell.classList.contains('open');
    closeSelectShells(shell);
    shell.classList.toggle('open', opening);
    trigger.setAttribute('aria-expanded', String(opening));
  });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); return; }
    if (['ArrowDown', 'Enter', ' '].includes(event.key) && !shell.classList.contains('open')) {
      event.preventDefault();
      shell.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.querySelector('.selected, .select-option:not(:disabled)')?.focus();
    }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); trigger.focus(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.querySelectorAll('.select-option:not(:disabled)')];
    const current = options.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
    options[next]?.focus();
  });
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });
  sync();
}

document.querySelectorAll('select').forEach(enhanceSelect);
document.addEventListener('click', event => {
  if (![...selectShells].some(shell => shell.contains(event.target))) closeSelectShells();
});

function setAgentState(state) {
  if (!agentSprite) return;
  const next = ['idle', 'connecting', 'listening', 'thinking', 'speaking'].includes(state) ? state : 'idle';
  agentSprite.dataset.state = next;
  agentSprite.setAttribute('aria-label', `Agent ${next}`);
  agentSprite.title = `Agent ${next}`;
}

// Safe icon refreshment
function updateIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
updateIcons();

function activateView(viewName) {
  const isToolLab = viewName === 'tool-lab';
  workspaceView.hidden = isToolLab;
  toolLabView.hidden = !isToolLab;
  for (const tab of viewTabs) {
    const selected = tab.dataset.view === viewName;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

viewTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateView(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? viewTabs.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1);
    nextIndex = (nextIndex + viewTabs.length) % viewTabs.length;
    viewTabs[nextIndex].focus();
    activateView(viewTabs[nextIndex].dataset.view);
  });
});

// Microphone Level Visualizer
const canvasCtx = micCanvas.getContext('2d');
function drawMicLevel(level) {
  const w = micCanvas.width;
  const h = micCanvas.height;
  canvasCtx.clearRect(0, 0, w, h);

  const style = getComputedStyle(document.documentElement);
  const bgSoft = style.getPropertyValue('--cp-surface-soft').trim();
  const border = style.getPropertyValue('--cp-border').trim();
  const accent = style.getPropertyValue('--cp-accent').trim();
  const success = style.getPropertyValue('--cp-success').trim();

  canvasCtx.fillStyle = bgSoft;
  canvasCtx.fillRect(0, 0, w, h);

  const barWidth = Math.min(w, Math.max(0, level * w * 2.5));
  canvasCtx.fillStyle = level > 0.6 ? accent : success;
  canvasCtx.fillRect(0, 0, barWidth, h);

  canvasCtx.strokeStyle = border;
  canvasCtx.strokeRect(0.5, 0.5, w - 1, h - 1);
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
function appendMessage(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
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

function scheduleAudioBuffer(buffer, token) {
  if (token !== undefined && token !== playbackGeneration) return;
  const ctx = getPlaybackContext();
  const now = ctx.currentTime;
  if (nextPlayTime < now) {
    nextPlayTime = now + 0.02;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(nextPlayTime);
  setAgentState('speaking');
  activeSources.push(source);
  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx !== -1) activeSources.splice(idx, 1);
    if (isServerReady && activeSources.length === 0 && !isVoiceThinking) setAgentState('listening');
  };
  nextPlayTime += buffer.duration;
}

function clearPlayback() {
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

async function playAudioChunk(base64Data, mimeType, sampleRate, token) {
  if (token !== playbackGeneration) return;
  const ctx = getPlaybackContext();
  const binary = atob(base64Data);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (mimeType === 'audio/wav') {
    try {
      const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
      if (token !== playbackGeneration) return;
      scheduleAudioBuffer(decoded, token);
    } catch (e) {
      if (token === playbackGeneration) {
        console.error('Failed to decode WAV', e);
      }
    }
  } else {
    if (token !== playbackGeneration) return;
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
    scheduleAudioBuffer(buf, token);
  }
}

function queueAudioChunk(data, token) {
  audioQueuePromise = audioQueuePromise.then(async () => {
    if (token !== playbackGeneration) return;
    await playAudioChunk(data.data, data.mimeType, data.sampleRate, token);
  }).catch((err) => {
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

  try {
    micBtnLabel.textContent = 'Connecting...';
    micToggleBtn.disabled = false;
    micToggleBtn.className = 'btn btn-danger';
    routeStatusBadge.textContent = 'Connecting...';
    routeStatusBadge.className = 'badge badge-warning';
    setAgentState('connecting');

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    await audioContext.audioWorklet.addModule('/capture-worklet.js');

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    if (sessionToken !== currentSessionToken) {
      mediaStream.getTracks().forEach(t => t.stop());
      audioContext.close().catch(() => {});
      return;
    }

    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'capture-worklet');

    workletNode.port.onmessage = (event) => {
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

    source.connect(workletNode);
    // Connect worklet to a mute gain so audio keeps flowing without speaker feedback
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    workletNode.connect(muteGain);
    muteGain.connect(audioContext.destination);

    // WebSocket connection
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    voiceSocket = new WebSocket(`${proto}//${window.location.host}/voice`);

    voiceSocket.onopen = () => {
      if (sessionToken !== currentSessionToken) {
        try { voiceSocket.close(); } catch (_) {}
        return;
      }
      // Send start handshake; do NOT send PCM or claim connected until server sends 'ready'
      voiceSocket.send(JSON.stringify({
        type: 'start',
        mode,
        provider,
        model: effectiveModel,
        allowCloud: allowCloudOpt.checked
      }));
    };

    voiceSocket.onmessage = (event) => {
      if (sessionToken !== currentSessionToken) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ready') {
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
        } else if (data.type === 'transcript') {
          if (data.role === 'user' && !data.partial) { isVoiceThinking = true; setAgentState('thinking'); }
          else if (data.role === 'user') setAgentState('listening');
          if (data.partial) {
            partialTranscript.style.display = 'block';
            partialTranscript.textContent = `${data.role}: ${data.text}...`;
          } else {
            partialTranscript.style.display = 'none';
            partialTranscript.textContent = '';
            appendMessage(data.role || 'assistant', data.text);
          }
        } else if (data.type === 'interrupted') {
          isVoiceThinking = false;
          setAgentState('listening');
          clearPlayback();
          partialTranscript.style.display = 'none';
          appendMessage('system', '[Speech interrupted]');
        } else if (data.type === 'tool') {
          const resultStr = typeof data.result === 'object' ? JSON.stringify(data.result) : String(data.result);
          appendMessage('tool', `Tool [${data.name}]: ${resultStr}`);
        } else if (data.type === 'state') {
          isVoiceThinking = data.state === 'thinking';
          setAgentState(data.state === 'thinking' ? 'thinking' : 'listening');
          routeStatusBadge.textContent = `Voice: ${data.state}`;
        } else if (data.type === 'error') {
          appendMessage('system', `Voice Error: ${data.message || 'Unknown error'}`);
          if (data.fatal) {
            stopVoiceSession();
          }
        }
      } catch (err) {
        console.error('Error handling voice socket message', err);
      }
    };

    voiceSocket.onerror = (err) => {
      if (sessionToken !== currentSessionToken) return;
      console.error('Voice socket error', err);
      appendMessage('system', 'Voice WebSocket connection error.');
      stopVoiceSession();
    };

    voiceSocket.onclose = () => {
      if (sessionToken !== currentSessionToken) return;
      stopVoiceSession();
      appendMessage('system', 'Voice disconnected.');
    };

  } catch (err) {
    console.error('Failed to start voice', err);
    alert(`Could not start microphone: ${err.message}`);
    stopVoiceSession();
  }
}

function stopVoiceSession() {
  currentSessionToken++;
  pendingCommit = false;
  isVoiceThinking = false;
  pendingNotifications.length = 0;
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
  if (isMuted) {
    drawMicLevel(0);
  }
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

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && isPttMode && !isPttHeld && !e.repeat) {
    const target = e.target;
    const isEditing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (!isEditing && voiceSocket && voiceSocket.readyState === WebSocket.OPEN && isServerReady) {
      e.preventDefault();
      startPttHold();
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && isPttMode && isPttHeld) {
    const target = e.target;
    const isEditing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (!isEditing) {
      e.preventDefault();
      endPttHold();
    }
  }
});

interruptBtn.addEventListener('click', () => {
  clearPlayback();
  if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
    voiceSocket.send(JSON.stringify({ type: 'interrupt' }));
  }
});

micToggleBtn.addEventListener('click', () => {
  if (voiceSocket) {
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
        appState = data.state;
        renderAreas();
        renderTasks();
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

function handleNotification(n) {
  const text = `[Notification] ${n.title}: ${n.text || n.state}`;
  appendMessage('system', text);
  if (!isQuietMode && isServerReady) pendingNotifications.push(`${n.title}: ${n.text || n.state}`);
}

setInterval(() => {
  if (!pendingNotifications.length || isQuietMode || !isServerReady || isVoiceThinking || isUserSpeaking() || isAssistantSpeaking()) return;
  if (voiceSocket?.readyState !== WebSocket.OPEN) return;
  isVoiceThinking = true;
  voiceSocket.send(JSON.stringify({ type: 'notify', text: pendingNotifications.shift() }));
}, 750);

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
    appState = await res.json();
    renderAreas();
    renderTasks();
  } catch (err) {
    tasksList.replaceChildren();
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.textContent = `Failed to load state: ${err.message}`;
    tasksList.appendChild(errDiv);
  }
}

// Render Work Areas
function renderAreas() {
  areasList.replaceChildren();
  taskAreaSelect.replaceChildren();

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
    updateIcons();
    return;
  }

  appState.areas.forEach(area => {
    // Select option for new tasks
    const opt = document.createElement('option');
    opt.value = area.id;
    opt.textContent = area.name;
    taskAreaSelect.appendChild(opt);

    // Sidebar item
    const row = document.createElement('div');
    row.className = 'item-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', `Edit work area ${area.name}`);

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

    if (area.allowPublish) {
      const pubBadge = document.createElement('span');
      pubBadge.className = 'badge badge-accent';
      pubBadge.textContent = 'Publish allowed';
      meta.appendChild(pubBadge);
    }

    row.appendChild(top);
    row.appendChild(meta);

    const openEdit = (e) => {
      e.stopPropagation();
      openAreaModal(area);
    };
    editBtn.addEventListener('click', openEdit);
    row.addEventListener('click', () => openAreaModal(area));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAreaModal(area);
      }
    });

    areasList.appendChild(row);
  });

  updateIcons();
}

function openAreaModal(area = null) {
  if (area) {
    areaDialogTitle.textContent = 'Edit Work Area';
    areaIdInput.value = area.id;
    areaNameInput.value = area.name;
    areaRepoInput.value = area.repoPath;
    areaAliasesInput.value = (area.aliases || []).join(', ');
    areaAgentInput.value = area.agent || 'agent';
    areaBaseRefInput.value = area.baseRef || 'HEAD';
    areaAllowPublishInput.checked = Boolean(area.allowPublish);
  } else {
    areaDialogTitle.textContent = 'Register Work Area';
    areaIdInput.value = '';
    areaNameInput.value = '';
    areaRepoInput.value = '';
    areaAliasesInput.value = '';
    areaAgentInput.value = 'agent';
    areaBaseRefInput.value = 'HEAD';
    areaAllowPublishInput.checked = false;
  }
  areaDialog.showModal();
}

areaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const areaData = {
    name: areaNameInput.value.trim(),
    repoPath: areaRepoInput.value.trim(),
    aliases: areaAliasesInput.value.split(',').map(s => s.trim()).filter(Boolean),
    agent: areaAgentInput.value.trim() || 'agent',
    baseRef: areaBaseRefInput.value.trim() || 'HEAD',
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
    areaDialog.close();
    await loadState();
  } catch (err) {
    alert(`Failed to save area: ${err.message}`);
  }
});

btnNewArea.addEventListener('click', () => openAreaModal(null));
areaCancelBtn.addEventListener('click', () => areaDialog.close());
areaDialogClose.addEventListener('click', () => areaDialog.close());

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
    updateIcons();
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
      summary.textContent = `[${lastObs.kind || 'observation'}] ${lastObs.summary || 'Update observed'}`;
    } else if (task.result) {
      summary.textContent = `Result: ${typeof task.result === 'object' ? JSON.stringify(task.result) : task.result}`;
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
    card.addEventListener('click', () => showTaskDetail(task));
    tasksList.appendChild(card);
  });

  updateIcons();
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
  addField('Task ID', task.id, true);
  addField('State', task.state);
  addField('Model', task.model);
  addField('Context', task.context);
  addField('Stale', task.stale ? 'Yes' : 'No');
  addField('Worktree', task.worktree, true);
  addField('Session ID', task.sessionId, true);
  addField('Created At', task.createdAt ? new Date(task.createdAt).toLocaleString() : '');
  addField('Last Observed', task.lastObservedAt ? new Date(task.lastObservedAt).toLocaleString() : '');
  if (task.error) addField('Error', task.error);
  if (task.result) addField('Result', typeof task.result === 'object' ? JSON.stringify(task.result, null, 2) : task.result);

  const obsHeader = document.createElement('h4');
  obsHeader.style.marginTop = '10px';
  obsHeader.textContent = 'Recent Observations';
  detailContent.appendChild(obsHeader);

  if (!task.observations || task.observations.length === 0) {
    const noObs = document.createElement('p');
    noObs.style.fontStyle = 'italic';
    noObs.textContent = 'No observations recorded.';
    detailContent.appendChild(noObs);
  } else {
    const obsList = document.createElement('div');
    obsList.style.display = 'flex';
    obsList.style.flexDirection = 'column';
    obsList.style.gap = '6px';
    task.observations.forEach(obs => {
      const item = document.createElement('div');
      item.className = 'item-row';
      const time = obs.at ? new Date(obs.at).toLocaleTimeString() : '';
      const t = document.createElement('span');
      t.className = 'mono';
      t.style.fontSize = '11px';
      t.textContent = `[${time}] ${obs.kind || 'event'}: `;
      const desc = document.createElement('span');
      desc.textContent = obs.summary || '';
      item.appendChild(t);
      item.appendChild(desc);
      obsList.appendChild(item);
    });
    detailContent.appendChild(obsList);
  }

  if (task.worktree) {
    detailOpenWorktreeBtn.style.display = 'inline-flex';
    detailOpenWorktreeBtn.onclick = () => openWorktree(task.id);
  } else {
    detailOpenWorktreeBtn.style.display = 'none';
  }

  taskDetailDialog.showModal();
  updateIcons();
}

detailCloseBtn.addEventListener('click', () => taskDetailDialog.close());
detailDialogClose.addEventListener('click', () => taskDetailDialog.close());

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

const actionTools = new Set(['start_work', 'open_work', 'invoke_vscode']);

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
    for (const area of appState.areas) addToolChoice(control, area.id, `${area.name} / ${area.id.slice(0, 8)}`);
  } else if (propertyName === 'taskId' && appState.tasks.length) {
    control = document.createElement('select');
    for (const task of [...appState.tasks].reverse()) addToolChoice(control, task.id, `${task.title} / ${task.state}`);
  } else if (schema.enum) {
    control = document.createElement('select');
    for (const value of schema.enum) addToolChoice(control, value, toolLabel(value));
    if (propertyName === 'context') control.value = appConfig?.defaults?.copilotContext || 'long_context';
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
  toolResult.textContent = JSON.stringify({ name, args: {} }, null, 2);
  for (const shell of selectShells) if (toolForm.contains(shell)) selectShells.delete(shell);
  toolForm.replaceChildren();

  for (const [propertyName, schema] of Object.entries(parameters.properties || {})) {
    const { field, control } = createToolField(propertyName, schema, parameters.required?.includes(propertyName));
    toolForm.appendChild(field);
    if (control.tagName === 'SELECT') enhanceSelect(control);
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
  updateIcons();
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
    item.addEventListener('click', () => selectToolDefinition(definition));
    toolList.appendChild(item);
  }
  if (availableTools.length) selectToolDefinition(availableTools[0]);
  updateIcons();
}

async function loadTools() {
  try {
    const response = await fetch('/api/tools');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    availableTools = result;
    renderToolCatalog();
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
  toolResult.textContent = JSON.stringify({ request: { name, args, requestId } }, null, 2);
  try {
    const result = await callSupervisorTool(name, args, requestId);
    toolRunStatus.textContent = `${Math.round(performance.now() - startedAt)} ms`;
    toolRunStatus.className = 'badge badge-success';
    toolResult.textContent = JSON.stringify({ request: { name, args, requestId }, result }, null, 2);
    if (name === 'start_work') await loadState();
  } catch (error) {
    toolRunStatus.textContent = 'Failed';
    toolRunStatus.className = 'badge badge-danger';
    toolResult.textContent = JSON.stringify({ request: { name, args, requestId }, error: error.message }, null, 2);
  } finally {
    submit.disabled = false;
  }
});

async function openWorktree(taskId) {
  try {
    const result = await callSupervisorTool('open_work', { taskId });
    appendMessage('system', `Opened worktree: ${result.opened || taskId}`);
  } catch (err) {
    alert(`Could not open worktree: ${err.message}`);
  }
}

async function queryTaskStatus(taskId) {
  try {
    const result = await callSupervisorTool('get_work_status', { taskId });
    appendMessage('tool', `Status [${taskId.slice(0, 8)}]: state=${result.state}, stale=${result.stale}`);
    await loadState();
  } catch (err) {
    alert(`Could not get status: ${err.message}`);
  }
}

// New Task Dispatch
btnNewTask.addEventListener('click', () => {
  if (!appState.areas || appState.areas.length === 0) {
    alert('Please register at least one Work Area before dispatching a task.');
    return;
  }
  taskObjectiveInput.value = '';
  taskModelInput.value = appConfig?.defaults?.copilotModel || 'gpt-5.6-sol';
  taskContextSelect.value = appConfig?.defaults?.copilotContext || 'long_context';
  newTaskDialog.showModal();
});

taskCancelBtn.addEventListener('click', () => newTaskDialog.close());
taskDialogClose.addEventListener('click', () => newTaskDialog.close());

newTaskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const areaId = taskAreaSelect.value;
  const objective = taskObjectiveInput.value.trim();
  const model = taskModelInput.value.trim();
  const context = taskContextSelect.value;
  if (!areaId || !objective) return;

  try {
    const result = await callSupervisorTool('start_work', { areaId, objective, model, context });
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
            assistantBubble.textContent = accumulated;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (evt.type === 'tool') {
            const toolStr = typeof evt.result === 'object' ? JSON.stringify(evt.result) : String(evt.result);
            appendMessage('tool', `Tool [${evt.name}]: ${toolStr}`);
          } else if (evt.type === 'error') {
            appendMessage('system', `Chat Error: ${evt.message}`);
          } else if (evt.type === 'done') {
            // Done
          }
        } catch (_) {}
      }
    }

    if (chatToken === currentChatToken && !abortController.signal.aborted && accumulated) {
      conversation.push({ role: 'assistant', content: accumulated });
    }
  } catch (err) {
    if (chatToken !== currentChatToken || abortController.signal.aborted || err.name === 'AbortError') {
      return;
    }
    appendMessage('system', `Error sending message: ${err.message}`);
  } finally {
    if (currentChatAbortController === abortController) {
      currentChatAbortController = null;
    }
  }
}

btnSendChat.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
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

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadState();
  await loadTools();
  initEventSource();
});
