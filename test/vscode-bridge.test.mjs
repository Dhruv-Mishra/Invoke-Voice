import test from 'node:test';
import assert from 'node:assert/strict';
import { copilotPrompt, sessionEventText, sessionLaunch, worktreeWindowArgs } from '../src/vscode-bridge.mjs';

test('extracts final text from Copilot and Agency completion events', () => {
  assert.equal(sessionEventText({ type: 'assistant.message', data: { content: 'Copilot done' } }), 'Copilot done');
  assert.equal(sessionEventText({ type: 'session.task_complete', data: { summary: 'Agency done' } }), 'Agency done');
  assert.equal(sessionEventText({ type: 'assistant.turn_end', data: {} }), '');
});

test('Copilot prompt includes area instructions and worktrees open separately', () => {
  const prompt = copilotPrompt(
    { objective: 'Fix settings', worktree: 'C:\\worktree' },
    { allowPublish: false, instructions: 'Use the existing API contract.' },
  );
  assert.match(prompt, /Fix settings/);
  assert.match(prompt, /Work area instructions:\nUse the existing API contract\./);
  assert.deepEqual(worktreeWindowArgs('C:\\worktree'), ['--new-window', 'C:\\worktree']);
});

test('builds explicit Copilot and Agency start and resume commands', () => {
  const base = { dataDir: 'C:\\data', worktree: 'C:\\worktree', model: 'gpt-5.6-sol', context: 'default', sessionId: '11111111-1111-4111-8111-111111111111', agent: 'builder' };
  const area = { allowPublish: false, instructions: '' };
  const copilot = sessionLaunch({ ...base, backend: 'copilot' }, area, { COPILOT_CLI: 'copilot-test', COPILOT_REASONING: 'low' });
  assert.equal(copilot.executable, 'copilot-test');
  assert.deepEqual(copilot.args.slice(-4), ['--session-id', base.sessionId, '--agent', 'builder']);
  const agency = sessionLaunch({ ...base, backend: 'agency' }, area, { AGENCY_CLI: 'agency-test' }, { resume: true });
  assert.equal(agency.executable, 'agency-test');
  assert.deepEqual(agency.args.slice(0, 3), ['copilot', '--hub', '--no-default-mcps']);
  assert.ok(agency.args.includes(`--resume=${base.sessionId}`));
  assert.equal(agency.args.includes('--session-id'), false);
});