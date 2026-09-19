const path = require('node:path');
const fs = require('node:fs');

const preferenceKeys = new Set([
  'voice-supervisor-theme-v2', 'voice-supervisor-sounds-v1', 'voice-supervisor-motion-v1',
  'voice-supervisor-transparency-v1', 'voice-supervisor-theme-variants-v1', 'voice-supervisor-sound-volume-v1',
  'voice-supervisor-wallpaper-strength-v1', 'voice-supervisor-theme-persona-v1', 'voice-supervisor-theme-voice-v1',
  'voice-supervisor-sidebar-v1', 'voice-supervisor-pipeline-v1',
]);

function createPreferenceStore(dataDir) {
  const file = path.join(dataDir, 'preferences.json');
  let values = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    values = Object.fromEntries(Object.entries(saved).filter(([key, value]) => preferenceKeys.has(key) && typeof value === 'string' && value.length <= 8192));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Saved appearance preferences could not be read.');
  }
  return {
    getItem(key) { return preferenceKeys.has(key) ? values[key] ?? null : null; },
    setItem(key, value) {
      if (!preferenceKeys.has(key) || typeof value !== 'string' || value.length > 8192) throw new Error('Unsupported application preference.');
      const next = { ...values, [key]: value };
      fs.mkdirSync(dataDir, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, file);
      values = next;
    },
  };
}

function resetMarker(dataDir) {
  if (!path.isAbsolute(dataDir) || path.basename(dataDir) !== 'VoiceSupervisor' || fs.lstatSync(dataDir).isSymbolicLink()) throw new Error('Invalid application data directory.');
  return path.join(dataDir, '.reset-request.json');
}

function requestDataReset(dataDir) {
  fs.writeFileSync(resetMarker(dataDir), JSON.stringify({ version: 1, parentPid: process.pid }), { encoding: 'utf8', mode: 0o600 });
}

function completeDataReset(dataDir, { legacyUpdateDir } = {}) {
  if (!fs.existsSync(dataDir)) return false;
  const marker = resetMarker(dataDir);
  if (!fs.existsSync(marker)) return false;
  const request = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (request.version !== 1 || !Number.isSafeInteger(request.parentPid) || request.parentPid <= 0) throw new Error('Invalid data reset request.');
  try {
    process.kill(request.parentPid, 0);
    throw new Error('Close the previous app instance before clearing application data.');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
  if (legacyUpdateDir && fs.existsSync(legacyUpdateDir)) {
    if (!path.isAbsolute(legacyUpdateDir) || path.basename(legacyUpdateDir) !== 'updates' || path.basename(path.dirname(legacyUpdateDir)) !== 'VoiceSupervisor' || fs.lstatSync(path.dirname(legacyUpdateDir)).isSymbolicLink()) throw new Error('Invalid update cache directory.');
    fs.rmSync(legacyUpdateDir, removeOptions);
  }
  for (const name of fs.readdirSync(dataDir)) {
    if (name !== path.basename(marker)) fs.rmSync(path.join(dataDir, name), removeOptions);
  }
  fs.rmSync(dataDir, removeOptions);
  return true;
}

function serverLaunch({ executable, appRoot, resourcesPath, packaged, dataDir, env = process.env }) {
  const backendRoot = packaged ? path.join(resourcesPath, 'app.asar.unpacked') : appRoot;
  const configDir = packaged ? dataDir : appRoot;
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', SUPERVISOR_DESKTOP: '1', SUPERVISOR_MODE: 'release', PORT: '0', SUPERVISOR_DATA_DIR: dataDir, SUPERVISOR_CACHE_DIR: dataDir, SUPERVISOR_CONFIG_DIR: configDir };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  return { executable, args: [`--env-file-if-exists=${path.join(configDir, '.env')}`, path.join(backendRoot, 'src', 'server.mjs'), '--release', '--port', '0'], options: { cwd: configDir, env: childEnv, windowsHide: true, shell: false } };
}

const externalSources = new Set([
  'https://huggingface.co/SC117/Ling-3.0-tiny-abliterated-APEX-GGUF',
  'https://huggingface.co/cstr/moonshine-streaming-tiny-GGUF',
  'https://huggingface.co/Systran/faster-whisper-small',
  'https://huggingface.co/ggml-org/whisper-vad',
  'https://huggingface.co/hexgrad/Kokoro-82M',
  'https://github.com/CrispStrobe/CrispASR/releases/tag/v0.8.32',
  'https://github.com/ggml-org/llama.cpp/releases/tag/b10970',
  'https://github.com/astral-sh/uv/releases/tag/0.8.17',
  'https://pypi.org/project/kokoro/0.9.4/',
  'https://pypi.org/project/faster-whisper/1.2.1/',
  'https://docs.github.com/en/copilot',
  'https://aka.ms/agency',
  'https://outlook.office.com/calendar/',
  'https://github.com/Dhruv-Mishra/Invoke-Voice/releases',
  'https://github.com/Dhruv-Mishra/Invoke-Voice/releases/latest',
]);

function allowedExternal(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search) return false;
    url.hash = '';
    return externalSources.has(url.href);
  } catch { return false; }
}

function trackChild(child) {
  if (process.connected && child.pid) {
    process.send({ type: 'owned-child', pid: child.pid, active: true });
    child.once('exit', () => { if (process.connected) process.send({ type: 'owned-child', pid: child.pid, active: false }); });
  }
  return child;
}

function stopChild(child) {
  if (!child?.pid || child.exitCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') { child.kill(); return Promise.resolve(); }
  const { spawn } = require('node:child_process');
  return new Promise(resolve => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('exit', resolve);
    killer.once('error', () => { child.kill(); resolve(); });
  });
}

module.exports = { serverLaunch, allowedExternal, trackChild, stopChild, requestDataReset, completeDataReset, createPreferenceStore };