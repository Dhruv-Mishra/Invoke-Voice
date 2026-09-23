import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localInstructions, localRequestBody, voiceInstructionsFor } from '../src/llm.mjs';
import { llamaThreadDefault, qwenThreadDefaults } from '../src/runtime-config.mjs';
import { voiceToolsFor } from '../src/supervisor/contract.mjs';
import net from 'node:net';
import { localLlmProfile, qwenMtpEnabled, stackPaths } from './models.mjs';
import { qwenMtpReady } from './qwen-mtp.mjs';
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

export function localLlmArguments(paths, serverUrl, env = process.env) {
  if (localLlmProfile(env) === 'qwen') return qwenLlmArguments(paths, serverUrl, env);
  const threads = env.LLAMA_THREADS || llamaThreadDefault();
  return [
    '-m', paths.ling,
    '--host', serverUrl.hostname,
    '--port', serverUrl.port || '8081',
    '--alias', env.LOCAL_LLM_MODEL || 'ling-local',
    '--ctx-size', env.LLAMA_CONTEXT || '4096',
    '--no-context-shift',
    '--batch-size', env.LLAMA_BATCH_SIZE || '256',
    '--ubatch-size', env.LLAMA_UBATCH_SIZE || '256',
    '--threads', threads,
    '--threads-batch', env.LLAMA_THREADS_BATCH || threads,
    '--parallel', env.LLAMA_PARALLEL || '1',
    '--gpu-layers', env.LLAMA_GPU_LAYERS || 'auto',
    '--flash-attn', env.LLAMA_FLASH_ATTN || 'auto',
    '--cache-type-k', env.LLAMA_CACHE_TYPE_K || 'f16',
    '--cache-type-v', env.LLAMA_CACHE_TYPE_V || 'f16',
    '--load-mode', env.LLAMA_LOAD_MODE || 'auto',
    '--cache-reuse', env.LLAMA_CACHE_REUSE || '32',
    '--reasoning', 'off',
    '--reasoning-budget', env.LLAMA_REASONING_BUDGET || '256',
    '--no-reasoning-preserve',
    '--cors-origins', 'localhost',
    '--jinja',
    '--no-ui',
  ];
}

// Measured on CPU: threads-batch also drives MTP verification batches, so it stays near physical cores; no-mmap avoids a second resident copy of repacked MoE weights.
function qwenLlmArguments(paths, serverUrl, env) {
  const defaults = qwenThreadDefaults();
  const mtp = qwenMtpEnabled(env) && qwenMtpReady(paths);
  return [
    '-m', mtp ? paths.lingMtp : paths.ling,
    '--host', serverUrl.hostname,
    '--port', serverUrl.port || '8081',
    '--alias', env.LOCAL_LLM_MODEL || 'ling-local',
    '--ctx-size', env.QWEN_CONTEXT || '8192',
    '--no-context-shift',
    '--parallel', '1',
    '--batch-size', '1024',
    '--ubatch-size', '1024',
    '--threads', env.QWEN_THREADS || defaults.decode,
    '--threads-batch', env.QWEN_THREADS_BATCH || defaults.batch,
    '--gpu-layers', env.LLAMA_GPU_LAYERS || 'auto',
    '--flash-attn', 'on',
    '--load-mode', 'none',
    '--cache-ram', '4096',
    '--reasoning', 'off',
    '--reasoning-budget', '0',
    '--no-reasoning-preserve',
    '--cors-origins', 'localhost',
    '--jinja',
    '--no-ui',
    ...(mtp ? ['--spec-type', 'draft-mtp', '--spec-draft-n-max', env.QWEN_DRAFT_TOKENS || '2'] : []),
  ];
}

export async function ensureLocalLLM(options = {}) {
  const env = options.env || process.env;
  const paths = stackPaths(env);
  const modelPath = paths.ling;
  const qwen = localLlmProfile(env) === 'qwen';
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
  const checkOnly = Boolean(options.checkOnly);

  if (!existsSync(modelPath)) throw new Error(`Local model not found: ${modelPath}`);
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
    llama = spawn(executable, localLlmArguments(paths, serverUrl, env), { cwd: options.cwd || root, env, stdio: 'inherit', windowsHide: true });
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
      const tools = voiceToolsFor(env);
      const response = await fetch(`${serverUrl.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localRequestBody({
          model: env.LOCAL_LLM_MODEL || 'ling-local',
          messages: [{ role: 'system', content: localInstructions(voiceInstructionsFor(env), tools, env) }, { role: 'user', content: 'Say hello.' }],
          max_tokens: 1,
        }, tools, false, undefined, env)),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(qwen ? 120000 : 30000)]) : AbortSignal.timeout(qwen ? 120000 : 30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const choice = result.choices?.[0];
      if (choice?.message?.role !== 'assistant' || !['stop', 'length', 'tool_calls'].includes(choice.finish_reason) ||
          !(typeof choice.message.content === 'string' || choice.message.content === null || Array.isArray(choice.message.tool_calls))) {
        throw new Error('Local model warm-up returned an invalid completion');
      }
      if (!await healthy()) throw new Error('Local model became unhealthy after warm-up');
      console.log('Local voice LLM prefix is warm.');
      return String(choice.message.content || '').trim();
    } catch (error) {
      if (options.requireWarm || checkOnly) throw error;
      console.warn(`Local voice LLM warmup deferred: ${error.message}`);
    }
  }

  if (checkOnly) {
    try {
      const text = await warmVoiceLane();
      console.log('Local LLM check: healthy with a valid completion.');
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
    console.log('Shutting down Invoke...');
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
