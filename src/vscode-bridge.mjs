import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const execute = promisify(execFile);

export function resolveVSCodeInstallation(env = process.env) {
  const roots = [env.VSCODE_PATH, path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'), path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code')].filter(Boolean);
  for (const root of roots) {
    const executable = path.join(root, 'Code.exe');
    if (!existsSync(executable)) continue;
    let cli = path.join(root, 'resources', 'app', 'out', 'cli.js');
    const launcher = path.join(root, 'bin', 'code.cmd');
    if (!existsSync(cli) && existsSync(launcher)) {
      const relative = readFileSync(launcher, 'utf8').match(/"%~dp0([^"\r\n]*resources\\app\\out\\cli\.js)"/i)?.[1];
      if (relative) cli = path.resolve(root, 'bin', relative);
    }
    if (existsSync(cli)) return { executable, cli };
  }
  throw new Error('VS Code not found. Set VSCODE_PATH to its installation directory.');
}

export function createVSCodeBridge(dataDir, env = process.env) {
  let handoff = Promise.resolve();
  const git = (cwd, args) => execute('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  async function code(cwd, args) {
    if (process.platform !== 'win32') return execute(env.VSCODE_CLI || 'code', args, { cwd, timeout: 20000 });
    const { executable, cli } = resolveVSCodeInstallation(env);
    return execute(executable, [cli, ...args], { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  }
  function runCopilot(task, area, report) {
    const logDir = path.join(dataDir, 'copilot', 'logs');
    const sessionDir = path.join(dataDir, 'copilot', 'sessions');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const sessionLog = path.join(sessionDir, `${task.id}.jsonl`);
    const prompt = `Task: ${task.objective}\n\nWork only in ${task.worktree}. Keep changes scoped and run focused checks. ${area.allowPublish ? 'You may commit, push, and create a draft PR.' : 'Do not commit, push, or create a PR.'} Never merge, deploy, manage work items, or send messages. Finish with a concise result and validation.`;
    const args = [
      '-C', task.worktree,
      '--add-dir', task.worktree,
      '--log-dir', logDir,
      '--no-auto-update',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--no-remote',
      '--no-remote-export',
      '--no-ask-user',
      '--allow-all-tools',
      '--output-format', 'json',
      '--stream', 'on',
      '--model', task.model,
      '--reasoning-effort', env.COPILOT_REASONING || 'medium',
      '--context', task.context,
      '--session-id', task.sessionId,
      '-p', prompt,
    ];
    const executable = env.COPILOT_CLI || (process.platform === 'win32' ? 'copilot.exe' : 'copilot');
    const child = spawn(executable, args, { cwd: task.worktree, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createInterface({ input: child.stdout });
    let diagnostic = '';
    let finalText = '';
    let result;
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    output.on('line', line => {
      appendFileSync(sessionLog, `${line}\n`);
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'assistant.message' && typeof event.data?.content === 'string') finalText = event.data.content.trim();
      if (event.type === 'result') result = event;
      const toolName = event.data?.toolName || event.data?.name || event.data?.tool?.name;
      const toolOutput = event.data?.output || event.data?.content || event.data?.result;
      if (event.type === 'assistant.turn_start') report({ kind: 'progress', summary: 'Copilot started working.' });
      if (event.type === 'tool.execution_start') report({ kind: 'progress', summary: `Running ${String(toolName || 'tool').slice(0, 120)}.` });
      if (['tool.execution_partial_result', 'tool.execution_complete'].includes(event.type) && toolOutput) {
        const summary = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
        report({ kind: 'progress', summary: summary.slice(-600) });
      }
      if (event.type === 'assistant.message' && finalText) report({ kind: 'progress', summary: finalText.slice(0, 600) });
    });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        output.close();
        if (!result) return reject(new Error(`Copilot CLI ended without a result (${signal || (code ?? 'unknown')}). ${diagnostic}`.trim()));
        if (result.exitCode !== 0 || code !== 0) return reject(new Error(`Copilot CLI failed (${result.exitCode ?? code}). ${diagnostic}`.trim()));
        resolve({ sessionLog, result: finalText || 'Copilot CLI completed.', usage: result.usage });
      });
    });
  }
  return {
    async verifyRepo(repoPath) {
      const { stdout } = await git(repoPath, ['rev-parse', '--show-prefix']);
      if (stdout.trim()) throw new Error('Register the Git repository root, not a subfolder');
    },
    async prepare(task, area) {
      const worktree = path.join(dataDir, 'worktrees', task.id);
      const branch = `voice/${task.id.slice(0, 8)}`;
      mkdirSync(path.dirname(worktree), { recursive: true });
      await git(area.repoPath, ['worktree', 'add', '-b', branch, worktree, area.baseRef]);
      return { worktree: realpathSync(worktree), branch };
    },
    dispatch(task, area, report) {
      return runCopilot(task, area, report);
    },
    async invokeVSCode({ prompt, model, context, directory, requestId }) {
      const folder = path.join(dataDir, 'vscode-requests');
      mkdirSync(folder, { recursive: true });
      const safeId = requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
      const note = path.join(folder, `${safeId || Date.now()}.txt`);
      if (!existsSync(note)) writeFileSync(note, `VSCode session invoked\n\nPrompt: ${prompt}\nModel: ${model}\nContext: ${context}\nDirectory: ${directory}\n`);
      const launch = handoff.then(() => code(directory, ['--reuse-window', note]));
      handoff = launch.catch(() => {});
      await launch;
      return { invoked: true, note, model, context, directory };
    },
    open(worktree) { return code(worktree, ['--reuse-window', worktree]); },
  };
}