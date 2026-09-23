import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { ASSETS, LEGACY_LING_ASSETS, assetReady, ensureAsset, localLlmAsset, localLlmProfile, localSetupAssets, localSttProvider, qwenMtpEnabled, readJson, setupError, stackPaths, withSetupLock, writeJson } from '../scripts/models.mjs';
import { QWEN_MTP_HEAD, ensureQwenMtp, qwenMtpReady } from '../scripts/qwen-mtp.mjs';
import { createSetup } from './setup.mjs';
import { closeLocalVoice, isLocalVoiceWarm, localConfiguration, onLocalVoiceRuntimeExit, warmLocalVoice } from './local-voice.mjs';
import { verifyKokoroPack, verifyWhisperPack } from './kokoro-pack.mjs';
import { resolveVoicePack } from './voice-pack.mjs';
import desktopLaunch from '../scripts/desktop-launch.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requirements = path.join(root, 'requirements-local.txt');
const whisperRequirements = path.join(root, 'requirements-whisper.txt');
const pythonVersion = '3.12.11';
const englishModel = 'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl';
const receiptVersion = createHash('sha256').update(readFileSync(requirements)).update(`${pythonVersion}:torch2.8.0:spacy3.8.0:kokoro-local-v2:offline-pack-v1`).digest('hex');
const whisperReceiptVersion = createHash('sha256').update(readFileSync(whisperRequirements)).update(receiptVersion).digest('hex');
const CHAT_ASSET_IDS = new Set(['ling', 'llama']);
export const approvedPythonProbe = 'import ensurepip, platform, ssl, struct, sys, venv; assert sys.implementation.name == "cpython", "CPython required"; assert sys.version_info[:2] == (3, 12), "Python 3.12 required"; assert platform.machine().lower() in ("amd64", "x86_64") and struct.calcsize("P") == 8, "Windows AMD64 required"; assert ensurepip.version() and ssl.OPENSSL_VERSION and venv.EnvBuilder, "venv, ensurepip and SSL required"';
const isolatedPythonProbe = 'import pip, sys; assert sys.prefix != sys.base_prefix, "Dedicated virtual environment required"; assert pip.__version__, "Bundled pip required"';
const managedPythonProbe = `import platform, struct, sys; assert sys.version_info[:3] == (${pythonVersion.split('.').join(', ')}), "Pinned Python ${pythonVersion} required"; assert platform.machine().lower() in ("amd64", "x86_64") and struct.calcsize("P") == 8, "Windows AMD64 required"`;

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
    child.once('error', error => finish(setupError(`${message} Could not run the local process (${error.code || 'launch error'}). Check the runtime path and permissions.`)));
    child.once('close', (code, exitSignal) => {
      finish(stoppingError || (code === 0 ? null : setupError(`${message} Process exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}. Installed files are retained.`)));
    });
  });
}

function pythonReady(paths, file = 'complete.json', version = receiptVersion) {
  const receipt = readJson(path.join(paths.venv, file));
  if (receipt?.version !== version) return false;
  try {
    const stat = statSync(paths.python);
    if (!stat.isFile() || stat.size !== receipt.size || stat.mtimeMs !== receipt.mtimeMs) return false;
    if (!paths.pythonBase) return true;
    const base = statSync(paths.pythonBase);
    return base.isFile() && receipt.base?.path === paths.pythonBase && base.size === receipt.base.size && base.mtimeMs === receipt.base.mtimeMs;
  } catch { return false; }
}

function recordPython(paths, file, version) {
  const stat = statSync(paths.python);
  const base = paths.pythonBase && statSync(paths.pythonBase);
  writeJson(path.join(paths.venv, file), { version, size: stat.size, mtimeMs: stat.mtimeMs, ...(base ? { base: { path: paths.pythonBase, size: base.size, mtimeMs: base.mtimeMs } } : {}) });
}

function packageIndex(value, fallback, label) {
  let url;
  try { url = new URL(value || fallback); } catch { throw setupError(`${label} must be a valid HTTPS or loopback URL.`); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !loopback || url.username || url.password) throw setupError(`${label} must use HTTPS or HTTP loopback without credentials.`);
  return url.href.replace(/\/$/, '');
}

export function createLocalSetup({ env = process.env, activateLLM, run = runSetupCommand, provision = ensureAsset, buildMtp = ensureQwenMtp, warm = warmLocalVoice, offlinePackDir = path.join(root, 'artifacts', 'kokoro-offline-pack'), compressedPackDir = path.join(root, 'artifacts', 'voice-pack') } = {}) {
  const paths = stackPaths(env);
  const qwen = localLlmProfile(env) === 'qwen';
  const mtp = qwenMtpEnabled(env);
  const assets = ASSETS.map(asset => asset.id === 'ling' ? localLlmAsset(env) : asset);
  const selectedAssets = () => localSetupAssets(env).filter(asset => asset.id !== 'uv' || !paths.pythonBase);
  const whisperReady = () => pythonReady(paths, 'whisper-complete.json', whisperReceiptVersion);
  const sttLabel = () => localSttProvider(env) === 'whisper' ? 'Whisper Small INT8' : 'Moonshine Tiny streaming';
  const completionFile = path.join(paths.home, 'local-setup.json');
  const saved = readJson(completionFile);
  const pathInputs = Object.fromEntries(['LOCAL_LLM_PATH', 'MOONSHINE_MODEL', 'WHISPER_MODEL_DIR', 'LLAMA_SERVER_BIN', 'CRISPASR_BIN', 'VAD_MODEL', 'PYTHON_BIN', ...(qwen ? ['LOCAL_LLM_PROFILE', 'QWEN_MODEL_PATH', 'QWEN_MTP'] : []), ...(env.LLAMA_BACKEND === 'vulkan' ? ['LLAMA_BACKEND'] : [])].map(key => [key, env[key] || '']));
  const upgradeManagedModel = !qwen && saved?.version === 1 && !pathInputs.LOCAL_LLM_PATH && !saved.pathInputs?.LOCAL_LLM_PATH
    && LEGACY_LING_ASSETS.some(previousModel => saved.paths?.ling === path.join(paths.modelDir, previousModel.name)
      && assetReady(paths, previousModel, saved.paths.ling));
  if (saved?.version === 1 && saved.paths && JSON.stringify(saved.pathInputs) === JSON.stringify(pathInputs)) {
    for (const asset of assets) {
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

  const inspect = () => [...selectedAssets().map(asset => ({ id: asset.id, label: asset.label, sourceUrl: asset.repo ? `https://huggingface.co/${asset.repo}` : asset.sourceUrl.replace(/\/releases\/download\/([^/]+)\/.*$/, '/releases/tag/$1'), ready: assetReady(paths, asset) })),
    ...(mtp ? [{ id: QWEN_MTP_HEAD.id, label: QWEN_MTP_HEAD.label, sourceUrl: `https://huggingface.co/${QWEN_MTP_HEAD.repo}`, ready: qwenMtpReady(paths) }] : []),
    { id: 'kokoro', label: paths.pythonBase ? 'Kokoro (approved Python; runtime download skipped)' : 'Kokoro Python environment', sourceUrl: 'https://pypi.org/project/kokoro/0.9.4/', ready: pythonReady(paths) },
    ...(localSttProvider(env) === 'whisper' ? [{ id: 'whisper', label: 'faster-whisper 1.2.1 (CPU INT8)', sourceUrl: 'https://pypi.org/project/faster-whisper/1.2.1/', ready: pythonReady(paths) && whisperReady() }] : [])];

  const applyChatPaths = () => {
    Object.assign(env, {
      [qwen ? 'QWEN_MODEL_PATH' : 'LOCAL_LLM_PATH']: paths.ling,
      LLAMA_SERVER_BIN: paths.llama,
    });
  };

  const applyVoicePaths = () => {
    Object.assign(env, {
      MOONSHINE_EFFECTIVE_MODEL: paths.moonshine,
      MOONSHINE_TOKENIZER: paths.tokenizer,
      WHISPER_MODEL_DIR: path.dirname(paths.whisperModel),
      WHISPER_READY: whisperReady() ? '1' : '0',
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
      chatMessage = `Local chat (llama.cpp) could not start: ${sanitizeSetupOutput(error.message || 'No startup response.', env).replace(/\s+/g, ' ').slice(-400)} Installed files are retained.`;
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
    cacheDir: paths.home, runtimeDir: paths.runtimeDir, inspect, getCapabilities, minimumMemoryGiB: qwen ? 32 : 16,
    install: ({ report, signal }) => withSetupLock(paths, async () => {
      const commandEnv = isolatedEnvironment(env, paths);
      const command = (executable, args, stage, message) => run(executable, args, { env: commandEnv, redactEnv: env, cwd: paths.home, signal, report, stage, message });
      const installOffline = async (pack, stage, message) => {
        if (!paths.pythonBase) await command(paths.python, ['-I', '-m', 'ensurepip', '--upgrade'], stage, 'Preparing the bundled Python package installer without network access.');
        await command(paths.python, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input', '--no-cache-dir', 'install', '--no-index', '--find-links', pack.wheelhouse, '--only-binary', ':all:', '--require-hashes', '-r', pack.lockFile], stage, message);
      };
      let preparedPack;
      const compressedPack = async () => preparedPack ??= await resolveVoicePack({ sourceDir: compressedPackDir, paths, env, report, signal, run: (executable, args, options) => run(executable, args, { ...options, env: commandEnv, redactEnv: env, cwd: paths.home }) });
      mkdirSync(paths.home, { recursive: true });
      for (const asset of assets.filter(asset => CHAT_ASSET_IDS.has(asset.id))) {
        await provision(paths, asset, { report, signal });
      }
      if (mtp) await buildMtp(paths, { report, signal });
      applyChatPaths();
      await activateChat({ report, signal });
      writeJson(completionFile, { version: 1, pathInputs, paths: Object.fromEntries(assets.map(asset => [asset.id, paths[asset.id]])) });

      for (const asset of selectedAssets().filter(asset => !CHAT_ASSET_IDS.has(asset.id))) {
        await provision(paths, asset, { report, signal });
      }
      if (!pythonReady(paths)) {
        try {
          const torchIndex = packageIndex(env.LOCAL_TORCH_INDEX_URL, 'https://download.pytorch.org/whl/cpu', 'PyTorch package index');
          const pythonIndex = packageIndex(env.LOCAL_PYPI_INDEX_URL, 'https://pypi.org/simple', 'Python package index');
          const modelUrl = packageIndex(env.LOCAL_SPACY_MODEL_URL, englishModel, 'spaCy model URL');
          let bundledWhisperPack = await verifyWhisperPack(offlinePackDir);
          let offlinePack = bundledWhisperPack || await verifyKokoroPack(offlinePackDir);
          if (paths.pythonBase) {
            if (!existsSync(paths.pythonBase)) throw setupError('Configured PYTHON_BIN was not found. Set a Python 3.12 x64 path and restart the app. No downloaded Python or uv fallback will be attempted.');
            await command(paths.pythonBase, ['-I', '-c', approvedPythonProbe], 'python', 'Checking approved full CPython 3.12 x64 with venv, pip bootstrap and SSL. No Python runtime will be downloaded.');
            await command(paths.pythonBase, ['-I', '-m', 'venv', paths.venv], 'python', 'Creating Kokoro isolation with configured Python and bundled pip.');
            await command(paths.python, ['-I', '-c', isolatedPythonProbe], 'python', 'Checking the isolated Kokoro environment and bundled pip.');
          } else {
            await command(paths.uv, ['--no-config', 'python', 'install', pythonVersion], 'python', 'Installing private Python 3.12.11.');
            let rebuildVenv = !existsSync(paths.python);
            if (!rebuildVenv) {
              try {
                await command(paths.python, ['-I', '-c', managedPythonProbe], 'python', `Checking the cached managed Python ${pythonVersion} environment.`);
              } catch {
                rebuildVenv = true;
              }
            }
            if (rebuildVenv) {
              const clear = existsSync(paths.python) ? ['--clear'] : [];
              await command(paths.uv, ['--no-config', 'venv', ...clear, '--python', pythonVersion, '--managed-python', paths.venv], 'python', clear.length ? `Replacing the stale Kokoro environment with managed Python ${pythonVersion}.` : 'Creating the isolated Kokoro environment.');
            }
            await command(paths.python, ['-I', '-c', managedPythonProbe], 'python', `Checking the managed Python ${pythonVersion} environment.`);
          }
          if (!offlinePack) {
            bundledWhisperPack = await compressedPack();
            offlinePack = bundledWhisperPack;
          }
          const installer = paths.pythonBase ? paths.python : paths.uv;
          const installArgs = paths.pythonBase
            ? ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input', '--cache-dir', commandEnv.PIP_CACHE_DIR, '--use-feature=truststore', 'install']
            : ['--no-config', 'pip', 'install', '--python', paths.python];
          if (offlinePack) {
            await installOffline(offlinePack, 'kokoro', bundledWhisperPack ? 'Installing verified bundled local voice dependencies without network access.' : 'Installing verified bundled Kokoro dependencies without network access.');
          } else {
            const install = async (args, message) => {
              try {
                await command(installer, args, 'kokoro', message);
              } catch (onlineError) {
                if (paths.pythonBase) throw onlineError;
                try {
                  await command(installer, [args[0], '--offline', ...args.slice(1)], 'kokoro', `${message} Retrying from the verified local package cache without network access.`);
                } catch {
                  const original = onlineError.setupMessage || onlineError.message || 'The package source could not be reached.';
                  throw setupError(`${original} The automatic offline package-cache fallback was attempted but did not contain every required pinned package.`);
                }
              }
            };
            await install([...installArgs, '--index-url', torchIndex, 'torch==2.8.0'], 'Installing CPU speech dependencies.');
            await install([...installArgs, '--index-url', pythonIndex, '--only-binary', ':all:', '--no-binary', 'docopt', 'docopt==0.6.2', '-r', requirements, modelUrl], 'Installing Kokoro and its English language model.');
          }
          await command(paths.python, ['-I', '-c', 'import kokoro, soundfile, en_core_web_sm, spacy, torch; assert kokoro.__version__ == "0.9.4"; assert soundfile.__version__ == "0.13.1"; assert spacy.__version__.startswith("3.8."); assert torch.__version__.startswith("2.8.0") and torch.version.cuda is None; assert en_core_web_sm.__version__ == "3.8.0"'], 'kokoro', 'Checking installed speech dependencies.');
          recordPython(paths, 'complete.json', receiptVersion);
          if (bundledWhisperPack) {
            await command(paths.python, ['-I', '-c', 'import faster_whisper, ctranslate2, onnxruntime; from faster_whisper.vad import get_vad_model; assert faster_whisper.__version__ == "1.2.1"; assert ctranslate2.__version__ == "4.6.0"; assert onnxruntime.__version__ == "1.23.2"; assert "int8" in ctranslate2.get_supported_compute_types("cpu"); get_vad_model()'], 'whisper', 'Checking bundled Whisper INT8 and Silero VAD.');
            recordPython(paths, 'whisper-complete.json', whisperReceiptVersion);
          }
        } catch (error) {
          voiceReady = false;
          voiceMessage = error.setupMessage || error.message || 'Kokoro speech dependencies failed to install. Retry setup to complete speech.';
          throw error;
        }
      }
      if (localSttProvider(env) === 'whisper' && !whisperReady()) {
        const installer = paths.pythonBase ? paths.python : paths.uv;
        const args = paths.pythonBase
          ? ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input', '--cache-dir', commandEnv.PIP_CACHE_DIR, '--use-feature=truststore', 'install']
          : ['--no-config', 'pip', 'install', '--python', paths.python];
        const command = (executable, commandArgs, message) => run(executable, commandArgs, { env: commandEnv, redactEnv: env, cwd: paths.home, signal, report, stage: 'whisper', message });
        const offlinePack = await verifyWhisperPack(offlinePackDir) || await compressedPack();
        if (offlinePack) {
          await installOffline(offlinePack, 'whisper', 'Installing verified bundled Whisper dependencies without network access.');
        } else {
          const pythonIndex = packageIndex(env.LOCAL_PYPI_INDEX_URL, 'https://pypi.org/simple', 'Python package index');
          const installArgs = [...args, '--index-url', pythonIndex, '--only-binary', ':all:', '-r', whisperRequirements];
          try {
            await command(installer, installArgs, 'Installing faster-whisper CPU INT8 dependencies.');
          } catch (onlineError) {
            if (paths.pythonBase || signal?.aborted) throw onlineError;
            try {
              await command(installer, [installArgs[0], '--offline', ...installArgs.slice(1)], 'Installing faster-whisper from the local package cache.');
            } catch { throw onlineError; }
          }
        }
        await command(paths.python, ['-I', '-c', 'import faster_whisper, ctranslate2, onnxruntime; from faster_whisper.vad import get_vad_model; assert faster_whisper.__version__ == "1.2.1"; assert ctranslate2.__version__ == "4.6.0"; assert onnxruntime.__version__ == "1.23.2"; assert "int8" in ctranslate2.get_supported_compute_types("cpu"); get_vad_model()'], 'Checking Whisper INT8 and bundled Silero VAD.');
        recordPython(paths, 'whisper-complete.json', whisperReceiptVersion);
      }
      if (preparedPack) {
        try { rmSync(preparedPack.packDir, { recursive: true, force: true }); } catch {}
      }
      applyPaths();
      writeJson(completionFile, { version: 1, pathInputs, paths: Object.fromEntries(assets.map(asset => [asset.id, paths[asset.id]])) });
    }),
    async activate({ signal, report = () => {} }) {
      if (active) return;
      if (upgradeManagedModel && !assetReady(paths, ASSETS[0])) {
        await withSetupLock(paths, () => provision(paths, ASSETS[0], { report, signal }));
      }
      await closeLocalVoice();
      await activateChat({ report: () => {}, signal });
      if (!saved || upgradeManagedModel) writeJson(completionFile, { version: 1, pathInputs, paths: Object.fromEntries(assets.map(asset => [asset.id, paths[asset.id]])) });
      applyPaths();
      let runtime = `${sttLabel()} / Kokoro`;
      try {
        if (!isChatAlive()) {
          runtime = 'llama.cpp';
          throw new Error('Local language runtime stopped');
        }
        runtime = `${sttLabel()} / Kokoro`;
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
        else if (error.message.includes('Whisper')) runtime = 'Whisper';
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
          throw setupError(`${runtime} stopped during startup. Retry to restart it. Installed files are retained.`);
        }
        const reason = sanitizeSetupOutput(error.message || 'No startup response.', env).replace(/\s+/g, ' ').slice(-400);
        voiceMessage = `${runtime} could not start: ${reason} Local chat remains available. Installed files are retained; retry to restart voice.`;
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
    async recognitionChanged() {
      active = false;
      voiceReady = false;
      voiceMessage = `${sttLabel()} selected. Run local voice setup to install missing components.`;
      await closeLocalVoice();
      applyVoicePaths();
      setup.invalidate(voiceMessage);
      if (inspect().every(component => component.ready)) setup.resume();
    },
    resume() { if (saved?.version === 1 && assets.filter(asset => CHAT_ASSET_IDS.has(asset.id)).every(asset => assetReady(paths, asset) || (asset.id === 'ling' && upgradeManagedModel)) && (!mtp || qwenMtpReady(paths))) setup.resume(); },
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