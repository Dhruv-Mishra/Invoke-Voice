const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream, mkdirSync, renameSync, rmSync } = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const semver = require('semver');

const OWNER = 'Dhruv-Mishra';
const REPOSITORY = 'VoiceOrchestration';
const PRODUCT_NAME = 'Voice Work Supervisor';
const RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases?per_page=100`;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function releaseVersion(tag) {
  return semver.valid(typeof tag === 'string' ? tag.replace(/^v/, '') : '');
}

function selectUpdate(releases, currentVersion) {
  const current = semver.valid(currentVersion);
  if (!current) throw new Error('The installed application version is invalid.');
  const acceptsPrereleases = semver.prerelease(current) !== null;
  const candidates = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    const version = releaseVersion(release?.tag_name);
    if (!version || release.draft || !semver.gt(version, current)) continue;
    if (!acceptsPrereleases && (release.prerelease || semver.prerelease(version))) continue;
    const installerName = `${PRODUCT_NAME}-Setup-${version}.exe`;
    const checksumName = `${installerName}.sha256`;
    const installerAsset = release.assets?.find(asset => asset?.name === installerName);
    const checksumAsset = release.assets?.find(asset => asset?.name === checksumName);
    if (!installerAsset?.browser_download_url || !checksumAsset?.browser_download_url) continue;
    candidates.push({
      version,
      tag: release.tag_name,
      prerelease: Boolean(release.prerelease),
      name: release.name || release.tag_name,
      publishedAt: release.published_at || null,
      installer: { name: installerName, url: installerAsset.browser_download_url },
      checksum: { name: checksumName, url: checksumAsset.browser_download_url },
    });
  }
  return candidates.sort((left, right) => semver.rcompare(left.version, right.version))[0] || null;
}

function validateReleaseAssetUrl(value, tag, fileName) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The release contains an invalid download URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) {
    throw new Error('The release download URL is not trusted.');
  }
  let segments;
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new Error('The release contains an invalid download URL.'); }
  if (segments.length !== 6 || segments[0] !== OWNER || segments[1] !== REPOSITORY || segments[2] !== 'releases' || segments[3] !== 'download' || segments[4] !== tag || segments[5] !== fileName) {
    throw new Error('The release download URL does not match the selected version.');
  }
  return url.href;
}

function validateFinalDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The release download redirected to an invalid location.'); }
  if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw new Error('The release download redirected to an untrusted location.');
  }
}

async function fetchReleaseAsset(asset, tag, fetchImpl, signal) {
  const url = validateReleaseAssetUrl(asset.url, tag, asset.name);
  const response = await fetchImpl(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Voice-Work-Supervisor-Updater' }, redirect: 'follow', signal });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${asset.name}.`);
  validateFinalDownloadUrl(response.url || url);
  return response;
}

async function checkForUpdate(currentVersion, { fetchImpl = fetch, signal = AbortSignal.timeout(20000) } = {}) {
  const response = await fetchImpl(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Voice-Work-Supervisor-Updater', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} while checking for updates.`);
  const update = selectUpdate(await response.json(), currentVersion);
  return update ? { available: true, currentVersion, ...update } : { available: false, currentVersion };
}

function publicUpdate(update) {
  if (!update?.available) return { available: false, currentVersion: update?.currentVersion };
  return {
    available: true,
    currentVersion: update.currentVersion,
    latestVersion: update.version,
    name: update.name,
    prerelease: update.prerelease,
    publishedAt: update.publishedAt,
  };
}

async function downloadUpdate(update, directory, { fetchImpl = fetch, signal = AbortSignal.timeout(10 * 60 * 1000) } = {}) {
  if (!update?.available || !update.installer || !update.checksum) throw new Error('No verified update is ready to install.');
  mkdirSync(directory, { recursive: true });
  const checksumResponse = await fetchReleaseAsset(update.checksum, update.tag, fetchImpl, signal);
  const checksumLength = Number(checksumResponse.headers.get('content-length') || 0);
  if (checksumLength > MAX_CHECKSUM_BYTES) throw new Error('The release checksum file is unexpectedly large.');
  const checksumText = await checksumResponse.text();
  if (Buffer.byteLength(checksumText) > MAX_CHECKSUM_BYTES) throw new Error('The release checksum file is unexpectedly large.');
  const checksumLine = checksumText.split(/\r?\n/).map(line => line.match(/^([a-f\d]{64})\s+\*?(.+)$/i)).find(match => match?.[2] === update.installer.name);
  if (!checksumLine) throw new Error('The release checksum does not name the expected installer.');

  const installerResponse = await fetchReleaseAsset(update.installer, update.tag, fetchImpl, signal);
  const installerLength = Number(installerResponse.headers.get('content-length') || 0);
  if (installerLength > MAX_INSTALLER_BYTES) throw new Error('The release installer is unexpectedly large.');
  const finalPath = path.join(directory, update.installer.name);
  const partialPath = `${finalPath}.${randomUUID()}.part`;
  let bytes = 0;
  const hash = createHash('sha256');
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_INSTALLER_BYTES) return callback(new Error('The release installer is unexpectedly large.'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(installerResponse.body, verifier, createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }));
    if (!bytes) throw new Error('The release installer was empty.');
    if (hash.digest('hex').toLowerCase() !== checksumLine[1].toLowerCase()) throw new Error('The release installer checksum did not match.');
    rmSync(finalPath, { force: true });
    renameSync(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }
}

module.exports = { RELEASES_URL, checkForUpdate, downloadUpdate, publicUpdate, selectUpdate, validateReleaseAssetUrl };