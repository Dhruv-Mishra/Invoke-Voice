const path = require('node:path');

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
  'https://github.com/Dhruv-Mishra/VoiceOrchestration/releases',
  'https://github.com/Dhruv-Mishra/VoiceOrchestration/releases/latest',
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

module.exports = { serverLaunch, allowedExternal, trackChild, stopChild };