import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceInstructions } from '../src/llm.mjs';
import net from 'node:net';
import { stackPaths } from './models.mjs';
import desktopLaunch from './desktop-launch.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function parseStartupArgs(argv = process.argv.slice(2), env = process.env) {
  const args = argv.map(a => String(a).toLowerCase());

  // Debug flags: -debug, --debug, debug, -d, or environment flags
  const hasDebugArg = args.some(a => a === '-debug' || a === '--debug' || a === 'debug' || a === '-d');
  const hasDebugEnv = env.npm_config_debug === 'true' ||
    env.npm_config_debug === '1' ||
    env.DEBUG === '1' ||
    env.SUPERVISOR_DEBUG === '1' ||
    env.SUPERVISOR_MODE === 'debug' ||
    (env.NODE_ENV === 'development' && env.SUPERVISOR_MODE !== 'release');
  const isDebug = hasDebugArg || hasDebugEnv;

  // Release flags: -release, --release, release, -r, or environment flags
  const hasReleaseArg = args.some(a => a === '-release' || a === '--release' || a === 'release' || a === '-r');
  const hasReleaseEnv = env.npm_config_release === 'true' || env.SUPERVISOR_MODE === 'release';
  const isRelease = hasReleaseArg || hasReleaseEnv;

  // Local flags: -local, --local, local, -l, or environment flags
  const hasLocalArg = args.some(a => a === '-local' || a === '--local' || a === 'local' || a === '-l');
  const hasLocalEnv = env.npm_config_local === 'true' || env.SUPERVISOR_LOCAL === '1';
  const isLocal = hasLocalArg || hasLocalEnv;

  // Check flag: -check, --check, check, or environment flags
  const hasCheckArg = args.some(a => a === '-check' || a === '--check' || a === 'check');
  const hasCheckEnv = env.npm_config_check === 'true';
  const isCheck = hasCheckArg || hasCheckEnv;

  // Force build flag in release mode
  const hasBuildArg = args.some(a => a === '-build' || a === '--build' || a === 'build');
  const hasBuildEnv = env.npm_config_build === 'true';
  const forceBuild = hasBuildArg || hasBuildEnv;

  // Port flag: --port <num>, -port <num>, -p <num>, --port=<num>, or env.PORT
  let port = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].toLowerCase();
    if ((a === '--port' || a === '-port' || a === '-p') && i + 1 < argv.length) {
      const p = Number(argv[i + 1]);
      if (!Number.isNaN(p) && p >= 0) port = p;
    } else if (a.startsWith('--port=') || a.startsWith('-port=')) {
      const p = Number(a.split('=')[1]);
      if (!Number.isNaN(p) && p >= 0) port = p;
    }
  }
  if (port === null && env.PORT) {
    const p = Number(env.PORT);
    if (!Number.isNaN(p) && p >= 0) port = p;
  }
  if (port === null) port = 4317;

  // Resolve final mode: explicit release takes precedence if both specified; otherwise debug if set, else release
  let mode = 'release';
  if (isDebug && !hasReleaseArg) {
    mode = 'debug';
  } else if (isRelease) {
    mode = 'release';
  }

  return {
    mode,
    isDebug: mode === 'debug',
    isRelease: mode === 'release',
    isLocal,
    isCheck,
    forceBuild,
    port,
  };
}

export async function ensureFrontendBuild(options = {}) {
  console.log('Building frontend production assets for release...');
  const { build } = await import('vite');
  await build({
    configFile: path.join(root, 'vite.config.js'),
    logLevel: 'warn',
  });
  console.log('Frontend build completed.');
  return true;
}

export async function ensureLocalLLM(options = {}) {
  const env = options.env || process.env;
  const paths = stackPaths(env);
  const modelPath = paths.ling;
  const initialUrl = env.LOCAL_LLM_URL;
  let allocatedPort = null;
  if (options.privatePort) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    allocatedPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
  }
  const candidateUrl = allocatedPort ? `http://127.0.0.1:${allocatedPort}/v1` : (env.LOCAL_LLM_URL || 'http://127.0.0.1:8081/v1');
  const serverUrl = new URL(candidateUrl);
  const executable = existsSync(paths.llama) ? paths.llama : env.LLAMA_SERVER_BIN || 'llama-server';
  const threads = env.LLAMA_THREADS || String(Math.max(1, Math.min(12, os.availableParallelism() - 4)));
  const contextSize = env.LLAMA_CONTEXT || '8192';
  const parallel = env.LLAMA_PARALLEL || '2';
  const checkOnly = Boolean(options.checkOnly);

  if (!existsSync(modelPath)) throw new Error(`Ling model not found: ${modelPath}`);
  if (serverUrl.protocol !== 'http:' || serverUrl.username || serverUrl.password || !['127.0.0.1', 'localhost'].includes(serverUrl.hostname)) throw new Error('LOCAL_LLM_URL must use HTTP loopback without credentials');

  async function healthy() {
    try {
      const response = await fetch(`${serverUrl.origin}/health`, { signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  let llama = null;
  let owned = false;
  if (!await healthy()) {
    owned = true;
    llama = spawn(executable, [
      '-m', modelPath,
      '--host', serverUrl.hostname,
      '--port', serverUrl.port || '8081',
      '--alias', env.LOCAL_LLM_MODEL || 'ling-local',
      '--ctx-size', contextSize,
      '--batch-size', '256',
      '--ubatch-size', '256',
      '--threads', threads,
      '--threads-batch', threads,
      '--parallel', parallel,
      '--flash-attn', 'auto',
      '--load-mode', env.LLAMA_LOAD_MODE || 'mmap',
      '--cache-reuse', env.LLAMA_CACHE_REUSE || '32',
      '--reasoning', 'off',
      '--no-reasoning-preserve',
      '--cors-origins', 'localhost',
      '--jinja',
      '--no-ui',
    ], { cwd: options.cwd || root, env, stdio: 'inherit', windowsHide: true });
    desktopLaunch.trackChild(llama);

    let spawnError;
    llama.once('error', error => { spawnError = error; });

    try {
      for (let attempt = 0; attempt < 180 && !await healthy(); attempt += 1) {
        options.signal?.throwIfAborted();
        if (spawnError) throw spawnError;
        if (llama.exitCode !== null || llama.signalCode !== null) throw new Error(`llama-server exited with code ${llama.exitCode}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      options.signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      if (!await healthy()) throw new Error('llama-server did not become healthy within 3 minutes');
    } catch (error) {
      llama.kill();
      if (owned) {
        if (initialUrl !== undefined) env.LOCAL_LLM_URL = initialUrl;
        else delete env.LOCAL_LLM_URL;
      }
      throw error;
    }
  } else {
    console.log(`Using existing llama.cpp server at ${serverUrl.origin}`);
  }

  env.LOCAL_LLM_URL = serverUrl.href;

  async function warmVoiceLane() {
    try {
      const response = await fetch(`${serverUrl.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.LOCAL_LLM_MODEL || 'ling-local',
          messages: [{ role: 'system', content: voiceInstructions }, { role: 'user', content: 'Say hello.' }],
          chat_template_kwargs: { enable_thinking: false },
          cache_prompt: true,
          max_tokens: 1,
          temperature: 0,
        }),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!String(result.choices?.[0]?.message?.content || '').trim()) throw new Error('Ling warm-up returned no text');
      console.log('Fast voice LLM lane is warm.');
    } catch (error) {
      if (options.requireWarm) throw error;
      console.warn(`Fast voice LLM warmup deferred: ${error.message}`);
    }
  }

  if (checkOnly) {
    try {
      const response = await fetch(`${serverUrl.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.LOCAL_LLM_MODEL || 'ling-local',
          messages: [{ role: 'user', content: 'Reply with only READY.' }],
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: 16,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`Ling request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
      const result = await response.json();
      const text = String(result.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('Ling returned no text');
      console.log(`Local Ling check: ${text}`);
      return { llama, text, checked: true, url: serverUrl.href };
    } finally {
      llama?.kill();
      if (owned) {
        if (initialUrl !== undefined) env.LOCAL_LLM_URL = initialUrl;
        else delete env.LOCAL_LLM_URL;
      }
    }
  }

  if (options.requireWarm) {
    try { await warmVoiceLane(); } catch (error) {
      if (owned) {
        llama?.kill();
        if (initialUrl !== undefined) env.LOCAL_LLM_URL = initialUrl;
        else delete env.LOCAL_LLM_URL;
      }
      throw error;
    }
  } else void warmVoiceLane();
  return { llama, checked: false, owned, url: serverUrl.href };
}

export async function start(options = {}) {
  const parsed = parseStartupArgs(process.argv.slice(2), process.env);
  let mode = options.mode || (options.debug ? 'debug' : (options.release ? 'release' : parsed.mode));
  const config = {
    ...parsed,
    ...options,
    mode,
    isDebug: mode === 'debug',
    isRelease: mode === 'release',
  };

  let llamaProcess = null;
  let llamaProcessOwned = false;

  if (config.isLocal) {
    const localResult = await ensureLocalLLM({ checkOnly: config.isCheck });
    if (config.isCheck) {
      return { checked: true, text: localResult.text };
    }
    llamaProcess = localResult.llama;
    llamaProcessOwned = localResult.owned === true;
  }

  let supervisorInstance;
  try {
    if (config.mode === 'release') {
      await ensureFrontendBuild({ forceBuild: config.forceBuild });
    }

    const { startSupervisor } = await import('../src/server.mjs');
    supervisorInstance = await startSupervisor({
      mode: config.mode,
      port: config.port,
      dataDir: config.dataDir,
      prewarm: config.prewarm,
    });
  } catch (error) {
    if (llamaProcessOwned && llamaProcess && !llamaProcess.killed) llamaProcess.kill();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down Voice Supervisor...');
    try {
      await supervisorInstance.close();
    } catch (error) {
      console.error(`Error closing supervisor: ${error.message}`);
    }
    if (llamaProcessOwned && llamaProcess && !llamaProcess.killed) {
      try {
        llamaProcess.kill();
      } catch {}
    }
  };

  process.once('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
  process.once('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });

  return {
    instance: supervisorInstance,
    llama: llamaProcess,
    config,
    close: shutdown,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await start();
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
}
