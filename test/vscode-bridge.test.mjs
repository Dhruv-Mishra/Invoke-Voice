import test from 'node:test';
import assert from 'node:assert/strict';
import { copilotPrompt, worktreeWindowArgs } from '../src/vscode-bridge.mjs';

test('Copilot prompt includes area instructions and worktrees open separately', () => {
  const prompt = copilotPrompt(
    { objective: 'Fix settings', worktree: 'C:\\worktree' },
    { allowPublish: false, instructions: 'Use the existing API contract.' },
  );
  assert.match(prompt, /Fix settings/);
  assert.match(prompt, /Work area instructions:\nUse the existing API contract\./);
  assert.deepEqual(worktreeWindowArgs('C:\\worktree'), ['--new-window', 'C:\\worktree']);
});