import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { ASSETS, assetReady, ensureAsset, readJson, setupError, stackPaths, withSetupLock, writeJson } from '../scripts/models.mjs';
import { createSetup } from './setup.mjs';
import { closeLocalVoice, localConfiguration, warmLocalVoice } from './local-voice.mjs';
import desktopLaunch from '../scripts/desktop-launch.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requirements = path.join(root, 'requirements-local.txt');
const pythonVersion = '3.12.11';
const englishModel = 'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl';
const receiptVersion = createHash('sha256').update(readFileSync(requirements)).update(`${pythonVersion}:torch2.8.0:spacy3.8.0:kokoro-local-v1`).digest('hex');

export function isolatedEnvironment(env, paths) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  return {
    ...isolated, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1',
    HF_HOME: path.join(paths.home, 'huggingface'), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    PIP_CACHE_DIR: path.join(paths.home, 'pip-cache'), PIP_CONFIG_FILE: 'NUL', PIP_DISABLE_PIP_VERSION_CHECK: '1',
    UV_CACHE_DIR: path.join(paths.home, 'uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(paths.runtimeDir, 'python'),
    UV_PYTHON_BIN_DIR: path.join(paths.runtimeDir, 'python-bin'), UV_PYTHON_DOWNLOADS: 'manual',
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
        let output = `${new Date().toISOString()} ${stage}: ${message}\n${error ? error.setupMessage : 'Process completed.'}\n`;
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
    child.once('error', error => finish(setupError(`${message} Could not run the local process (${error.code || 'launch error'}). Check security software and the configured Python 3.12 path, then retry.`)));
    child.once('close', (code, exitSignal) => finish(stoppingError || (code === 0 ? null : setupError(`${message} Process exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}. Check disk space, network/proxy access and runtime prerequisites, then retry.`))));
  });
}

function pythonReady(paths) {
  const receipt = readJson(path.join(paths.venv, 'complete.json'));
  if (receipt?.version !== receiptVersion) return false;
  try { const stat = statSync(paths.python); return stat.isFile() && stat.size === receipt.size && stat.mtimeMs === receipt.mtimeMs; } catch { return false; }
}

export function createLocalSetup({ env = process.env, activateLLM, run = runSetupCommand, provision = ensureAsset, warm = warmLocalVoice } = {}) {
  const paths = stackPaths(env);
  const completionFile = path.join(paths.home, 'local-setup.json');
  const saved = readJson(completionFile);
  const pathInputs = Object.fromEntries(['LOCAL_LLM_PATH', 'MOONSHINE_MODEL', 'LLAMA_SERVER_BIN', 'CRISPASR_BIN', 'VAD_MODEL', 'PYTHON_BIN'].map(key => [key, env[key] || '']));
  if (saved?.version === 1 && saved.paths && JSON.stringify(saved.pathInputs) === JSON.stringify(pathInputs)) {
    for (const asset of ASSETS) {
      const candidate = saved.paths[asset.id];
      if (typeof candidate === 'string' && path.isAbsolute(candidate) && assetReady(paths, asset, candidate)) paths[asset.id] = candidate;
    }
  }
  let llama;
  let active = false;
  let closing = false;
  const inspect = () => [...ASSETS.map(asset => ({ id: asset.id, label: asset.label, sourceUrl: asset.repo ? `https://huggingface.co/${asset.repo}` : asset.sourceUrl.replace(/\/releases\/download\/([^/]+)\/.*$/, '/releases/tag/$1'), ready: assetReady(paths, asset) })),
    { id: 'kokoro', label: 'Kokoro Python environment', sourceUrl: 'https://pypi.org/project/kokoro/0.9.4/', ready: pythonReady(paths) }];
  const applyPaths = () => {
    Object.assign(env, {
      LOCAL_LLM_PATH: paths.ling, LLAMA_SERVER_BIN: paths.llama,
      MOONSHINE_EFFECTIVE_MODEL: paths.moonshine, MOONSHINE_TOKENIZER: paths.tokenizer,
      CRISPASR_BIN: paths.crispasr, VAD_MODEL: paths.vad, PYTHON_BIN: paths.python,
      KOKORO_LOCAL_DIR: path.dirname(paths.kokoroModel), KOKORO_READY: '1',
      KOKORO_REPO: 'hexgrad/Kokoro-82M', KOKORO_VOICE: 'af_heart',
      HF_HOME: path.join(paths.home, 'huggingface'), PIP_CACHE_DIR: path.join(paths.home, 'pip-cache'),
    });
  };
  if (inspect().every(component => component.ready)) applyPaths();
  const setup = createSetup({
    cacheDir: paths.home, runtimeDir: paths.runtimeDir, inspect,
    install: ({ report, signal }) => withSetupLock(paths, async () => {
      const commandEnv = isolatedEnvironment(env, paths);
      mkdirSync(paths.home, { recursive: true });
      for (const asset of ASSETS) await provision(paths, asset, { report, signal });
      if (!pythonReady(paths)) {
        const command = (executable, args, stage, message) => run(executable, args, { env: commandEnv, redactEnv: env, cwd: paths.home, signal, report, stage, message });
        const configuredPython = env.PYTHON_BIN && env.PYTHON_BIN !== 'python' ? path.resolve(env.SUPERVISOR_CONFIG_DIR || root, env.PYTHON_BIN) : null;
        let python = pythonVersion;
        if (configuredPython && configuredPython !== paths.python && existsSync(configuredPython)) {
          await command(configuredPython, ['-I', '-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 required"'], 'python', 'Checking your existing Python 3.12.');
          python = configuredPython;
        } else {
          await command(paths.uv, ['--no-config', 'python', 'install', pythonVersion], 'python', 'Installing private Python 3.12.11.');
        }
        if (!existsSync(paths.python)) await command(paths.uv, ['--no-config', 'venv', '--python', python, ...(python === pythonVersion ? ['--managed-python'] : []), paths.venv], 'python', 'Creating the isolated Kokoro environment.');
        await command(paths.uv, ['--no-config', 'pip', 'install', '--python', paths.python, '--index-url', 'https://download.pytorch.org/whl/cpu', 'torch==2.8.0'], 'kokoro', 'Installing CPU speech dependencies.');
        await command(paths.uv, ['--no-config', 'pip', 'install', '--python', paths.python, '--index-url', 'https://pypi.org/simple', '--only-binary', ':all:', '--no-binary', 'docopt', 'docopt==0.6.2', '-r', requirements, englishModel], 'kokoro', 'Installing Kokoro and its English language model.');
        await command(paths.python, ['-I', '-c', 'import kokoro, soundfile, en_core_web_sm, torch; assert torch.__version__.startswith("2.8.0")'], 'kokoro', 'Checking installed speech dependencies.');
        const stat = statSync(paths.python);
        writeJson(path.join(paths.venv, 'complete.json'), { version: receiptVersion, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      applyPaths();
      writeJson(completionFile, { version: 1, pathInputs, paths: Object.fromEntries(ASSETS.map(asset => [asset.id, paths[asset.id]])) });
    }),
    async activate({ signal }) {
      if (active) return;
      await closeLocalVoice();
      applyPaths();
      let runtime = 'llama.cpp';
      try {
        const ensureLLM = activateLLM || (await import('../scripts/start.mjs')).ensureLocalLLM;
        const result = await ensureLLM({ env, signal, privatePort: env.SUPERVISOR_DESKTOP === '1' || !env.LOCAL_LLM_URL, cwd: paths.home, requireWarm: true });
        llama = result.llama;
        const child = llama;
        let exited = false;
        child?.once('exit', () => {
          exited = true;
          if (llama !== child) return;
          active = false;
          if (!closing) setup.invalidate('The local language runtime stopped. Retry setup to restart it; completed downloads will be reused.');
        });
        const checkRuntime = () => {
          if (exited || (child && (child.exitCode !== null || child.signalCode !== null))) {
            runtime = 'llama.cpp';
            throw new Error('Local language runtime stopped');
          }
        };
        checkRuntime();
        runtime = 'Moonshine / Kokoro';
        if (!localConfiguration(env).configured || !await warm(env)) throw new Error('Speech not configured');
        signal.throwIfAborted();
        checkRuntime();
        active = true;
      } catch (error) {
        if (error.message.includes('Kokoro')) runtime = 'Kokoro';
        else if (error.message.includes('CrispASR')) runtime = 'CrispASR';
        active = false;
        const failedChild = llama;
        llama = null;
        failedChild?.kill();
        await closeLocalVoice();
        throw setupError(`${runtime} did not pass startup checks. Check available memory, Windows runtime requirements and security software, then retry. If Kokoro dependencies are damaged, close the app and remove only runtimes/kokoro-venv from the cache before retrying. Completed models are retained.`);
      }
    },
  });
  return {
    ...setup,
    resume() { if (saved?.version === 1 && inspect().every(component => component.ready)) setup.resume(); },
    async close() { closing = true; await setup.close(); llama?.kill(); await closeLocalVoice(); },
  };
}