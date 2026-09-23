import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { stackPaths } from '../scripts/models.mjs';

export function localThreadDefault(cap, parallelism = availableParallelism()) {
  return String(Math.max(1, Math.min(cap, parallelism - 1)));
}

// Windows x64 desktops/laptops are almost always two-way SMT; llama.cpp decode scales with physical cores, not SMT siblings.
export function physicalCoreEstimate(parallelism = availableParallelism()) {
  return Math.max(1, Math.floor(parallelism / 2));
}

export function llamaThreadDefault(parallelism = availableParallelism()) {
  return String(Math.min(16, physicalCoreEstimate(parallelism)));
}

export function qwenThreadDefaults(parallelism = availableParallelism()) {
  const physical = physicalCoreEstimate(parallelism);
  return { decode: String(Math.max(1, Math.min(12, physical))), batch: String(Math.max(1, Math.min(16, physical))) };
}

const fields = Object.freeze([
  { key: 'DEFAULT_PROVIDER', label: 'Default text provider', group: 'Defaults', type: 'select', defaultValue: 'local', options: [['local', 'Local'], ['openai', 'OpenAI'], ['gemini', 'Google']] },
  { key: 'DEFAULT_VOICE_MODE', label: 'Default voice mode', group: 'Defaults', type: 'select', defaultValue: 'local', options: [['local', 'Local'], ['gemini-live', 'Gemini Live'], ['openai-realtime', 'OpenAI Realtime']] },
  { key: 'LOCAL_STT_PROVIDER', label: 'Local speech recognition', group: 'Local speech', type: 'select', defaultValue: 'whisper', options: [['whisper', 'Whisper Small (INT8)'], ['moonshine', 'Moonshine Tiny (opt-in)']] },
  { key: 'MOONSHINE_MODEL', label: 'Moonshine model path (blank uses managed Tiny)', group: 'Local speech', type: 'text', restartRequired: true },
  { key: 'WHISPER_LANGUAGE', label: 'Whisper spoken language', group: 'Local speech', type: 'select', defaultValue: 'en', options: [['auto', 'Automatic'], ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['ja', 'Japanese'], ['zh', 'Chinese']], restartRequired: true },
  { key: 'WHISPER_END_SILENCE_MS', label: 'Whisper pause before reply (ms)', group: 'Local speech', type: 'number', defaultValue: '1400', min: 200, max: 3000, restartRequired: true },
  { key: 'WHISPER_PREDECODE_MS', label: 'Whisper early decoding', group: 'Local speech', type: 'select', defaultValue: '480', options: [['480', 'On'], ['0', 'Off']], restartRequired: true },
  { key: 'END_SILENCE_MS', label: 'Moonshine pause before reply (ms)', group: 'Local speech', type: 'number', defaultValue: '1400', min: 600, max: 3000, restartRequired: true },
  { key: 'GEMINI_API_KEY', label: 'Google API key', group: 'Provider keys', type: 'password', secret: true },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', group: 'Provider keys', type: 'password', secret: true },
  { key: 'GEMINI_MODEL', label: 'Gemini text model', group: 'Models and endpoints', type: 'text', defaultValue: 'gemini-3.8-flash' },
  { key: 'GEMINI_LIVE_MODEL', label: 'Gemini Live model', group: 'Models and endpoints', type: 'text', defaultValue: 'gemini-3.8-live' },
  { key: 'OPENAI_MODEL', label: 'OpenAI text model', group: 'Models and endpoints', type: 'text', defaultValue: 'gpt-5.6-sol' },
  { key: 'LOCAL_LLM_MODEL', label: 'Local text model', group: 'Models and endpoints', type: 'text', defaultValue: 'ling-local' },
  { key: 'LOCAL_LLM_PATH', label: 'Local GGUF path (blank uses managed Gemma)', group: 'Models and endpoints', type: 'text', absolutePath: true, restartRequired: true },
  { key: 'LOCAL_LLM_PROFILE', label: 'Local language model', description: 'Qwen3.6 35B-A3B is an opt-in mixture-of-experts model: much stronger tool use, about 24 GB of RAM, a 23 GB model file plus a 24 GB speculative-decoding copy, and slower first load. Run local setup after switching.', group: 'Local model', type: 'select', defaultValue: 'gemma', options: [['gemma', 'Gemma 4 E2B (default)'], ['qwen', 'Qwen3.6 35B-A3B MoE (opt-in)']], restartRequired: true },
  { key: 'QWEN_MODEL_PATH', label: 'Qwen GGUF path (blank finds LocalVoiceStack or downloads the pinned Q4_K_P)', group: 'Local model', type: 'text', absolutePath: true, restartRequired: true },
  { key: 'QWEN_MTP', label: 'Qwen multi-token prediction', description: 'Speculative decoding with the model\'s own MTP layer: faster replies with identical output. Setup downloads 0.5 GB and builds a 24 GB accelerated copy.', group: 'Local model', type: 'select', defaultValue: 'on', options: [['on', 'On'], ['off', 'Off']], restartRequired: true },
  { key: 'QWEN_DRAFT_TOKENS', label: 'Qwen MTP draft tokens', group: 'Local model', type: 'number', defaultValue: '2', min: 1, max: 4, restartRequired: true },
  { key: 'QWEN_THREADS', label: 'Qwen generation threads', group: 'Local model', type: 'number', defaultValue: qwenThreadDefaults().decode, min: 1, max: 128, restartRequired: true },
  { key: 'QWEN_THREADS_BATCH', label: 'Qwen prompt threads', group: 'Local model', type: 'number', defaultValue: qwenThreadDefaults().batch, min: 1, max: 128, restartRequired: true },
  { key: 'QWEN_CONTEXT', label: 'Qwen context size', group: 'Local model', type: 'number', defaultValue: '8192', min: 2048, max: 65536, restartRequired: true },
  { key: 'OPENAI_REALTIME_MODEL', label: 'OpenAI Realtime model', group: 'Models and endpoints', type: 'text', defaultValue: 'gpt-realtime' },
  { key: 'OPENAI_BASE_URL', label: 'OpenAI base URL', group: 'Models and endpoints', type: 'url', defaultValue: 'https://api.openai.com/v1' },
  { key: 'OPENAI_STT_MODEL', label: 'OpenAI speech recognition model', group: 'Models and endpoints', type: 'text', defaultValue: 'gpt-4o-mini-transcribe' },
  { key: 'OPENAI_TTS_MODEL', label: 'OpenAI speech synthesis model', group: 'Models and endpoints', type: 'text', defaultValue: 'gpt-4o-mini-tts' },
  { key: 'GEMINI_STT_MODEL', label: 'Google speech recognition model', group: 'Models and endpoints', type: 'text', defaultValue: 'gemini-3.8-flash' },
  { key: 'GEMINI_TTS_MODEL', label: 'Google speech synthesis model', group: 'Models and endpoints', type: 'text', defaultValue: 'gemini-2.5-flash-preview-tts' },
  { key: 'PYTHON_BIN', label: 'Python 3.12 x64 path (optional)', group: 'Local setup network', type: 'text', absolutePath: true, restartRequired: true },
  { key: 'LOCAL_PYPI_INDEX_URL', label: 'Python package index', group: 'Local setup network', type: 'url', defaultValue: 'https://pypi.org/simple' },
  { key: 'LOCAL_TORCH_INDEX_URL', label: 'PyTorch package index', group: 'Local setup network', type: 'url', defaultValue: 'https://download.pytorch.org/whl/cpu' },
  { key: 'LOCAL_SPACY_MODEL_URL', label: 'spaCy English 3.8.0 wheel URL (optional)', group: 'Local setup network', type: 'url' },
  { key: 'COPILOT_CLI', label: 'Copilot CLI executable', group: 'Coding tools', type: 'text', defaultValue: process.platform === 'win32' ? 'copilot.exe' : 'copilot' },
  { key: 'AGENCY_CLI', label: 'Agency executable', group: 'Coding tools', type: 'text', defaultValue: process.platform === 'win32' ? 'agency.exe' : 'agency' },
  { key: 'AGENCY_WORK_DATA_ACCESS', label: 'Private work sources', description: 'Invoke research permission for WorkIQ, Teams, Outlook calendar and people; not an Agency setting. Uses cloud services; questions and answers are saved and may be spoken. Work-account access is still required.', group: 'Coding tools', type: 'select', defaultValue: 'disabled', options: [['disabled', 'Off'], ['read-only', 'Read-only']] },
  { key: 'VOICE_DIRECT_MCP_ACCESS', label: 'Direct work tools', description: 'Let chat and voice calls use approved read-only work tools without an Agency task. Requires Private work sources; tool definitions load only when needed.', group: 'Coding tools', type: 'select', defaultValue: 'disabled', options: [['disabled', 'Off'], ['read-only', 'Read-only']] },
  { key: 'AGENCY_M365_TOOLS', label: 'Microsoft 365 tools', description: 'WorkIQ covers M365 search and exact reads. Expanded also enables dedicated Teams, calendar and people tools. Does not grant access.', group: 'Coding tools', type: 'select', defaultValue: 'workiq', options: [['workiq', 'WorkIQ'], ['expanded', 'Expanded']] },
  { key: 'COPILOT_REASONING', label: 'Copilot reasoning effort', group: 'Coding tools', type: 'select', defaultValue: 'medium', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'LOCAL_ROUTER', label: 'Local routing', description: 'Raw-scored is experimental and can select incorrect actions. Regular is the default and recommended route for Qwen.', group: 'Local performance', type: 'select', defaultValue: 'scored', options: [['off', 'Regular'], ['scored', 'Raw-scored (experimental)']] },
  { key: 'LOCAL_EARLY_PREFILL', label: 'Early reply preparation', description: 'With Whisper and Regular routing, prepare the local model with the provisional transcript while the end of speech is confirmed. Saves roughly 0.1-0.3 s of prompt work per turn; answers are unchanged.', group: 'Local performance', type: 'select', defaultValue: 'on', options: [['on', 'On'], ['off', 'Off']] },
  { key: 'LLAMA_THREADS', label: 'Local LLM threads', group: 'Local performance', type: 'number', defaultValue: llamaThreadDefault(), min: 1, max: 128, restartRequired: true },
  { key: 'LLAMA_REASONING_BUDGET', label: 'Local LLM thinking tokens', description: '256 bounds long reasoning. Lower values can reduce tool accuracy. 0 disables thinking; -1 is unlimited. Tool-free summaries use 0.', group: 'Local performance', type: 'number', defaultValue: '256', min: -1, max: 512, restartRequired: true },
  { key: 'LLAMA_CONTEXT', label: 'Local LLM context size', group: 'Local performance', type: 'number', defaultValue: '4096', min: 1024, max: 131072, restartRequired: true },
  { key: 'LLAMA_PARALLEL', label: 'Local LLM parallel slots', group: 'Local performance', type: 'number', defaultValue: '1', min: 1, max: 16, restartRequired: true },
  { key: 'LLAMA_BACKEND', label: 'Local LLM compute backend', description: 'Vulkan uses a pinned 32 MB llama.cpp GPU build for NVIDIA, AMD or Intel GPUs. With GPU layers auto, llama.cpp fits what VRAM allows and keeps the rest on the CPU. GPUs with little VRAM can be slower than CPU. Run local setup after switching.', group: 'Local performance', type: 'select', defaultValue: 'cpu', options: [['cpu', 'CPU (default)'], ['vulkan', 'Vulkan GPU offload (opt-in)']], restartRequired: true },
  { key: 'LLAMA_GPU_LAYERS', label: 'Local LLM GPU layers (auto or 0-999; GPU build required)', group: 'Local performance', type: 'text', defaultValue: 'auto', restartRequired: true },
  { key: 'LLAMA_FLASH_ATTN', label: 'Local LLM flash attention', group: 'Local performance', type: 'select', defaultValue: 'auto', options: [['auto', 'Automatic'], ['on', 'On'], ['off', 'Off']], restartRequired: true },
  { key: 'LLAMA_CACHE_TYPE_K', label: 'Local LLM key cache type', group: 'Local performance', type: 'select', defaultValue: 'f16', options: [['f16', 'F16'], ['q8_0', 'Q8_0']], restartRequired: true },
  { key: 'LLAMA_CACHE_TYPE_V', label: 'Local LLM value cache type', group: 'Local performance', type: 'select', defaultValue: 'f16', options: [['f16', 'F16'], ['q8_0', 'Q8_0']], restartRequired: true },
  { key: 'WHISPER_THREADS', label: 'Whisper recognition threads', group: 'Local performance', type: 'number', defaultValue: localThreadDefault(8), min: 1, max: 128, restartRequired: true },
  { key: 'CRISPASR_THREADS', label: 'Moonshine recognition threads', group: 'Local performance', type: 'number', defaultValue: localThreadDefault(12), min: 1, max: 128, restartRequired: true },
  { key: 'KOKORO_THREADS', label: 'Speech synthesis threads', group: 'Local performance', type: 'number', defaultValue: localThreadDefault(8), min: 1, max: 128, restartRequired: true },
]);

const byKey = new Map(fields.map(field => [field.key, field]));

function normalize(field, raw) {
  if (typeof raw !== 'string') throw new Error(`${field.label} must be text.`);
  const value = raw.trim();
  if (value.length > (field.secret ? 4096 : 500)) throw new Error(`${field.label} is too long.`);
  if (field.key === 'LLAMA_GPU_LAYERS' && !/^(?:auto|\d{1,3})$/.test(value)) throw new Error(`${field.label} must be auto or an integer from 0 to 999.`);
  if (field.absolutePath && value && !path.isAbsolute(value)) throw new Error(`${field.label} must be an absolute executable path.`);
  if (field.type === 'select' && !field.options.some(([id]) => id === value)) throw new Error(`${field.label} has an unsupported value.`);
  if (field.type === 'number') {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < field.min || number > field.max) throw new Error(`${field.label} must be an integer from ${field.min} to ${field.max}.`);
    return String(number);
  }
  if (field.type === 'url' && value) {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${field.label} must be a valid URL.`); }
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !loopback) throw new Error(`${field.label} must use HTTPS or HTTP loopback.`);
    if (url.username || url.password) throw new Error(`${field.label} cannot contain credentials.`);
  }
  return value;
}

export function createRuntimeConfig({ dataDir, env = process.env } = {}) {
  const file = path.join(dataDir, 'config.json');
  let values = {};
  const warnings = [];
  let startupValues;
  const apply = (includeRestart) => {
    for (const field of fields) {
      if (!includeRestart && field.restartRequired) continue;
      if (Object.hasOwn(values, field.key)) env[field.key] = values[field.key];
    }
    if (values.LOCAL_ROUTER === 'scored') {
      env.LOCAL_ROUTER_MIN_PROBABILITY = '0';
      env.LOCAL_ROUTER_MIN_MARGIN = '0';
    }
  };
  const snapshot = () => ({
    path: file,
    warnings: [...warnings],
    fields: fields.map(field => ({
      key: field.key,
      label: field.label,
      ...(field.description ? { description: field.description } : {}),
      group: field.group,
      type: field.type,
      secret: field.secret === true,
      ...(field.options ? { options: field.options.map(([value, label]) => ({ value, label })) } : {}),
      ...(field.min !== undefined ? { min: field.min, max: field.max } : {}),
      restartRequired: field.restartRequired === true,
      pendingRestart: field.restartRequired === true && Object.hasOwn(values, field.key) && startupValues[field.key] !== values[field.key],
      configured: field.secret === true ? Boolean(env[field.key]) : undefined,
      value: field.secret ? undefined : (Object.hasOwn(values, field.key) ? values[field.key] : (field.restartRequired ? startupValues[field.key] : env[field.key]) || field.defaultValue || ''),
    })),
  });
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved?.version === 1 && saved.values && typeof saved.values === 'object' && !Array.isArray(saved.values)) {
      for (const [key, value] of Object.entries(saved.values)) {
        if (!byKey.has(key)) continue;
        if (typeof value !== 'string') {
          const warning = `Saved ${key} configuration was ignored: value must be text.`;
          warnings.push(warning);
          console.warn(warning);
          continue;
        }
        try { values[key] = normalize(byKey.get(key), value); }
        catch (error) {
          const warning = `Saved ${key} configuration was ignored: ${error.message}`;
          warnings.push(warning);
          console.warn(warning);
        }
      }
      apply(true);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const warning = 'Saved application configuration was ignored because the file is invalid.';
      warnings.push(warning);
      console.warn(`${warning} ${error.message}`);
    }
  }
  if (!env.LOCAL_ROUTER) {
    // The choice router offsets slow small-model planning; Qwen's single structured pass is faster and more accurate.
    env.LOCAL_ROUTER = env.LOCAL_LLM_PROFILE === 'qwen' ? 'off' : byKey.get('LOCAL_ROUTER').defaultValue;
    env.LOCAL_ROUTER_MIN_PROBABILITY ??= '0';
    env.LOCAL_ROUTER_MIN_MARGIN ??= '0';
  }
  const startupEnvironment = { ...env, WHISPER_LANGUAGE: env.WHISPER_LANGUAGE || 'en', WHISPER_THREADS: env.WHISPER_THREADS || env.LOCAL_THREADS || localThreadDefault(8), CRISPASR_THREADS: env.CRISPASR_THREADS || env.LOCAL_THREADS || localThreadDefault(12), PYTHON_BIN: stackPaths(env).pythonBase || '' };
  startupValues = Object.fromEntries(fields.filter(field => field.restartRequired).map(field => [field.key, startupEnvironment[field.key] || field.defaultValue || '']));
  return {
    snapshot,
    update(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw new Error('Configuration values are required.');
      const next = { ...values };
      for (const [key, raw] of Object.entries(input.values)) {
        const field = byKey.get(key);
        if (!field) throw new Error(`Unsupported configuration field: ${key}`);
        next[key] = normalize(field, raw);
      }
      values = next;
      mkdirSync(dataDir, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, values }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
      try { chmodSync(file, 0o600); } catch {}
      apply(false);
      return snapshot();
    },
  };
}