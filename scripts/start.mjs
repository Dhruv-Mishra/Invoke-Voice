import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceInstructions } from '../src/llm.mjs';

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
  const modelPath = path.resolve(root, process.env.LOCAL_LLM_PATH || '../LocalVoiceStack/LLMs/Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf');
  const serverUrl = new URL(process.env.LOCAL_LLM_URL || 'http://127.0.0.1:8081/v1');
  const executable = process.env.LLAMA_SERVER_BIN || 'llama-server';
  const threads = process.env.LLAMA_THREADS || String(Math.max(1, Math.min(12, os.availableParallelism() - 4)));
  const contextSize = process.env.LLAMA_CONTEXT || '8192';
  const parallel = process.env.LLAMA_PARALLEL || '2';
  const checkOnly = Boolean(options.checkOnly);

  if (!existsSync(modelPath)) throw new Error(`Ling model not found: ${modelPath}`);
  if (!['127.0.0.1', 'localhost'].includes(serverUrl.hostname)) throw new Error('LOCAL_LLM_URL must use loopback');

  async function healthy() {
    try {
      const response = await fetch(`${serverUrl.origin}/health`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  let llama = null;
  if (!await healthy()) {
    llama = spawn(executable, [
      '-m', modelPath,
      '--host', serverUrl.hostname,
      '--port', serverUrl.port || '8081',
      '--alias', process.env.LOCAL_LLM_MODEL || 'ling-local',
      '--ctx-size', contextSize,
      '--batch-size', '256',
      '--ubatch-size', '256',
      '--threads', threads,
      '--threads-batch', threads,
      '--parallel', parallel,
      '--flash-attn', 'auto',
      '--load-mode', process.env.LLAMA_LOAD_MODE || 'mmap',
      '--cache-reuse', process.env.LLAMA_CACHE_REUSE || '32',
      '--reasoning', 'off',
      '--no-reasoning-preserve',
      '--cors-origins', 'localhost',
      '--jinja',
      '--no-ui',
    ], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });

    llama.once('error', error => {
      console.error(`Could not start llama-server: ${error.message}`);
      process.exitCode = 1;
    });

    for (let attempt = 0; attempt < 180 && !await healthy(); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (llama.exitCode !== null) throw new Error(`llama-server exited with code ${llama.exitCode}`);
    }
    if (!await healthy()) throw new Error('llama-server did not become healthy within 3 minutes');
  } else {
    console.log(`Using existing llama.cpp server at ${serverUrl.origin}`);
  }

  async function warmVoiceLane() {
    try {
      const response = await fetch(`${serverUrl.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.LOCAL_LLM_MODEL || 'ling-local',
          messages: [{ role: 'system', content: voiceInstructions }, { role: 'user', content: 'Say hello.' }],
          chat_template_kwargs: { enable_thinking: false },
          cache_prompt: true,
          max_tokens: 1,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.text();
      console.log('Fast voice LLM lane is warm.');
    } catch (error) {
      console.warn(`Fast voice LLM warmup deferred: ${error.message}`);
    }
  }

  if (checkOnly) {
    try {
      const response = await fetch(`${serverUrl.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.LOCAL_LLM_MODEL || 'ling-local',
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
      return { llama, text, checked: true };
    } finally {
      llama?.kill();
    }
  }

  void warmVoiceLane();
  return { llama, checked: false };
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

  if (config.isLocal) {
    const localResult = await ensureLocalLLM({ checkOnly: config.isCheck });
    if (config.isCheck) {
      return { checked: true, text: localResult.text };
    }
    llamaProcess = localResult.llama;
  }

  if (config.mode === 'release') {
    await ensureFrontendBuild({ forceBuild: config.forceBuild });
  }

  const { startSupervisor } = await import('../src/server.mjs');
  const supervisorInstance = await startSupervisor({
    mode: config.mode,
    port: config.port,
    dataDir: config.dataDir,
    prewarm: config.prewarm,
  });

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
    if (llamaProcess && !llamaProcess.killed) {
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
