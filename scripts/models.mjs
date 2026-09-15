#!/usr/bin/env node
/**
 * Local model and runtime downloader for Voice Supervisor.
 * Targets: moonshine, ling, all, runtimes
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API_TIMEOUT_MS = 15000;
const STREAM_TIMEOUT_MS = 300000;

const DEFAULT_BASE_DIR = process.env.LOCALAPPDATA ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share'));

export const MODEL_DIR = process.env.MODEL_DIR
  ? path.resolve(process.env.MODEL_DIR)
  : path.join(DEFAULT_BASE_DIR, 'VoiceSupervisor', 'models');

export const RUNTIME_DIR = process.env.RUNTIME_DIR
  ? path.resolve(process.env.RUNTIME_DIR)
  : path.join(DEFAULT_BASE_DIR, 'VoiceSupervisor', 'runtimes');

export const TARGETS = {
  moonshine: {
    id: 'moonshine',
    description: 'Moonshine Streaming Tiny Q4_K, tokenizer, and Silero VAD v6.2.0',
    files: [
      {
        repo: 'cstr/moonshine-streaming-tiny-GGUF',
        name: 'moonshine-streaming-tiny-q4_k.gguf',
      },
      {
        repo: 'cstr/moonshine-streaming-tiny-GGUF',
        name: 'tokenizer.bin',
      },
      {
        repo: 'ggml-org/whisper-vad',
        name: 'ggml-silero-v6.2.0.bin',
      },
    ],
  },
  ling: {
    id: 'ling',
    description: 'Ling-3.0 Tiny abliterated APEX-I-Compact GGUF (~3.99GB)',
    files: [
      {
        repo: 'SC117/Ling-3.0-tiny-abliterated-APEX-GGUF',
        name: 'Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf',
      },
    ],
  },
  runtimes: {
    id: 'runtimes',
    repo: 'CrispStrobe/CrispASR',
    description: 'CrispASR prebuilt Windows x86_64 CPU streaming CLI binary',
    assetName: 'crispasr-windows-x86_64-cpu.zip',
    releaseApi: 'https://api.github.com/repos/CrispStrobe/CrispASR/releases/latest',
  },
};

async function getHfRevision(repo) {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${repo}`, {
      headers: { 'User-Agent': 'VoiceSupervisor-Models/0.1' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sha) return data.sha;
    }
  } catch (err) {
    console.warn(`[HF API] Metadata lookup failed for ${repo} (${err.message}); falling back to main.`);
  }
  return 'main';
}

async function getRemoteMetadata(url) {
  const res = await fetch(url, {
    method: 'HEAD',
    headers: { 'User-Agent': 'VoiceSupervisor-Models/0.1' },
    redirect: 'follow',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP HEAD failed with ${res.status} ${res.statusText} for ${url}`);
  const len = res.headers.get('content-length');
  return {
    contentLength: len ? parseInt(len, 10) : null,
    etag: res.headers.get('etag'),
    url: res.url,
  };
}

async function downloadFileStream(url, destPath, expectedLength) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp.${Date.now()}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VoiceSupervisor-Models/0.1' },
      redirect: 'follow',
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP GET returned ${res.status} ${res.statusText} for ${url}`);
    if (!res.body) throw new Error(`Response body is empty for ${url}`);

    const fileStream = fs.createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(res.body), fileStream);

    const stat = fs.statSync(tmpPath);
    if (expectedLength && stat.size !== expectedLength) {
      fs.unlinkSync(tmpPath);
      throw new Error(`Downloaded size (${stat.size} B) did not match expected (${expectedLength} B)`);
    }
    fs.renameSync(tmpPath, destPath);
    return { size: stat.size };
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    throw err;
  }
}

function updateManifest(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, 'manifest.json');
    let current = {};
    if (fs.existsSync(manifestPath)) {
      try { current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    }
    current[record.id] = {
      ...current[record.id],
      ...record,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(current, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[manifest] Could not update manifest in ${dir}: ${err.message}`);
  }
}

async function downloadModelGroup(groupKey) {
  const group = TARGETS[groupKey];
  if (!group) throw new Error(`Unknown model group: ${groupKey}`);

  console.log(`\n=== Downloading ${group.id.toUpperCase()} Models ===`);
  console.log(`Destination: ${MODEL_DIR}\n`);

  fs.mkdirSync(MODEL_DIR, { recursive: true });

  const revisions = new Map();

  for (const file of group.files) {
    if (!revisions.has(file.repo)) {
      console.log(`Looking up latest revision for ${file.repo}...`);
      const rev = await getHfRevision(file.repo);
      revisions.set(file.repo, rev);
    }
    const revision = revisions.get(file.repo);
    const pinnedUrl = `https://huggingface.co/${file.repo}/resolve/${revision}/${file.name}`;
    const dest = path.join(MODEL_DIR, file.name);

    console.log(`Checking ${file.name}...`);
    let meta = null;
    try {
      meta = await getRemoteMetadata(pinnedUrl);
    } catch (err) {
      console.warn(`  Could not fetch HEAD metadata: ${err.message}`);
    }

    if (fs.existsSync(dest)) {
      const stat = fs.statSync(dest);
      if (meta?.contentLength && stat.size === meta.contentLength) {
        console.log(`  Already downloaded; size matches (${(stat.size / (1024 * 1024)).toFixed(1)} MB). Skipping.`);
        continue;
      }
      if (meta?.contentLength && stat.size !== meta.contentLength) {
        throw new Error(`File ${dest} exists (${stat.size} B) but does not match expected size (${meta.contentLength} B). Delete file manually to re-download.`);
      }
      if (!meta?.contentLength && stat.size > 0) {
        throw new Error(`Cannot verify the size of existing file ${dest}; retry when metadata is available.`);
      }
    }

    console.log(`  Starting download: ${pinnedUrl}`);
    const result = await downloadFileStream(pinnedUrl, dest, meta?.contentLength);
    console.log(`  Finished ${file.name}: ${(result.size / (1024 * 1024)).toFixed(1)} MB`);

    updateManifest(MODEL_DIR, {
      id: `${group.id}:${file.name}`,
      target: group.id,
      repo: file.repo,
      fileName: file.name,
      revision,
      size: result.size,
      etag: meta?.etag || null,
      localPath: dest,
    });
  }

  console.log(`Completed ${groupKey} model download.`);
}

async function downloadRuntimes() {
  const target = TARGETS.runtimes;
  console.log('\n=== Downloading CrispASR Windows CPU Runtime ===');
  console.log(`Repository: ${target.repo}`);
  console.log(`Destination: ${RUNTIME_DIR}\n`);

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  console.log(`Fetching latest release from GitHub API (${target.releaseApi})...`);
  const res = await fetch(target.releaseApi, {
    headers: {
      'User-Agent': 'VoiceSupervisor-Models/0.1',
      Accept: 'application/vnd.github.v3+json',
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
  const release = await res.json();
  const asset = release.assets?.find(a => a.name === target.assetName || (a.name.includes('windows') && a.name.includes('cpu') && a.name.endsWith('.zip')));

  if (!asset) {
    throw new Error(`Asset '${target.assetName}' not found in release ${release.tag_name || 'latest'}`);
  }

  const downloadUrl = asset.browser_download_url;
  const zipPath = path.join(RUNTIME_DIR, asset.name);
  console.log(`Asset: ${asset.name} (${(asset.size / (1024 * 1024)).toFixed(1)} MB, tag: ${release.tag_name})`);

  let skipDownload = false;
  if (fs.existsSync(zipPath)) {
    const stat = fs.statSync(zipPath);
    if (stat.size === asset.size) {
      console.log('  Archive already downloaded with matching size. Skipping download.');
      skipDownload = true;
    } else {
      throw new Error(`File ${zipPath} exists (${stat.size} B) but does not match release asset size (${asset.size} B). Delete file manually to re-download.`);
    }
  }

  if (!skipDownload) {
    console.log(`  Downloading ${downloadUrl}...`);
    await downloadFileStream(downloadUrl, zipPath, asset.size);
    console.log('  Download complete.');
  }

  console.log(`Extracting ${asset.name} into ${RUNTIME_DIR} using tar...`);
  const tarResult = spawnSync('tar', ['-xf', zipPath, '-C', RUNTIME_DIR, '--strip-components', '1'], { stdio: 'inherit' });
  if (tarResult.status !== 0) {
    throw new Error(`tar extraction failed with code ${tarResult.status}. Extract ${zipPath} manually into ${RUNTIME_DIR}.`);
  }

  updateManifest(RUNTIME_DIR, {
    id: 'crispasr',
    tag: release.tag_name,
    releaseUrl: release.html_url,
    assetName: asset.name,
    downloadUrl,
    size: asset.size,
    extracted: true,
    dir: RUNTIME_DIR,
  });

  console.log(`Runtime setup complete. CrispASR executable located in ${RUNTIME_DIR}`);
}

function printHelp() {
  console.log(`
Voice Supervisor - Local Models & Runtime Downloader
===================================================

Default Model Directory:
  ${MODEL_DIR}

Default Runtime Directory:
  ${RUNTIME_DIR}

Available Targets:
  moonshine   Moonshine Streaming Tiny Q4_K, tokenizer.bin, and Silero VAD v6.2.0
  ling        Ling-3.0-Tiny abliterated APEX-I-Compact GGUF (~3.99GB)
  all         Download both moonshine and ling model files
  runtimes    Download and extract CrispASR Windows x86_64 CPU streaming CLI

Usage:
  node scripts/models.mjs [moonshine | ling | all | runtimes]
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const target = args[0].toLowerCase();
  switch (target) {
    case 'moonshine':
      await downloadModelGroup('moonshine');
      break;
    case 'ling':
      await downloadModelGroup('ling');
      break;
    case 'all':
      await downloadModelGroup('moonshine');
      await downloadModelGroup('ling');
      break;
    case 'runtimes':
      await downloadRuntimes();
      break;
    default:
      console.error(`Unknown target: "${target}". Expected "moonshine", "ling", "all", or "runtimes".`);
      printHelp();
      process.exit(1);
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch(err => {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  });
}
