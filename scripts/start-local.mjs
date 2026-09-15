import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const modelPath = path.resolve(root, process.env.LOCAL_LLM_PATH || '../LocalVoiceStack/LLMs/Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf');
const serverUrl = new URL(process.env.LOCAL_LLM_URL || 'http://127.0.0.1:8081/v1');
const executable = process.env.LLAMA_SERVER_BIN || 'llama-server';
const threads = process.env.LLAMA_THREADS || String(Math.max(1, Math.min(12, os.availableParallelism() - 4)));
const contextSize = process.env.LLAMA_CONTEXT || '8192';
const checkOnly = process.argv.includes('--check');

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

let llama;
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
    '--parallel', '1',
    '--flash-attn', 'auto',
    '--load-mode', process.env.LLAMA_LOAD_MODE || 'mmap',
    '--cache-reuse', process.env.LLAMA_CACHE_REUSE || '256',
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
  } finally {
    llama?.kill();
  }
} else {
const supervisor = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
const shutdown = () => {
  supervisor.kill();
  llama?.kill();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
supervisor.once('exit', code => {
  llama?.kill();
  process.exitCode = code ?? 1;
});
}