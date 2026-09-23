import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { on, once } from 'node:events';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const hf = (id, label, repo, revision, name) => ({ id, label, repo, revision, name, sourceUrl: `https://huggingface.co/${repo}/resolve/${revision}/${name}` });
export const GEMMA_ASSET = Object.freeze(hf('ling', 'Gemma 4 E2B IT QAT Q4_0', 'google/gemma-4-E2B-it-qat-q4_0-gguf', '675cff42a74c774d6cb76f76d8eacb49b48c9b93', 'gemma-4-E2B_q4_0-it.gguf'));
export const LEGACY_LING_ASSETS = Object.freeze(['Compact', 'Quality'].map(variant => hf('ling', `Ling ${variant}`, 'SC117/Ling-3.0-tiny-abliterated-APEX-GGUF', 'b923d16fcf28261f12be9ece2b520ed442403f70', `Ling-3.0-tiny-abliterated-APEX-I-${variant}.gguf`)));
export const QWEN_ASSET = Object.freeze({
  ...hf('ling', 'Qwen3.6 35B-A3B MoE Q4_K_P (opt-in)', 'HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive', 'f12a584fecbeb5f20001130d8ecd66c9327ae685', 'Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf'),
  size: 23424536704, sha256: '8d344a4336d8ea7da0cbfc12792d1471e568be7abe8930c52260698bfd01d731',
});
export const ASSETS = Object.freeze([
  GEMMA_ASSET,
  hf('moonshine', 'Moonshine Tiny Q4_K', 'cstr/moonshine-streaming-tiny-GGUF', '34ac435a44ab618d426a72346987b68ce07bbf44', 'moonshine-streaming-tiny-q4_k.gguf'),
  hf('tokenizer', 'Moonshine tokenizer', 'cstr/moonshine-streaming-tiny-GGUF', '34ac435a44ab618d426a72346987b68ce07bbf44', 'tokenizer.bin'),
  hf('vad', 'Silero VAD 6.2.0', 'ggml-org/whisper-vad', '9ffd54a1e1ee413ddf265af9913beaf518d1639b', 'ggml-silero-v6.2.0.bin'),
  hf('kokoroConfig', 'Kokoro configuration', 'hexgrad/Kokoro-82M', 'f3ff3571791e39611d31c381e3a41a3af07b4987', 'config.json'),
  hf('kokoroModel', 'Kokoro 82M weights', 'hexgrad/Kokoro-82M', 'f3ff3571791e39611d31c381e3a41a3af07b4987', 'kokoro-v1_0.pth'),
  hf('kokoroVoice', 'Kokoro af_heart voice', 'hexgrad/Kokoro-82M', 'f3ff3571791e39611d31c381e3a41a3af07b4987', 'voices/af_heart.pt'),
  { id: 'llama', label: 'llama.cpp b10970 CPU', name: 'llama-b10970-bin-win-cpu-x64.zip', executable: 'llama-server.exe', size: 18428751, sha256: '2c6d6516c04e95caa080d8eb917743e71858c73985acbb6739ad61b14e68b298', sourceUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b10970/llama-b10970-bin-win-cpu-x64.zip' },
  { id: 'crispasr', label: 'CrispASR 0.8.32 CPU', name: 'crispasr-windows-x86_64-cpu-legacy.zip', executable: 'crispasr.exe', size: 7713869, sha256: 'ba4e23fb8dfcc99b8a76af034954576a75f88193e3dbf62fc774287bcbd1114b', sourceUrl: 'https://github.com/CrispStrobe/CrispASR/releases/download/v0.8.32/crispasr-windows-x86_64-cpu-legacy.zip' },
  { id: 'uv', label: 'uv 0.8.17 / isolated Python', name: 'uv-x86_64-pc-windows-msvc.zip', executable: 'uv.exe', size: 20489375, sha256: '0d051779fbcb173b183efeae1c3e96148764fd82709bbbf0966df3efe48b67c5', sourceUrl: 'https://github.com/astral-sh/uv/releases/download/0.8.17/uv-x86_64-pc-windows-msvc.zip' },
  ...[
    ['whisperConfig', 'config.json'],
    ['whisperModel', 'model.bin'],
    ['whisperTokenizer', 'tokenizer.json'],
    ['whisperVocabulary', 'vocabulary.txt'],
  ].map(([id, name]) => hf(id, `Whisper Small ${name}`, 'Systran/faster-whisper-small', '536b0662742c02347bc0e980a01041f333bce120', name)),
]);

export const CRISPASR_AVX2_ASSET = { id: 'crispasr', label: 'CrispASR 0.8.32 CPU AVX2 (opt-in)', name: 'crispasr-windows-x86_64-cpu.zip', executable: 'crispasr.exe', runtimeDirectory: 'crispasr-avx2', size: 8261759, sha256: 'ac8b6caf4dd448d00c5050907275bce4d154747110c37943aa4f69ee7fac9541', sourceUrl: 'https://github.com/CrispStrobe/CrispASR/releases/download/v0.8.32/crispasr-windows-x86_64-cpu.zip' };
export const LLAMA_VULKAN_ASSET = Object.freeze({ id: 'llama', label: 'llama.cpp b10970 Vulkan GPU offload (opt-in)', name: 'llama-b10970-bin-win-vulkan-x64.zip', executable: 'llama-server.exe', runtimeDirectory: 'llama-vulkan', size: 31675940, sha256: 'f17091a433feb686d9e17378a8a2fc53a1437d64c1bf302ab6fb3072b4afcf0d', sourceUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b10970/llama-b10970-bin-win-vulkan-x64.zip' });

export const TASK_SEARCH_MODEL_KEY = 'Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9:q8:mean:256:v1';
export const TASK_SEARCH_ASSETS = Object.freeze([
  ['taskSearchConfig', 'config.json'],
  ['taskSearchTokenizer', 'tokenizer.json'],
  ['taskSearchTokenizerConfig', 'tokenizer_config.json'],
  ['taskSearchWeights', 'onnx/model_quantized.onnx'],
].map(([id, name]) => hf(id, `Task search MiniLM ${name}`, 'Xenova/all-MiniLM-L6-v2', '751bff37182d3f1213fa05d7196b954e230abad9', name)));

export function setupError(message) {
  return Object.assign(new Error(message), { setupMessage: message });
}

export function localSttProvider(env = process.env) {
  const provider = env.LOCAL_STT_PROVIDER || 'whisper';
  if (!['whisper', 'moonshine'].includes(provider)) throw setupError('LOCAL_STT_PROVIDER must be whisper or moonshine.');
  return provider;
}

export function localLlmProfile(env = process.env) {
  return env.LOCAL_LLM_PROFILE === 'qwen' ? 'qwen' : 'gemma';
}

export function localLlmAsset(env = process.env) {
  return localLlmProfile(env) === 'qwen' ? QWEN_ASSET : GEMMA_ASSET;
}

export function qwenMtpEnabled(env = process.env) {
  return localLlmProfile(env) === 'qwen' && env.QWEN_MTP !== 'off';
}

export function localSetupAssets(env = process.env) {
  const whisper = localSttProvider(env) === 'whisper';
  return ASSETS.filter(asset => whisper
    ? !['moonshine', 'tokenizer', 'vad', 'crispasr'].includes(asset.id)
    : !asset.id.startsWith('whisper')).map(asset => asset.id === 'ling' ? localLlmAsset(env) : asset.id === 'llama' && env.LLAMA_BACKEND === 'vulkan' ? LLAMA_VULKAN_ASSET : asset);
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.partial`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.partial`, file);
}

export async function withSetupLock(paths, action) {
  fs.mkdirSync(paths.home, { recursive: true });
  const { default: lockfile } = await import('proper-lockfile');
  let release;
  try { release = await lockfile.lock(paths.home, { realpath: false, lockfilePath: path.join(paths.home, 'local-setup.lock'), stale: 30000, update: 5000, retries: 0 }); }
  catch (error) {
    if (error.code === 'ELOCKED') throw setupError('Another app or command is provisioning this cache. Wait for it to finish, then retry. After an interrupted setup, wait at least 30 seconds before retrying.');
    throw error;
  }
  try { return await action(); } finally { await release(); }
}

function fileStat(file) {
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0 ? { size: stat.size, mtimeMs: stat.mtimeMs } : null; } catch { return null; }
}

export function stackPaths(env = process.env, appRoot = root) {
  const home = path.resolve(env.SUPERVISOR_CACHE_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VoiceSupervisor'));
  const modelDir = path.resolve(env.MODEL_DIR || path.join(home, 'models'));
  const runtimeDir = path.resolve(env.RUNTIME_DIR || path.join(home, 'runtimes'));
  const base = env.SUPERVISOR_CONFIG_DIR || appRoot;
  const configured = value => value ? path.resolve(base, value) : null;
  const whisperDir = configured(env.WHISPER_MODEL_DIR) || path.join(modelDir, 'whisper-small');
  const pythonBase = env.PYTHON_BIN && env.PYTHON_BIN !== 'python' ? configured(env.PYTHON_BIN) : null;
  const venv = path.join(runtimeDir, pythonBase ? `kokoro-approved-${createHash('sha256').update(pythonBase).digest('hex').slice(0, 20)}` : 'kokoro-venv');
  const select = (...candidates) => candidates.find(candidate => candidate && fileStat(candidate));
  const localStack = path.resolve(appRoot, '../LocalVoiceStack');
  const requestedMoonshine = configured(env.MOONSHINE_MODEL);
  const crispasrCpu = env.CRISPASR_CPU || 'legacy';
  const llamaBackend = env.LLAMA_BACKEND === 'vulkan' ? 'vulkan' : 'cpu';
  if (!['legacy', 'avx2'].includes(crispasrCpu)) throw setupError('CRISPASR_CPU must be legacy or avx2. Use avx2 only on a CPU with AVX2, FMA and F16C support.');
  const q4Name = ASSETS[1].name;
  const compatibleMoonshine = requestedMoonshine && path.basename(requestedMoonshine).toLowerCase() !== 'moonshine-streaming-small-q8_0.gguf' ? requestedMoonshine : null;
  const moonshine = select(compatibleMoonshine, requestedMoonshine && path.join(path.dirname(requestedMoonshine), q4Name), path.join(localStack, 'STT_Models', q4Name), path.join(modelDir, q4Name)) || path.join(modelDir, q4Name);
  return {
    home, modelDir, runtimeDir, crispasrCpu, llamaBackend, receiptDir: path.join(home, 'setup-receipts'),
    whisperDir,
    ...Object.fromEntries(ASSETS.filter(asset => asset.id.startsWith('whisper')).map(asset => [asset.id, path.join(whisperDir, asset.name)])),
    ...Object.fromEntries(TASK_SEARCH_ASSETS.map(asset => [asset.id, path.join(modelDir, 'task-search-minilm', asset.name)])),
    ling: localLlmProfile(env) === 'qwen'
      ? select(configured(env.QWEN_MODEL_PATH), path.join(localStack, 'LLMs', QWEN_ASSET.name), path.join(modelDir, QWEN_ASSET.name)) || path.join(modelDir, QWEN_ASSET.name)
      : select(configured(env.LOCAL_LLM_PATH), path.join(localStack, 'LLMs', ASSETS[0].name), path.join(modelDir, ASSETS[0].name)) || path.join(modelDir, ASSETS[0].name),
    lingMtp: path.join(modelDir, QWEN_ASSET.name.replace(/\.gguf$/i, '-MTP.gguf')),
    moonshine,
    tokenizer: select(path.join(path.dirname(moonshine), 'tokenizer.bin'), path.join(modelDir, 'tokenizer.bin')) || path.join(modelDir, 'tokenizer.bin'),
    vad: select(configured(env.VAD_MODEL), path.join(modelDir, ASSETS[3].name)) || path.join(modelDir, ASSETS[3].name),
    llama: select(configured(env.LLAMA_SERVER_BIN)) || path.join(runtimeDir, llamaBackend === 'vulkan' ? LLAMA_VULKAN_ASSET.runtimeDirectory : 'llama', 'llama-server.exe'),
    crispasr: select(configured(env.CRISPASR_BIN)) || (crispasrCpu === 'avx2' ? path.join(runtimeDir, 'crispasr-avx2', 'crispasr.exe') : select(path.join(runtimeDir, 'crispasr.exe')) || path.join(runtimeDir, 'crispasr', 'crispasr.exe')),
    uv: path.join(runtimeDir, 'uv', 'uv.exe'),
    pythonBase, venv,
    python: path.join(venv, 'Scripts', 'python.exe'),
    kokoroConfig: path.join(modelDir, 'kokoro', 'config.json'),
    kokoroModel: path.join(modelDir, 'kokoro', 'kokoro-v1_0.pth'),
    kokoroVoice: path.join(modelDir, 'kokoro', 'af_heart.pt'),
  };
}

export const MODEL_DIR = stackPaths().modelDir;
export const RUNTIME_DIR = stackPaths().runtimeDir;

function receiptPath(paths, asset, destination) {
  return path.join(paths.receiptDir, `${asset.id}-${createHash('sha256').update(destination).digest('hex').slice(0, 20)}.json`);
}

export function assetReady(paths, asset, destination = paths[asset.id]) {
  if (asset.id === 'crispasr' && paths.crispasrCpu === 'avx2') asset = CRISPASR_AVX2_ASSET;
  if (asset.id === 'llama' && paths.llamaBackend === 'vulkan') asset = LLAMA_VULKAN_ASSET;
  const receipt = readJson(receiptPath(paths, asset, destination));
  if (receipt?.sourceUrl !== asset.sourceUrl || !receipt.files?.length) return false;
  const expected = path.resolve(destination);
  let canonicalExpected;
  let canonicalRoot;
  try {
    canonicalExpected = fs.realpathSync.native(expected);
    canonicalRoot = asset.executable ? fs.realpathSync.native(path.dirname(expected)) : canonicalExpected;
  } catch { return false; }
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  for (const managed of [paths.modelDir, paths.runtimeDir]) {
    const lexicalRelative = path.relative(path.resolve(managed), expected);
    if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) continue;
    let canonicalManaged;
    try { canonicalManaged = fs.realpathSync.native(managed); } catch { return false; }
    const canonicalRelative = path.relative(canonicalManaged, canonicalExpected);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) return false;
  }
  if (!receipt.files.some(record => {
    try { return normalize(fs.realpathSync.native(record.path)) === normalize(canonicalExpected); }
    catch { return false; }
  })) return false;
  return receipt.files.every(record => {
    let recorded;
    try { recorded = fs.realpathSync.native(record.path); } catch { return false; }
    const relative = path.relative(canonicalRoot, recorded);
    if (asset.executable && (relative.startsWith('..') || path.isAbsolute(relative))) return false;
    if (!asset.executable && normalize(recorded) !== normalize(canonicalExpected)) return false;
    const stat = fileStat(recorded);
    return stat && stat.size === record.size && stat.mtimeMs === record.mtimeMs;
  });
}

function recordAsset(paths, asset, destination, files, digest) {
  writeJson(receiptPath(paths, asset, destination), { sourceUrl: asset.sourceUrl, digest, files: files.map(file => ({ path: file, ...fileStat(file) })) });
}

export function trustedDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && (
      ['huggingface.co', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname) ||
      url.hostname.endsWith('.hf.co') || url.hostname.endsWith('.huggingface.co')
    );
  } catch { return false; }
}

export async function request(url, { fetchImpl = fetch, signal, headers = {} }) {
  for (let redirects = 0; redirects < 8; redirects += 1) {
    if (!trustedDownloadUrl(url)) throw setupError('Download was redirected outside the trusted sources. Retry after checking the release source.');
    const response = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'VoiceSupervisor-Setup/0.1', ...headers }, signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30 * 60 * 1000)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw setupError('Download source returned an invalid redirect. Retry later.');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw setupError(`Download source returned HTTP ${response.status}. Check your connection or proxy, then retry.`);
    return response;
  }
  throw setupError('Download source redirected too many times. Retry later.');
}

async function metadata(asset, options) {
  if (asset.sha256) return asset;
  const parent = path.posix.dirname(asset.name);
  const response = await request(`https://huggingface.co/api/models/${asset.repo}/tree/${asset.revision}${parent === '.' ? '' : `/${parent}`}`, options);
  const files = await response.json();
  const entry = files.find(file => file.path === asset.name);
  const digest = entry?.lfs?.oid || entry?.oid;
  if (!Number.isSafeInteger(entry?.size) || entry.size <= 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(digest || '')) throw setupError('Pinned model metadata is unavailable. Retry when Hugging Face is reachable.');
  return { size: entry.size, [digest.length === 64 ? 'sha256' : 'gitSha1']: digest };
}

function hasher(meta) {
  const hash = createHash(meta.sha256 ? 'sha256' : 'sha1');
  if (!meta.sha256) hash.update(`blob ${meta.size}\0`);
  return hash;
}

async function verify(file, meta, signal, onProgress = () => {}) {
  if (fileStat(file)?.size !== meta.size) return false;
  const hash = hasher(meta);
  let received = 0;
  let lastReport = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    signal?.throwIfAborted();
    hash.update(chunk);
    received += chunk.length;
    if (Date.now() - lastReport > 500) { lastReport = Date.now(); onProgress({ received, total: meta.size }); }
  }
  return hash.digest('hex') === (meta.sha256 || meta.gitSha1);
}

export async function ensureAsset(paths, asset, { report = () => {}, signal, fetchImpl = fetch } = {}) {
  if (!ASSETS.includes(asset) && !TASK_SEARCH_ASSETS.includes(asset) && ![GEMMA_ASSET, QWEN_ASSET, LLAMA_VULKAN_ASSET].includes(asset)) throw setupError('Unknown setup component.');
  if (asset.id === 'crispasr' && paths.crispasrCpu === 'avx2') asset = CRISPASR_AVX2_ASSET;
  if (asset.id === 'llama' && paths.llamaBackend === 'vulkan') asset = LLAMA_VULKAN_ASSET;
  const destination = paths[asset.id];
  if (assetReady(paths, asset, destination)) return destination;
  const options = { signal, fetchImpl };
  const receipt = readJson(receiptPath(paths, asset, destination));
  const cachedDigest = !asset.executable && receipt?.sourceUrl === asset.sourceUrl && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.digest || '') && receipt.files?.find(record => record.path === destination);
  const meta = cachedDigest ? { size: cachedDigest.size, [receipt.digest.length === 64 ? 'sha256' : 'gitSha1']: receipt.digest } : await metadata(asset, options);
  const downloadPath = asset.executable ? path.join(paths.runtimeDir, 'archives', asset.name) : destination;
  report({ stage: asset.id, message: `Checking ${asset.label}.` });
  if (!await verify(downloadPath, meta, signal, progress => meta.size > 1024 ** 3 && report({ stage: asset.id, message: `Verifying ${asset.label}.`, progress }))) {
    if (!asset.executable && fileStat(downloadPath) && !downloadPath.startsWith(`${paths.modelDir}${path.sep}`)) {
      throw setupError(`${asset.label}: the configured file did not match the pinned model. Keep it unchanged and correct your local path before retrying.`);
    }
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
    const partial = `${downloadPath}.partial`;
    const hash = hasher(meta);
    let received = 0;
    let lastReport = 0;
    try {
      const response = await request(asset.sourceUrl, options);
      if (!response.body) throw new Error('Empty download');
      const meter = new Transform({ transform(chunk, encoding, done) {
        received += chunk.length;
        if (received > meta.size) return done(new Error('Download exceeded expected length'));
        hash.update(chunk);
        if (Date.now() - lastReport > 250 || received === meta.size) {
          lastReport = Date.now();
          report({ stage: asset.id, message: `Downloading ${asset.label}.`, progress: { received, total: meta.size } });
        }
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(partial), { signal });
      if (received !== meta.size || hash.digest('hex') !== (meta.sha256 || meta.gitSha1)) throw setupError(`${asset.label}: download integrity check failed. Retry to download a clean copy.`);
      if (!asset.executable && fs.existsSync(downloadPath)) fs.renameSync(downloadPath, `${downloadPath}.invalid-${Date.now()}`);
      fs.renameSync(partial, downloadPath);
    } finally { fs.rmSync(partial, { force: true }); }
  }
  if (!asset.executable) {
    recordAsset(paths, asset, destination, [destination], meta.sha256 || meta.gitSha1);
    return destination;
  }
  const targetDir = path.join(paths.runtimeDir, asset.runtimeDirectory || asset.id);
  const staging = fs.mkdtempSync(`${targetDir}.partial-`);
  try {
    report({ stage: asset.id, message: `Extracting ${asset.label}.` });
    const { default: yauzl } = await import('yauzl');
    const archive = await new Promise((resolve, reject) => yauzl.open(downloadPath, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, archive) => error ? reject(error) : resolve(archive)));
    try {
      if (archive.entryCount > 10000) throw setupError('Runtime archive contains too many entries. Check the release source.');
      let expandedSize = 0;
      const archiveEntries = on(archive, 'entry', { close: ['end'], signal });
      archive.readEntry();
      for await (const [entry] of archiveEntries) {
        signal?.throwIfAborted();
        const name = entry.fileName;
        const segments = name.replace(/\/$/, '').split('/');
        const output = path.resolve(staging, ...segments);
        const relative = path.relative(staging, output);
        if (/[\x00-\x1f<>:"\\|?*]/.test(name) || segments.some(segment => !segment || segment === '.' || segment === '..' || /[ .]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw setupError('Runtime archive contains an unsafe path. Check the release source.');
        }
        const type = (entry.externalFileAttributes >>> 16) & 0o170000;
        const directory = name.endsWith('/') || Boolean(entry.externalFileAttributes & 0x10) || type === 0o040000;
        if (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) throw setupError('Runtime archive contains symbolic links or special file types. Check the release source.');
        expandedSize += entry.uncompressedSize;
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || expandedSize > 1024 ** 3 || (directory && entry.uncompressedSize !== 0)) throw setupError('Runtime archive exceeds the extraction size limit or has invalid directory data. Check the release source.');
        if (entry.isEncrypted()) throw setupError('Runtime archive contains encrypted entries. Check the release source.');
        fs.mkdirSync(directory ? output : path.dirname(output), { recursive: true });
        if (!directory) {
          const source = await new Promise((resolve, reject) => archive.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
          await pipeline(source, fs.createWriteStream(output, { flags: 'wx' }), { signal });
        }
        archive.readEntry();
      }
    } finally {
      const closed = once(archive, 'close');
      archive.close();
      await closed;
    }
    const entries = fs.readdirSync(staging, { recursive: true, withFileTypes: true });
    const executable = entries.find(entry => entry.isFile() && entry.name === asset.executable);
    if (!executable) throw setupError(`${asset.label}: the archive is missing its executable. Retry or check the release source.`);
    const sourceDir = executable.parentPath || executable.path;
    const backupDir = `${targetDir}.backup-${process.pid}`;
    fs.rmSync(backupDir, { recursive: true, force: true });
    const hadTarget = fs.existsSync(targetDir);
    let movedTarget = false;
    try {
      if (hadTarget) {
        fs.renameSync(targetDir, backupDir);
        movedTarget = true;
      }
      fs.renameSync(sourceDir, targetDir);
    } catch (error) {
      if (movedTarget) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        if (fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
      }
      throw error;
    }
    if (movedTarget) fs.rmSync(backupDir, { recursive: true, force: true });
    const files = fs.readdirSync(targetDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath || entry.path, entry.name));
    paths[asset.id] = path.join(targetDir, asset.executable);
    recordAsset(paths, asset, paths[asset.id], files, meta.sha256);
    return paths[asset.id];
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

async function main() {
  const target = process.argv[2];
  if (!['all', 'ling', 'gemma', 'qwen', 'whisper', 'moonshine', 'runtimes', 'task-search'].includes(target)) {
    console.log('Usage: npm run models -- all|ling|gemma|qwen|whisper|moonshine|runtimes|task-search\nAll installs the selected local recognizer (Whisper by default). qwen verifies or downloads the opt-in Qwen3.6 model and builds its MTP accelerator unless QWEN_MTP=off. Full voice setup remains in Settings.');
    return;
  }
  if (target === 'runtimes' && (process.platform !== 'win32' || process.arch !== 'x64')) throw setupError('Prebuilt runtimes support Windows x64 only.');
  const paths = stackPaths();
  if (target === 'qwen') {
    const qwenPaths = stackPaths({ ...process.env, LOCAL_LLM_PROFILE: 'qwen' });
    const report = event => { if (!event.progress) console.log(event.message); };
    await withSetupLock(qwenPaths, async () => {
      const { ensureQwenMtp, qwenMtpReady } = await import('./qwen-mtp.mjs');
      if (process.env.QWEN_MTP !== 'off') await ensureQwenMtp(qwenPaths, { report });
      else if (!qwenMtpReady(qwenPaths)) await ensureAsset(qwenPaths, QWEN_ASSET, { report });
    });
    console.log('Qwen installed; select it in Settings > Local model.');
    return;
  }
  if (target === 'gemma') {
    paths.ling = path.join(paths.modelDir, GEMMA_ASSET.name);
    await withSetupLock(paths, () => ensureAsset(paths, GEMMA_ASSET, { report: event => { if (!event.progress) console.log(event.message); } }));
    console.log('Gemma installed; selected model unchanged.');
    return;
  }
  const candidates = ['all', 'runtimes'].includes(target) ? localSetupAssets() : ASSETS;
  const selected = target === 'task-search' ? TASK_SEARCH_ASSETS : candidates.filter(asset => target === 'runtimes' ? Boolean(asset.executable) && !(asset.id === 'uv' && paths.pythonBase) : target === 'all' ? ['ling', 'moonshine', 'tokenizer', 'vad'].includes(asset.id) || asset.id.startsWith('whisper') : target === 'ling' ? asset.id === 'ling' : target === 'whisper' ? asset.id.startsWith('whisper') : ['moonshine', 'tokenizer', 'vad', 'crispasr'].includes(asset.id));
  await withSetupLock(paths, async () => {
    for (const asset of selected) await ensureAsset(paths, asset, { report: event => { if (!event.progress) console.log(event.message); } });
  });
  console.log('Selected files are installed. Full runtime readiness is checked by app setup.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.setupMessage || 'Download failed. Check network access and free disk space, then retry.'); process.exitCode = 1; });
}
