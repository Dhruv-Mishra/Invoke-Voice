#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = 'beta-release.yml';
const releaseBranch = process.env.RELEASE_BRANCH || 'master';
const allowedBumps = new Set(['prerelease', 'prepatch', 'preminor']);

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: capture ? 'pipe' : 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with code ${result.status}`);
  }
  return capture ? result.stdout.trim() : '';
}

function usage() {
  console.log(`Usage: npm run release:beta -- [prerelease|prepatch|preminor]

  prerelease  Increment the current beta (default)
  prepatch    Start the next patch beta
  preminor    Start the next minor beta`);
}

async function main() {
  const bump = process.argv[2] || 'prerelease';
  if (bump === '--help' || bump === '-h') {
    usage();
    return;
  }
  if (!allowedBumps.has(bump)) {
    usage();
    throw new Error(`Unsupported beta bump: ${bump}`);
  }

  const status = run('git', ['status', '--porcelain'], { capture: true });
  if (status) throw new Error('Commit or stash local changes before publishing a beta.');

  const branch = run('git', ['branch', '--show-current'], { capture: true });
  if (!branch) throw new Error('Beta publishing requires a checked-out branch.');
  if (branch !== releaseBranch) throw new Error(`Check out ${releaseBranch} before publishing a beta (current branch: ${branch}).`);

  run('git', ['fetch', 'origin', branch]);
  const divergence = run('git', ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], { capture: true });
  const [ahead, behind] = divergence.split(/\s+/).map(Number);
  if (behind) throw new Error(`Local ${branch} is behind origin/${branch}; pull before publishing.`);

  if (ahead) run('git', ['push', 'origin', `HEAD:${branch}`]);

  const requestId = randomUUID().slice(0, 8);
  run('gh', ['workflow', 'run', workflow, '--ref', branch, '-f', `bump=${bump}`, '-f', `request_id=${requestId}`]);

  let workflowRun;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runs = JSON.parse(run('gh', [
      'run', 'list', '--workflow', workflow, '--event', 'workflow_dispatch', '--branch', branch,
      '--limit', '20', '--json', 'databaseId,displayTitle,url',
    ], { capture: true }));
    workflowRun = runs.find(candidate => candidate.displayTitle.includes(requestId));
    if (workflowRun) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (!workflowRun) throw new Error('GitHub accepted the dispatch, but its workflow run was not found. Check the Actions page.');
  console.log(`Watching ${workflowRun.url}`);
  run('gh', ['run', 'watch', String(workflowRun.databaseId), '--exit-status']);
  console.log('Beta installer published on the repository Releases page.');
}

main().catch(error => {
  console.error(`Beta release failed: ${error.message}`);
  process.exitCode = 1;
});