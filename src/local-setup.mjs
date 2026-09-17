import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { ASSETS, assetReady, ensureAsset, readJson, setupError, stackPaths, withSetupLock, writeJson } from '../scripts/models.mjs';
import { createSetup } from './setup.mjs';
import { closeLocalVoice, isLocalVoiceWarm, localConfiguration, onLocalVoiceRuntimeExit, warmLocalVoice } from './local-voice.mjs';
import desktopLaunch from '../scripts/desktop-launch.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requirements = path.join(root, 'requirements-local.txt');
const pythonVersion = '3.12.11';
const englishModel = 'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl';
const receiptVersion = createHash('sha256').update(readFileSync(requirements)).update(`${pythonVersion}:torch2.8.0:spacy3.8.0:kokoro-local-v1`).digest('hex');
const CHAT_ASSET_IDS = new Set(['ling', 'llama']);
const policyGuidance = 'If execution is blocked by IT policy, stop retrying and ask IT to approve the runtime and its virtual environment, or configure PYTHON_BIN with an IT-approved Python 3.12 x64 path and restart the app. Do not bypass Defender, AppLocker or WDAC. Local chat does not require Kokoro.';
export const approvedPythonProbe = 'import ensurepip, platform, ssl, struct, sys, venv; assert sys.implementation.name == "cpython", "CPython required"; assert sys.version_info[:2] == (3, 12), "Python 3.12 required"; assert platform.machine().lower() in ("amd64", "x86_64") and struct.calcsize("P") == 8, "Windows AMD64 required"; assert ensurepip.version() and ssl.OPENSSL_VERSION and venv.EnvBuilder, "venv, ensurepip and SSL required"';
const isolatedPythonProbe = 'import pip, sys; assert sys.prefix != sys.base_prefix, "Dedicated virtual environment required"; assert pip.__version__, "Bundled pip required"';

export function isolatedEnvironment(env, paths) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  return {
    ...isolated, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1',
    HF_HOME: path.join(paths.home, 'huggingface'), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    PIP_CACHE_DIR: path.join(paths.home, 'pip-cache'), PIP_CONFIG_FILE: 'NUL', PIP_DISABLE_PIP_VERSION_CHECK: '1',
    UV_CACHE_DIR: path.join(paths.home, 'uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(paths.runtimeDir, 'python'),
    UV_PYTHON_BIN_DIR: path.join(paths.runtimeDir, 'python-bin'), UV_PYTHON_DOWNLOADS: 'manual', UV_NATIVE_TLS: '1',
  };
}

function sanitizeSetupOutput(text, env) {
  let output = stripVTControlCharacters(text).replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const secrets = [...Object.entries(process.env), ...Object.entries(env || {})]
    .filter(([key, value]) => /token|secret|password|passwd|pwd|api[_-]?key|credential|authorization|cookie/i.test(key) && typeof value === 'string' && value)
    .map(([, value]) => value).sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    output = output.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
  }
  return output.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, value => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch { return '[REDACTED URL]'; }
  }).replace(/\b[\w-]*(?:token|secret|password|passwd|pwd|api[_-]?key|credential|authorization|cookie)[\w-]*["']?\s*[:=][^\n]*/gi, '[REDACTED CREDENTIAL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, '[REDACTED AUTH]');
}

export function runSetupCommand(executable, args, { env, cwd, signal, report = () => {}, stage, message, timeout = 20 * 60 * 1000, redactEnv = env }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    report({ stage, message });
    const child = desktopLaunch.trackChild(spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }));
    const tails = { stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } };
    for (const [name, tail] of Object.entries(tails)) {
      child[name].setEncoding('utf8');
      child[name].on('data', chunk => {
        const text = tail.text + chunk;
        tail.truncated ||= text.length > 8192;
        tail.text = text.slice(-8192);
      });
    }
    const heartbeat = setInterval(() => report({ stage, message }), 3000);
    let stoppingError;
    const stop = error => {
      stoppingError ||= error;
      void desktopLaunch.stopChild(child).then(() => finish(stoppingError), () => finish(stoppingError));
    };
    const abort = () => stop(setupError('Local setup was stopped. Completed files will be reused next time.'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(setupError(`${message} Timed out. Check your connection and free disk space, then retry.`)), timeout);
    let completed = false;
    function finish(error) {
      if (completed) return;
      completed = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      let logged = false;
      try {
        let output = `${new Date().toISOString()} ${stage}: ${message}\nExecutable: ${executable}\n${error ? error.setupMessage : 'Process completed.'}\n`;
        for (const [name, tail] of Object.entries(tails)) {
          const text = tail.truncated ? (tail.text.includes('\n') ? tail.text.slice(tail.text.indexOf('\n') + 1) : '') : tail.text;
          output += `\n[${name}${tail.truncated ? ' tail truncated' : ''}]\n${text}\n`;
        }
        const logDir = path.join(cwd, 'logs');
        mkdirSync(logDir, { recursive: true });
        writeFileSync(path.join(logDir, 'local-setup.log'), Buffer.from(sanitizeSetupOutput(output, redactEnv)).subarray(-64 * 1024), { mode: 0o600 });
        logged = true;
      } catch {}
      if (error) {
        const hint = logged ? ' See logs/local-setup.log in the setup cache for local diagnostics.' : ' The local setup log could not be written; check cache permissions and disk space.';
        reject(setupError(`${error.setupMessage}${hint}`));
      } else resolve();
    }
    child.once('error', error => finish(setupError(`${message} Could not run the local process (${error.code || 'launch error'}). Check that the configured executable exists and is permitted to run. ${policyGuidance}`)));
    child.once('close', (code, exitSignal) => {
      const diagnostic = `${tails.stdout.text}\n${tails.stderr.text}`;
      const secureConnectionFailed = /HandshakeFailure|certificate verify failed|CERTIFICATE_VERIFY_FAILED|TLS handshake|SSL error/i.test(diagnostic);
      const policyBlocked = /AppLocker|WDAC|blocked by (?:group policy|your (?:system )?administrator)|application control|access is denied|WinError (?:5|577|1260)\b/i.test(diagnostic) || [577, 1260, 0xc0000428].includes(code >>> 0);
      const guidance = policyBlocked ? policyGuidance : secureConnectionFailed
        ? 'Could not establish a secure HTTPS connection to the package source. Ask IT about trusted certificates, proxy or TLS inspection policy, and approved package mirrors. Do not disable TLS verification.'
        : 'Check disk space, network/proxy access and runtime prerequisites. Configured Python must be Python 3.12 x64 with venv and bundled pip. If IT reports a policy block, stop retries and contact IT; do not bypass security controls.';
      finish(stoppingError || (code === 0 ? null : setupError(`${message} Process exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}. ${guidance}`)));
    });
  });
}

function pythonReady(paths) {
  const receipt = readJson(path.join(paths.venv, 'complete.json'));
  if (receipt?.version !== receiptVersion) return false;
  try {
    const stat = statSync(paths.python);
    if (!stat.isFile() || stat.size !== receipt.size || stat.mtimeMs !== receipt.mtimeMs) return false;
    if (!paths.pythonBase) return true;
    const base = statSync(paths.pythonBase);
    return base.isFile() && receipt.base?.path === paths.pythonBase && base.size === receipt.base.size && base.mtimeMs === receipt.base.mtimeMs;
  } catch { return false; }
}

function packageIndex(value, fallback, label) {
  let url;
  try { url = new URL(value || fallback); } catch { throw setupError(`${label} must be a valid HTTPS or loopback URL.`); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !loopback || url.username || url.password) throw setupError(`${label} must use HTTPS or HTTP loopback without credentials.`);
  return url.href.replace(/\/$/, '');
}

export function createLocalSetup({ env = process.env, activateLLM, run = runSetupCommand, provision = ensureAsset, warm = warmLocalVoice } = {}) {
  const paths = stackPaths(env);
  const assets = ASSETS.filter(asset => asset.id !== 'uv' || !paths.pythonBase);
  const completionFile = path.join(paths.home, 'local-setup.json');
  const saved = readJson(completionFile);
  const pathInputs = Object.fromEntries(['LOCAL_LLM_PATH', 'MOONSHINE_MODEL', 'LLAMA_SERVER_BIN', 'CRISPASR_BIN', 'VAD_MODEL', 'PYTHON_BIN'].map(key => [key, env[key] || '']));
  if (saved?.version === 1 && saved.paths && JSON.stringify(saved.pathInputs) === JSON.stringify(pathInputs)) {
    for (const asset of ASSETS) {
      const candidate = saved.paths[asset.id];
      if (typeof candidate === 'string' && path.isAbsolute(candidate) && assetReady(paths, asset, candidate)) paths[asset.id] = candidate;
    }
  }
  const initialExternalUrl = env.LOCAL_LLM_URL;
  let llama = null;
  let ownedLlm = false;
  let active = false;
  let closing = false;
  let chatReady = false;
  let chatMessage = 'Local chat runtime is not ready. Start setup to initialize it.';
  let voiceReady = false;
  let voiceMessage = 'Local voice pipeline is not ready. Start setup to initialize it.';

  const inspect = () => [...assets.map(asset => ({ id: asset.id, label: asset.label, sourceUrl: asset.repo ? `https://huggingface.co/${asset.repo}` : asset.sourceUrl.replace(/\/releases\/download\/([^/]+)\/.*$/, '/releases/tag/$1'), ready: assetReady(paths, asset) })),
    { id: 'kokoro', label: paths.pythonBase ? 'Kokoro (approved Python; runtime download skipped)' : 'Kokoro Python environment', sourceUrl: 'https://pypi.org/project/kokoro/0.9.4/', ready: pythonReady(paths) }];

  const applyChatPaths = () => {
    Object.assign(env, {
      LOCAL_LLM_PATH: paths.ling,
      LLAMA_SERVER_BIN: paths.llama,
    });
  };

  const applyVoicePaths = () => {
    Object.assign(env, {
      MOONSHINE_EFFECTIVE_MODEL: paths.moonshine,
      MOONSHINE_TOKENIZER: paths.tokenizer,
      CRISPASR_BIN: paths.crispasr,
      VAD_MODEL: paths.vad,
      PYTHON_BIN: paths.python,
      KOKORO_LOCAL_DIR: path.dirname(paths.kokoroModel),
      KOKORO_READY: '1',
      KOKORO_REPO: 'hexgrad/Kokoro-82M',
      KOKORO_VOICE: 'af_heart',
      HF_HOME: path.join(paths.home, 'huggingface'),
      PIP_CACHE_DIR: path.join(paths.home, 'pip-cache'),
    });
  };

  const applyPaths = () => {
    applyChatPaths();
    applyVoicePaths();
  };

  if (inspect().every(component => component.ready)) applyPaths();

  const isChatAlive = () => {
    if (!chatReady) return false;
    if (llama && (llama.exitCode !== null || llama.signalCode !== null)) return false;
    return true;
  };

  const getCapabilities = () => ({
    chat: {
      ready: isChatAlive(),
      message: chatMessage,
    },
    voice: {
      ready: Boolean(voiceReady && active && isChatAlive()),
      message: voiceMessage,
    },
  });

  const activateChat = async ({ report = () => {}, signal } = {}) => {
    if (isChatAlive()) {
      chatMessage = 'Local chat runtime passed startup checks. Ready for messages.';
      return;
    }
    applyChatPaths();
    report({ stage: 'chat', message: 'Starting and checking the local chat runtime.' });
    let child;
    try {
      const ensureLLM = activateLLM || (await import('../scripts/start.mjs')).ensureLocalLLM;
      const result = await ensureLLM({ env, signal, privatePort: env.SUPERVISOR_DESKTOP === '1' || !env.LOCAL_LLM_URL, cwd: paths.home, requireWarm: true });
      llama = result.llama;
      ownedLlm = Boolean(result.llama);
      if (result.url) env.LOCAL_LLM_URL = result.url;
      else if (!env.LOCAL_LLM_URL) env.LOCAL_LLM_URL = 'http://127.0.0.1:8081/v1';

      child = llama;
      let exited = false;
      child?.once('exit', () => {
        exited = true;
        if (llama !== child) return;
        llama = null;
        active = false;
        chatReady = false;
        voiceReady = false;
        chatMessage = 'The local language runtime stopped. Retry setup to restart it; completed downloads will be reused.';
        voiceMessage = 'Local voice is unavailable because the chat runtime stopped.';
        if (ownedLlm) {
          if (initialExternalUrl !== undefined) env.LOCAL_LLM_URL = initialExternalUrl;
          else delete env.LOCAL_LLM_URL;
        }
        if (!closing) setup.invalidate('The local language runtime stopped. Retry setup to restart it; completed downloads will be reused.');
      });
      if (exited || (child && (child.exitCode !== null || child.signalCode !== null))) {
        throw new Error('Local language runtime stopped');
      }
      chatReady = true;
      chatMessage = 'Local chat runtime passed startup checks. Ready for messages.';
      if (!voiceReady) {
        voiceMessage = 'Local voice pipeline is waiting for speech dependencies.';
      }
    } catch (error) {
      chatReady = false;
      chatMessage = 'llama.cpp did not pass startup checks. Check available memory, Windows runtime requirements and security software, then retry. Completed models are retained.';
      voiceReady = false;
      voiceMessage = 'Local voice requires a running chat runtime. Retry setup after resolving chat errors.';
      const failedChild = llama || child;
      llama = null;
      failedChild?.kill?.();
      if (ownedLlm) {
        if (initialExternalUrl !== undefined) env.LOCAL_LLM_URL = initialExternalUrl;
        else delete env.LOCAL_LLM_URL;
      }
      throw setupError(chatMessage);
    }
  };

  const setup = createSetup({
    cacheDir: paths.home, runtimeDir: paths.runtimeDir, inspect, getCapabilities,
    install: ({ report, signal }) => withSetupLock(paths, async () => {
      const commandEnv = isolatedEnvironment(env, paths);
      mkdirSync(paths.home, { recursive: true });
      for (const asset of ASSETS.filter(asset => CHAT_ASSET_IDS.has(asset.id))) {
        await provision(paths, asset, { report, signal });
      }
      applyChatPaths();
      await activateChat({ report, signal });
      writeJson(completionFile, { version: 1, pathInputs, paths: Object.fromEntries(ASSETS.map(asset => [asset.id, paths[asset.id]])) });

      for (const asset of assets.filter(asset => !CHAT_ASSET_IDS.has(asset.id))) {
        await provision(paths, asset, { report, signal });
      }
      if (!pythonReady(paths)) {
        try {
          const command = (executable, args, stage, message) => run(executable, args, { env: commandEnv, redactEnv: env, cwd: paths.home, signal, report, stage, message });
          const torchIndex = packageIndex(env.LOCAL_TORCH_INDEX_URL, 'https://download.pytorch.org/whl/cpu', 'PyTorch package index');
          const pythonIndex = packageIndex(env.LOCAL_PYPI_INDEX_URL, 'https://pypi.org/simple', 'Python package index');
          const modelUrl = packageIndex(env.LOCAL_SPACY_MODEL_URL, englishModel, 'spaCy model URL');
          if (paths.pythonBase) {
            if (!existsSync(paths.pythonBase)) throw setupError('Configured PYTHON_BIN was not found. Set it to the full path of an IT-approved Python 3.12 x64 interpreter and restart the app. No downloaded Python or uv fallback will be attempted.');
            await command(paths.pythonBase, ['-I', '-c', approvedPythonProbe], 'python', 'Checking approved full CPython 3.12 x64 with venv, pip bootstrap and SSL. No Python runtime will be downloaded.');
            await command(paths.pythonBase, ['-I', '-m', 'venv', paths.venv], 'python', 'Creating Kokoro isolation with configured Python and bundled pip.');
            await command(paths.python, ['-I', '-c', isolatedPythonProbe], 'python', 'Checking the isolated Kokoro environment and bundled pip.');
          } else {
            await command(paths.uv, ['--no-config', 'python', 'install', pythonVersion], 'python', 'Installing private Python 3.12.11.');
            if (!existsSync(paths.python)) await command(paths.uv, ['--no-config', 'venv', '--python', pythonVersion, '--managed-python', paths.venv], 'python', 'Creating the isolated Kokoro environment.');
          }
          const installer = paths.pythonBase ? paths.python : paths.uv;
          const installArgs = paths.pythonBase
            ? ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input', '--cache-dir', commandEnv.PIP_CACHE_DIR, '--use-feature=truststore', 'install']
            : ['--no-config', 'pip', 'install', '--python', paths.python];
          await command(installer, [...installArgs, '--index-url', torchIndex, 'torch==2.8.0'], 'kokoro', 'Installing CPU speech dependencies.');
          await command(installer, [...installArgs, '--index-url', pythonIndex, '--only-binary', ':all:', '--no-binary', 'docopt', 'docopt==0.6.2', '-r', requirements, modelUrl], 'kokoro', 'Installing Kokoro and its English language model.');
          await command(paths.python, ['-I', '-c', 'import kokoro, soundfile, en_core_web_sm, torch; assert torch.__version__.startswith("2.8.0"); assert en_core_web_sm.__version__ == "3.8.0"'], 'kokoro', 'Checking installed speech dependencies.');
          const stat = statSync(paths.python);
          const base = paths.pythonBase && statSync(paths.pythonBase);
          writeJson(path.join(paths.venv, 'complete.json'), { version: receiptVersion, size: stat.size, mtimeMs: stat.mtimeMs, ...(base ? { base: { path: paths.pythonBase, size: base.size, mtimeMs: base.mtimeMs } } : {}) });
        } catch (error) {
          voiceReady = false;
          voiceMessage = error.setupMessage || error.message || 'Kokoro speech dependencies failed to install. Retry setup to complete speech.';
          throw error;
        }
      }
      applyPaths();
      writeJson(completionFile, { version: 1, pathInputs, paths: Object.fromEntries(ASSETS.map(asset => [asset.id, paths[asset.id]])) });
    }),
    async activate({ signal }) {
      if (active) return;
      await closeLocalVoice();
      await activateChat({ report: () => {}, signal });
      applyPaths();
      let runtime = 'Moonshine / Kokoro';
      try {
        if (!isChatAlive()) {
          runtime = 'llama.cpp';
          throw new Error('Local language runtime stopped');
        }
        runtime = 'Moonshine / Kokoro';
        if (!localConfiguration(env).configured || !await warm(env, signal)) throw new Error('Speech not configured');
        signal.throwIfAborted();
        if (warm === warmLocalVoice && !isLocalVoiceWarm()) throw new Error('Local speech runtime stopped during startup');
        if (!isChatAlive()) {
          runtime = 'llama.cpp';
          throw new Error('Local language runtime stopped');
        }
        active = true;
        voiceReady = true;
        voiceMessage = 'Local voice runtimes passed startup checks. Ready for voice interaction.';
      } catch (error) {
        if (error.message.includes('Kokoro')) runtime = 'Kokoro';
        else if (error.message.includes('CrispASR')) runtime = 'CrispASR';
        else if (error.message.includes('language runtime') || error.message.includes('llama')) runtime = 'llama.cpp';
        active = false;
        voiceReady = false;
        await closeLocalVoice();
        if (runtime === 'llama.cpp') {
          chatReady = false;
          const failedChild = llama;
          llama = null;
          failedChild?.kill?.();
          if (ownedLlm) {
            if (initialExternalUrl !== undefined) env.LOCAL_LLM_URL = initialExternalUrl;
            else delete env.LOCAL_LLM_URL;
          }
          chatMessage = 'llama.cpp did not pass startup checks. Retry setup to restart it.';
          voiceMessage = 'Local voice is unavailable because the chat runtime stopped.';
          throw setupError(`${runtime} did not pass startup checks. Check available memory, Windows runtime requirements and security software, then retry. Completed models are retained.`);
        }
        voiceMessage = `${runtime} did not pass startup checks. Check available memory and Windows runtime requirements. ${policyGuidance} For damaged Kokoro dependencies, ask IT to review the isolated environment under the configured runtime directory. Completed models are retained.`;
        throw setupError(voiceMessage);
      }
    },
  });
  const stopWatchingVoice = onLocalVoiceRuntimeExit(runtime => {
    if (closing || !active) return;
    active = false;
    voiceReady = false;
    voiceMessage = `${runtime} stopped unexpectedly. Retry setup to restart local voice.`;
    setup.invalidate(voiceMessage);
  });
  return {
    ...setup,
    resume() { if (saved?.version === 1 && ASSETS.filter(asset => CHAT_ASSET_IDS.has(asset.id)).every(asset => assetReady(paths, asset))) setup.resume(); },
    invalidate(message) {
      chatReady = false;
      voiceReady = false;
      chatMessage = message;
      voiceMessage = 'Local voice is unavailable because the chat runtime stopped.';
      setup.invalidate(message);
    },
    async close() {
      closing = true;
      stopWatchingVoice();
      await setup.close();
      active = false;
      chatReady = false;
      voiceReady = false;
      if (ownedLlm) {
        llama?.kill?.();
        llama = null;
        if (initialExternalUrl !== undefined) env.LOCAL_LLM_URL = initialExternalUrl;
        else delete env.LOCAL_LLM_URL;
      }
      await closeLocalVoice();
    },
  };
}