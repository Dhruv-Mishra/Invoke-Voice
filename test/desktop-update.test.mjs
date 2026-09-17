import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import updater from '../desktop-update.cjs';

const asset = (tag, version, suffix = '') => ({
  name: `Voice Work Supervisor-Setup-${version}.exe${suffix}`,
  browser_download_url: `https://github.com/Dhruv-Mishra/VoiceOrchestration/releases/download/${tag}/Voice%20Work%20Supervisor-Setup-${version}.exe${suffix}`,
});

const release = (version, { prerelease = version.includes('-'), draft = false, complete = true } = {}) => ({
  tag_name: `v${version}`,
  name: `Voice Work Supervisor ${version}`,
  prerelease,
  draft,
  published_at: '2026-09-17T00:00:00Z',
  assets: complete ? [asset(`v${version}`, version), asset(`v${version}`, version, '.sha256')] : [],
});

test('update selection compares prereleases semantically and keeps stable installs on stable releases', () => {
  const releases = [release('0.1.1-beta.10'), release('0.1.1-beta.3'), release('0.1.1'), release('0.2.0-beta.1'), release('9.0.0', { draft: true }), release('1.0.0', { complete: false })];
  assert.equal(updater.selectUpdate(releases, '0.1.1-beta.2').version, '0.2.0-beta.1');
  assert.equal(updater.selectUpdate(releases, '0.1.0').version, '0.1.1');
  assert.equal(updater.selectUpdate(releases, '0.1.1'), null);
});

test('update asset URLs must belong to the selected repository, tag and filename', () => {
  const name = 'Voice Work Supervisor-Setup-0.1.2.exe';
  const valid = `https://github.com/Dhruv-Mishra/VoiceOrchestration/releases/download/v0.1.2/Voice%20Work%20Supervisor-Setup-0.1.2.exe`;
  assert.equal(updater.validateReleaseAssetUrl(valid, 'v0.1.2', name), valid);
  for (const value of [
    'https://github.com/evil/VoiceOrchestration/releases/download/v0.1.2/Voice%20Work%20Supervisor-Setup-0.1.2.exe',
    'https://github.com/Dhruv-Mishra/VoiceOrchestration/releases/download/v9.0.0/Voice%20Work%20Supervisor-Setup-0.1.2.exe',
    'https://github.com@evil.test/Dhruv-Mishra/VoiceOrchestration/releases/download/v0.1.2/Voice%20Work%20Supervisor-Setup-0.1.2.exe',
  ]) assert.throws(() => updater.validateReleaseAssetUrl(value, 'v0.1.2', name), /release|trusted|match/i);
});

test('downloaded updates require a matching named SHA-256 sidecar', async context => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-update-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const installer = Buffer.from('verified installer fixture');
  const selected = { available: true, currentVersion: '0.1.1-beta.2', ...updater.selectUpdate([release('0.1.1-beta.3')], '0.1.1-beta.2') };
  const checksum = `${createHash('sha256').update(installer).digest('hex')}  ${selected.installer.name}\n`;
  const fetchImpl = async url => {
    const body = url.endsWith('.sha256') ? Buffer.from(checksum) : installer;
    return { ok: true, status: 200, url, headers: new Headers({ 'content-length': String(body.length) }), body: Readable.from([body]), text: async () => body.toString('utf8') };
  };
  const downloaded = await updater.downloadUpdate(selected, directory, { fetchImpl });
  assert.equal(readFileSync(downloaded, 'utf8'), installer.toString('utf8'));

  const badFetch = async url => {
    const body = url.endsWith('.sha256') ? Buffer.from(`${'0'.repeat(64)}  ${selected.installer.name}\n`) : installer;
    return { ok: true, status: 200, url, headers: new Headers(), body: Readable.from([body]), text: async () => body.toString('utf8') };
  };
  await assert.rejects(updater.downloadUpdate(selected, directory, { fetchImpl: badFetch }), /checksum did not match/);
  assert.equal(existsSync(`${downloaded}.part`), false);
});