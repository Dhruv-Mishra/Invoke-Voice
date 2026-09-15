import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const reporter = fileURLToPath(new URL('./hook.mjs', import.meta.url));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const powershellQuote = value => `'${value.replaceAll("'", "''")}'`;

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
  const node = env.NODE_BIN || (process.versions.electron ? 'node' : process.execPath);
  let handoff = Promise.resolve();
  const git = (cwd, args) => execute('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  async function code(cwd, args) {
    if (process.platform !== 'win32') return execute(env.VSCODE_CLI || 'code', args, { cwd, timeout: 20000 });
    const { executable, cli } = resolveVSCodeInstallation(env);
    return execute(executable, [cli, ...args], { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  }
  return {
    async verifyRepo(repoPath) {
      const { stdout } = await git(repoPath, ['rev-parse', '--show-toplevel']);
      if (realpathSync(stdout.trim()).toLowerCase() !== realpathSync(repoPath).toLowerCase()) throw new Error('Register the Git repository root, not a subfolder');
    },
    async prepare(task, area) {
      const worktree = path.join(dataDir, 'worktrees', task.id);
      const branch = `voice/${task.id.slice(0, 8)}`;
      mkdirSync(path.dirname(worktree), { recursive: true });
      await git(area.repoPath, ['worktree', 'add', '-b', branch, worktree, area.baseRef]);
      const hookFolder = path.join(worktree, '.github', 'hooks');
      mkdirSync(hookFolder, { recursive: true });
      const commandArgs = [node, reporter, dataDir, task.id];
      const hook = { type: 'command', command: commandArgs.map(shellQuote).join(' '), windows: `& ${commandArgs.map(powershellQuote).join(' ')}`, timeout: 5 };
      const hooks = Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map(event => [event, [hook]]));
      writeFileSync(path.join(hookFolder, `voice-supervisor-${task.id}.json`), JSON.stringify({ hooks }, null, 2));
      const { stdout } = await git(worktree, ['rev-parse', '--git-path', 'info/exclude']);
      const exclude = path.resolve(worktree, stdout.trim());
      const rule = '/.github/hooks/voice-supervisor-*.json';
      mkdirSync(path.dirname(exclude), { recursive: true });
      if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').includes(rule)) appendFileSync(exclude, `\n${rule}\n`);
      return { worktree: realpathSync(worktree), branch };
    },
    async dispatch(task, area) {
      const report = [node, reporter, dataDir, task.id, 'report'].map(process.platform === 'win32' ? powershellQuote : shellQuote).join(' ');
      const prompt = `[voice-task:${task.id}]\n${task.objective}\n\nWork in this worktree: ${task.worktree}. Follow its existing instructions and tools. Keep changes scoped; run relevant short checks. ${area.allowPublish ? 'You may commit, push and create a draft PR for this task.' : 'Do not commit, push, or create a PR; leave local changes for review.'} Never merge, deploy, manage work items, send external messages, or change unrelated repos. Do not edit or commit the voice-supervisor hook. When blocked or finished, report a concise factual summary including validation limits and PR link if any by running ${process.platform === 'win32' ? '& ' : ''}${report} needs_input|result_ready '<summary>' (choose one status, no literal pipe). Reporting is best effort; failure must not stop your coding work.`;
      const launch = handoff.then(async () => {
        await code(task.worktree, ['--new-window', task.worktree]);
        await code(task.worktree, ['chat', '--reuse-window', '--mode', area.agent, prompt]);
      });
      handoff = launch.catch(() => {});
      await launch;
    },
    open(worktree) { return code(worktree, ['--reuse-window', worktree]); },
  };
}