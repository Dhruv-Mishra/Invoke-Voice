import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { verifyWhisperPack } from './kokoro-pack.mjs';
import { setupError } from '../scripts/models.mjs';

const helper = fileURLToPath(new URL('../scripts/voice_pack.py', import.meta.url));
const releaseHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

async function hash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

function sourceUrl(value) {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback || url.username || url.password || url.hash) throw new Error('Voice pack sources must use HTTPS without credentials.');
  return url;
}

export async function downloadVoicePack(descriptor, destination, { urls = descriptor.urls, fetchImpl = fetch, signal, report = () => {} } = {}) {
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination) && statSync(destination).size === descriptor.size && await hash(destination) === descriptor.sha256) return destination;
  const partial = `${destination}.partial`;
  for (const source of urls) {
    signal?.throwIfAborted();
    try {
      const original = sourceUrl(source);
      let url = original;
      let offset = existsSync(partial) ? statSync(partial).size : 0;
      if (offset >= descriptor.size) { rmSync(partial, { force: true }); offset = 0; }
      let response;
      const requestSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30 * 60 * 1000)]);
      for (let redirect = 0; redirect < 8; redirect += 1) {
        if (url.origin !== original.origin && !(releaseHosts.has(original.hostname) && releaseHosts.has(url.hostname) && url.protocol === 'https:')) throw new Error('Untrusted voice pack redirect.');
        response = await fetchImpl(url.href, { redirect: 'manual', signal: requestSignal, headers: { 'User-Agent': 'VoiceSupervisor-Setup', ...(offset ? { Range: `bytes=${offset}-` } : {}) } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Missing redirect location.');
        url = sourceUrl(new URL(location, url).href);
      }
      if (![200, 206].includes(response.status)) { await response.body?.cancel(); throw new Error('Voice pack source unavailable.'); }
      if (response.status === 206) {
        if (response.headers.get('content-range') !== `bytes ${offset}-${descriptor.size - 1}/${descriptor.size}`) { await response.body?.cancel(); throw new Error('Invalid voice pack range.'); }
      } else offset = 0;
      let received = offset;
      let lastReport = 0;
      const meter = new Transform({ transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > descriptor.size) return done(new Error('Voice pack exceeds pinned size.'));
        if (Date.now() - lastReport > 250 || received === descriptor.size) {
          lastReport = Date.now();
          report({ stage: 'kokoro', message: 'Downloading verified local voice dependencies.', progress: { received, total: descriptor.size } });
        }
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal: requestSignal });
      if (received !== descriptor.size) throw new Error('Incomplete voice pack download.');
      if (await hash(partial) !== descriptor.sha256) { rmSync(partial, { force: true }); throw new Error('Voice pack checksum mismatch.'); }
      rmSync(destination, { force: true });
      renameSync(partial, destination);
      return destination;
    } catch {
      signal?.throwIfAborted();
      report({ stage: 'kokoro', message: 'Dependency source unavailable or unverified; checking the next approved source.' });
    }
  }
  throw setupError('The pinned voice dependency pack is unavailable online or in the local cache. Retry, set LOCAL_VOICE_PACK_URL to a mirror, or LOCAL_VOICE_PACK_FILE to the matching offline pack. Completed downloads are retained.');
}

export async function resolveVoicePack({ sourceDir, paths, env, run, report, signal, fetchImpl }) {
  if (!sourceDir || !existsSync(path.join(sourceDir, 'descriptor.json'))) return null;
  let descriptor;
  try {
    descriptor = JSON.parse(readFileSync(path.join(sourceDir, 'descriptor.json'), 'utf8'));
    if (descriptor.format !== 'wheelhouse-tar-xz-v1' || !/^voice-dependencies-[a-f0-9]{16}\.tar\.xz$/.test(descriptor.filename) || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || !/^[a-f0-9]{64}$/.test(descriptor.manifestSha256) || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > 1024 ** 3 || !Number.isSafeInteger(descriptor.expandedSize) || descriptor.expandedSize <= 0 || descriptor.expandedSize > 8 * 1024 ** 3 || !Array.isArray(descriptor.urls) || descriptor.urls.length > 4 || descriptor.urls.some(value => !releaseHosts.has(sourceUrl(value).hostname))) throw new Error();
  } catch { throw setupError('Invalid pinned voice dependency descriptor. Reinstall the matching release.'); }
  const cache = path.join(paths.home, 'voice-packs');
  const target = path.join(cache, descriptor.sha256);
  const verify = async directory => {
    try {
      if (await hash(path.join(directory, 'manifest.json')) !== descriptor.manifestSha256) return null;
      return await verifyWhisperPack(directory);
    } catch { return null; }
  };
  const existing = await verify(target);
  if (existing) return existing;
  const cachedArchive = path.join(cache, descriptor.filename);
  let archive;
  for (const candidate of [env.LOCAL_VOICE_PACK_FILE, path.join(sourceDir, descriptor.filename), cachedArchive].filter(Boolean)) {
    signal?.throwIfAborted();
    if (existsSync(candidate) && statSync(candidate).size === descriptor.size && await hash(candidate) === descriptor.sha256) { archive = candidate; break; }
  }
  archive ||= await downloadVoicePack(descriptor, cachedArchive, { urls: [...(env.LOCAL_VOICE_PACK_URL ? [env.LOCAL_VOICE_PACK_URL] : []), ...descriptor.urls], fetchImpl, signal, report });
  const staging = `${target}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    await run(paths.python, ['-I', helper, 'extract', archive, staging, String(descriptor.expandedSize)], { report, signal, stage: 'kokoro', message: 'Extracting verified local voice dependencies.' });
    if (!await verify(staging)) throw setupError('Extracted voice dependency pack failed verification. Check disk space and retry with the matching release pack.');
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return await verify(target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}