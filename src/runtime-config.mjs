import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { stackPaths } from '../scripts/models.mjs';

export function localThreadDefault(cap, parallelism = availableParallelism()) {
  return String(Math.max(1, Math.min(cap, parallelism - 1)));
}

const fields = Object.freeze([
  { key: 'DEFAULT_PROVIDER', label: 'Default text provider', group: 'Defaults', type: 'select', defaultValue: 'local', options: [['local', 'Local'], ['gemini', 'Gemini'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['azure', 'Azure OpenAI'], ['custom', 'Custom']] },
  { key: 'DEFAULT_VOICE_MODE', label: 'Default voice mode', group: 'Defaults', type: 'select', defaultValue: 'local', options: [['local', 'Local'], ['gemini-live', 'Gemini Live'], ['openai-realtime', 'OpenAI Realtime']] },
  { key: 'LOCAL_STT_PROVIDER', label: 'Local speech recognition', group: 'Local speech', type: 'select', defaultValue: 'whisper', options: [['whisper', 'Whisper Small (INT8)'], ['moonshine', 'Moonshine Small (streaming)']] },
  { key: 'WHISPER_LANGUAGE', label: 'Whisper spoken language', group: 'Local speech', type: 'select', defaultValue: 'auto', options: [['auto', 'Automatic'], ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['ja', 'Japanese'], ['zh', 'Chinese']], restartRequired: true },
  { key: 'GEMINI_API_KEY', label: 'Gemini API key', group: 'Provider keys', type: 'password', secret: true },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', group: 'Provider keys', type: 'password', secret: true },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', group: 'Provider keys', type: 'password', secret: true },
  { key: 'AZURE_OPENAI_KEY', label: 'Azure OpenAI key', group: 'Provider keys', type: 'password', secret: true },
  { key: 'CUSTOM_API_KEY', label: 'Custom endpoint API key', group: 'Provider keys', type: 'password', secret: true },
  { key: 'GEMINI_MODEL', label: 'Gemini text model', group: 'Models and endpoints', type: 'text', defaultValue: 'gemini-3.8-flash' },
  { key: 'GEMINI_LIVE_MODEL', label: 'Gemini Live model', group: 'Models and endpoints', type: 'text', defaultValue: 'gemini-3.8-live' },
  { key: 'OPENAI_MODEL', label: 'OpenAI text model', group: 'Models and endpoints', type: 'text', defaultValue: 'gpt-4.1-mini' },
  { key: 'OPENAI_REALTIME_MODEL', label: 'OpenAI Realtime model', group: 'Models and endpoints', type: 'text', defaultValue: 'gpt-realtime' },
  { key: 'OPENAI_BASE_URL', label: 'OpenAI base URL', group: 'Models and endpoints', type: 'url', defaultValue: 'https://api.openai.com/v1' },
  { key: 'ANTHROPIC_MODEL', label: 'Anthropic model', group: 'Models and endpoints', type: 'text', defaultValue: 'claude-sonnet-4-5' },
  { key: 'AZURE_OPENAI_ENDPOINT', label: 'Azure OpenAI endpoint', group: 'Models and endpoints', type: 'url' },
  { key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Azure OpenAI deployment', group: 'Models and endpoints', type: 'text', defaultValue: 'gpt-4o-mini' },
  { key: 'AZURE_OPENAI_API_VERSION', label: 'Azure OpenAI API version', group: 'Models and endpoints', type: 'text', defaultValue: '2024-06-01' },
  { key: 'CUSTOM_BASE_URL', label: 'Custom OpenAI-compatible URL', group: 'Models and endpoints', type: 'url' },
  { key: 'CUSTOM_MODEL', label: 'Custom model', group: 'Models and endpoints', type: 'text' },
  { key: 'PYTHON_BIN', label: 'Use IT-approved Python 3.12 x64 (skips runtime download)', group: 'Local setup network', type: 'text', absolutePath: true, restartRequired: true },
  { key: 'LOCAL_PYPI_INDEX_URL', label: 'Python package index', group: 'Local setup network', type: 'url', defaultValue: 'https://pypi.org/simple' },
  { key: 'LOCAL_TORCH_INDEX_URL', label: 'PyTorch package index', group: 'Local setup network', type: 'url', defaultValue: 'https://download.pytorch.org/whl/cpu' },
  { key: 'LOCAL_SPACY_MODEL_URL', label: 'spaCy English 3.8.0 wheel URL (optional)', group: 'Local setup network', type: 'url' },
  { key: 'COPILOT_CLI', label: 'Copilot CLI executable', group: 'Coding tools', type: 'text', defaultValue: 'copilot.exe' },
  { key: 'AGENCY_CLI', label: 'Agency executable', group: 'Coding tools', type: 'text', defaultValue: 'agency.exe' },
  { key: 'COPILOT_REASONING', label: 'Copilot reasoning effort', group: 'Coding tools', type: 'select', defaultValue: 'medium', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'LLAMA_THREADS', label: 'Ling threads', group: 'Local performance', type: 'number', defaultValue: localThreadDefault(8), min: 1, max: 128, restartRequired: true },
  { key: 'LLAMA_CONTEXT', label: 'Ling context size', group: 'Local performance', type: 'number', defaultValue: '4096', min: 1024, max: 131072, restartRequired: true },
  { key: 'LLAMA_PARALLEL', label: 'Ling parallel slots', group: 'Local performance', type: 'number', defaultValue: '1', min: 1, max: 16, restartRequired: true },
  { key: 'LLAMA_GPU_LAYERS', label: 'Ling GPU layers (auto or 0-999; GPU build required)', group: 'Local performance', type: 'text', defaultValue: 'auto', restartRequired: true },
  { key: 'LLAMA_FLASH_ATTN', label: 'Ling flash attention', group: 'Local performance', type: 'select', defaultValue: 'auto', options: [['auto', 'Automatic'], ['on', 'On'], ['off', 'Off']], restartRequired: true },
  { key: 'LLAMA_CACHE_TYPE_K', label: 'Ling key cache type', group: 'Local performance', type: 'select', defaultValue: 'f16', options: [['f16', 'F16'], ['q8_0', 'Q8_0']], restartRequired: true },
  { key: 'LLAMA_CACHE_TYPE_V', label: 'Ling value cache type', group: 'Local performance', type: 'select', defaultValue: 'f16', options: [['f16', 'F16'], ['q8_0', 'Q8_0']], restartRequired: true },
  { key: 'WHISPER_THREADS', label: 'Whisper recognition threads', group: 'Local performance', type: 'number', defaultValue: localThreadDefault(8), min: 1, max: 128, restartRequired: true },
  { key: 'CRISPASR_THREADS', label: 'Moonshine recognition threads', group: 'Local performance', type: 'number', defaultValue: localThreadDefault(12), min: 1, max: 128, restartRequired: true },
  { key: 'KOKORO_THREADS', label: 'Speech synthesis threads', group: 'Local performance', type: 'number', defaultValue: '8', min: 1, max: 128, restartRequired: true },
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
  };
  const snapshot = () => ({
    path: file,
    warnings: [...warnings],
    fields: fields.map(field => ({
      key: field.key,
      label: field.label,
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
  const startupEnvironment = { ...env, WHISPER_LANGUAGE: env.WHISPER_LANGUAGE || 'auto', WHISPER_THREADS: env.WHISPER_THREADS || env.LOCAL_THREADS || localThreadDefault(8), CRISPASR_THREADS: env.CRISPASR_THREADS || env.LOCAL_THREADS || localThreadDefault(12), PYTHON_BIN: stackPaths(env).pythonBase || '' };
  startupValues = Object.fromEntries(fields.filter(field => field.restartRequired).map(field => [field.key, startupEnvironment[field.key]]));
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