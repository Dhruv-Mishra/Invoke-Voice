#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseBranch = process.env.RELEASE_BRANCH || 'master';
const allowedBumps = new Set(['prerelease', 'prepatch', 'preminor']);
const npmCli = process.env.npm_execpath;

function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env,
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

function succeeds(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: 'ignore', shell: false }).status === 0;
}

function runNpm(args) {
  if (!npmCli) throw new Error('Run this publisher through npm run release:beta:local.');
  return run(process.execPath, [npmCli, ...args]);
}

function usage() {
  console.log(`Usage: npm run release:beta:local -- [prerelease|prepatch|preminor]

Builds, validates, versions, and publishes the Windows installer from this machine.

  prerelease  Increment the current beta (default)
  prepatch    Start the next patch beta
  preminor    Start the next minor beta`);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
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
  if (branch !== releaseBranch) throw new Error(`Check out ${releaseBranch} before publishing a beta (current branch: ${branch || 'detached'}).`);

  run('gh', ['auth', 'status']);
  run('git', ['fetch', 'origin', branch]);
  const divergence = run('git', ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], { capture: true });
  const [, behind] = divergence.split(/\s+/).map(Number);
  if (behind) throw new Error(`Local ${branch} is behind origin/${branch}; pull before publishing.`);

  let versionChanged = false;
  let versionCommitted = false;
  let pushed = false;
  let tag;
  let installer;
  let packagedExecutable;
  let checksumFile;
  let releaseAssets = [];

  try {
    runNpm(['version', bump, '--preid=beta', '--no-git-tag-version']);
    versionChanged = true;

    const config = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    tag = `v${config.version}`;
    installer = path.join(root, 'release', `${config.build.productName}-Setup-${config.version}.exe`);
    packagedExecutable = path.join(root, 'release', 'win-unpacked', `${config.build.productName}.exe`);
    checksumFile = `${installer}.sha256`;
    if (succeeds('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])) throw new Error(`Tag ${tag} already exists.`);
    if (succeeds('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])) throw new Error(`Tag ${tag} already exists on origin.`);

    runNpm(['test']);
    runNpm(['run', 'dist:win']);
    if (!existsSync(installer)) throw new Error(`Expected installer was not created: ${installer}`);
    if (!existsSync(packagedExecutable)) throw new Error(`Expected packaged executable was not created: ${packagedExecutable}`);
    run(process.execPath, ['--test', 'test/desktop.test.mjs'], {
      env: { ...process.env, SUPERVISOR_PACKAGED_EXE: packagedExecutable },
    });

    const checksum = `${await sha256(installer)}  ${path.basename(installer)}\n`;
    await writeFile(checksumFile, checksum, 'ascii');
    const onlineInstaller = path.join(root, 'release', `${config.build.productName}-Setup-${config.version}-Online.exe`);
    const pack = JSON.parse(readFileSync(path.join(root, 'artifacts', 'voice-pack', 'descriptor.json'), 'utf8'));
    const packFile = path.join(root, 'release', pack.filename);
    if (await sha256(packFile) !== pack.sha256) throw new Error('Release dependency pack checksum mismatch.');
    releaseAssets = [installer, checksumFile];
    for (const asset of [onlineInstaller, packFile]) {
      const sidecar = `${asset}.sha256`;
      await writeFile(sidecar, `${await sha256(asset)}  ${path.basename(asset)}\n`, 'ascii');
      releaseAssets.push(asset, sidecar);
    }

    run('git', ['add', '--', 'package.json', 'package-lock.json']);
    run('git', ['commit', '-m', `chore: release ${tag}`]);
    versionCommitted = true;
    run('git', ['tag', '-a', tag, '-m', `Voice Work Supervisor ${config.version} beta`]);

    run('git', ['push', '--atomic', 'origin', `HEAD:${branch}`, `refs/tags/${tag}`]);
    pushed = true;

    run('gh', [
      'release', 'create', tag, ...releaseAssets, '--verify-tag',
      '--title', `Voice Work Supervisor ${config.version}`, '--generate-notes', '--prerelease', '--latest=false',
    ]);
    const releaseUrl = run('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'], { capture: true });
    console.log(`Published ${releaseUrl}`);
  } catch (error) {
    if (versionChanged && !versionCommitted) run('git', ['restore', '--staged', '--worktree', '--', 'package.json', 'package-lock.json']);
    if (versionCommitted && !pushed) {
      console.error(`Build succeeded and ${tag} was committed locally, but the push failed. Resolve the push issue before publishing another version.`);
    } else if (pushed) {
      const releaseExists = succeeds('gh', ['release', 'view', tag]);
      const assets = releaseAssets.map(asset => `"${asset}"`).join(' ');
      const recovery = releaseExists
        ? `gh release upload ${tag} ${assets} --clobber`
        : `gh release create ${tag} ${assets} --verify-tag --generate-notes --prerelease --latest=false`;
      console.error(`Version ${tag} was pushed, but release upload failed. Recover with: ${recovery}`);
    }
    throw error;
  }
}

main().catch(error => {
  console.error(`Local beta release failed: ${error.message}`);
  process.exitCode = 1;
});