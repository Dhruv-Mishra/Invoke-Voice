import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const [dataDir, taskId, mode, status, ...summary] = process.argv.slice(2);
try {
  if (!dataDir || !/^[a-f0-9-]{36}$/.test(taskId || '')) throw new Error('Invalid reporter arguments');
  const inbox = path.join(dataDir, 'inbox');
  const bindingDir = path.join(dataDir, 'bindings');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(bindingDir, { recursive: true });
  const bindingFile = path.join(bindingDir, `${taskId}.json`);
  let event;
  if (mode === 'report') {
    if (!['needs_input', 'result_ready'].includes(status)) throw new Error('Invalid report state');
    const binding = JSON.parse(readFileSync(bindingFile, 'utf8'));
    event = { ...binding, kind: status, summary: summary.join(' ').slice(0, 1800), source: 'worker-report (unverified claim)' };
  } else {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error('Hook payload too large');
    }
    const hook = JSON.parse(input);
    event = { cwd: hook.cwd, sessionId: hook.session_id, kind: hook.hook_event_name, prompt: hook.prompt, summary: [hook.hook_event_name, hook.tool_name, hook.tool_input?.explanation || hook.tool_input?.description || hook.tool_input?.filePath].filter(Boolean).join(': ').slice(0, 1800) };
    if (event.kind === 'UserPromptSubmit' && event.prompt?.includes(`[voice-task:${taskId}]`) && event.sessionId) writeFileSync(bindingFile, JSON.stringify({ cwd: event.cwd, sessionId: event.sessionId }));
  }
  const id = randomUUID();
  const file = path.join(inbox, `${Date.now()}-${id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...event, id, taskId }));
  renameSync(`${file}.tmp`, file);
} catch {
  process.exitCode = 0;
}