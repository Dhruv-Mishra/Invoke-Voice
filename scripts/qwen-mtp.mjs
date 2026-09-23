import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { QWEN_ASSET, assetReady, readJson, request, setupError, writeJson } from './models.mjs';

// Pinned multi-token-prediction (nextn) layer from the base Qwen3.6-35B-A3B MTP GGUF. Only this byte range is downloaded.
export const QWEN_MTP_HEAD = Object.freeze({
  id: 'qwenMtp',
  label: 'Qwen3.6 MTP accelerator (0.5 GB download, builds a 24 GB model copy)',
  repo: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  sourceUrl: 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF/resolve/5bc3e238d916f48a861bac2f8a1990a0e9b7e98d/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
  offset: 22324805920,
  size: 528857088,
  sha256: '4c55971b8e821de511c6c1b4dc0c5c91f4b0a64e8bd893ef5a172dd8ec90e422',
  layer: 40,
  tensors: Object.freeze([
    ['attn_k.weight', [2048, 512], 8, 0], ['attn_k_norm.weight', [256], 0, 1114112], ['attn_norm.weight', [2048], 0, 1115136],
    ['attn_output.weight', [4096, 2048], 8, 1123328], ['attn_q.weight', [2048, 8192], 8, 10036224], ['attn_q_norm.weight', [256], 0, 27862016],
    ['attn_v.weight', [2048, 512], 8, 27863040], ['ffn_down_exps.weight', [512, 2048, 256], 13, 28977152], ['ffn_down_shexp.weight', [512, 2048], 8, 213526528],
    ['ffn_gate_exps.weight', [2048, 512, 256], 12, 214640640], ['ffn_gate_inp.weight', [2048, 256], 30, 365635584], ['ffn_gate_inp_shexp.weight', [2048], 30, 366684160],
    ['ffn_gate_shexp.weight', [2048, 512], 8, 366688256], ['ffn_up_exps.weight', [2048, 512, 256], 12, 367802368], ['ffn_up_shexp.weight', [2048, 512], 8, 518797312],
    ['nextn.eh_proj.weight', [4096, 2048], 8, 519911424], ['nextn.enorm.weight', [2048], 0, 528824320], ['nextn.hnorm.weight', [2048], 0, 528832512],
    ['nextn.shared_head_norm.weight', [2048], 0, 528840704], ['post_attention_norm.weight', [2048], 0, 528848896],
  ]),
});

const SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const RECEIPT_VERSION = 1;

function readHeaderBytes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    for (let size = 16 * 1024 * 1024; size <= 256 * 1024 * 1024; size *= 2) {
      const buffer = Buffer.alloc(size);
      const read = fs.readSync(fd, buffer, 0, size, 0);
      try { return parseGgufHeader(buffer.subarray(0, read)); } catch (error) { if (error.code !== 'SHORT' || read < size) throw error; }
    }
  } finally { fs.closeSync(fd); }
  throw setupError('The Qwen model header is too large to read.');
}

export function parseGgufHeader(buffer) {
  let pos = 0;
  const need = count => { if (pos + count > buffer.length) throw Object.assign(new Error('Truncated GGUF header.'), { code: 'SHORT' }); };
  const u32 = () => { need(4); const value = buffer.readUInt32LE(pos); pos += 4; return value; };
  const u64 = () => { need(8); const value = buffer.readBigUInt64LE(pos); pos += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw setupError('Invalid GGUF header.'); return Number(value); };
  const text = () => { const length = u64(); need(length); const value = buffer.toString('utf8', pos, pos + length); pos += length; return value; };
  const value = type => {
    if (type === 8) return text();
    if (type === 9) {
      const itemType = u32();
      const count = u64();
      if (itemType === 8) { for (let index = 0; index < count; index++) text(); return count; }
      if (!SCALAR_BYTES[itemType]) throw setupError('Unsupported GGUF array type.');
      need(count * SCALAR_BYTES[itemType]); pos += count * SCALAR_BYTES[itemType]; return count;
    }
    const size = SCALAR_BYTES[type];
    if (!size) throw setupError('Unsupported GGUF metadata type.');
    need(size);
    const start = pos;
    pos += size;
    if (type === 4) return buffer.readUInt32LE(start);
    if (type === 5) return buffer.readInt32LE(start);
    if (type === 10) return Number(buffer.readBigUInt64LE(start));
    return buffer.subarray(start, pos);
  };
  need(4);
  if (buffer.toString('latin1', 0, 4) !== 'GGUF') throw setupError('The selected Qwen file is not a GGUF model.');
  pos = 4;
  const version = u32();
  if (version !== 3) throw setupError('Only GGUF version 3 Qwen models are supported for MTP acceleration.');
  const tensorCount = u64();
  const kvCount = u64();
  const kv = [];
  for (let index = 0; index < kvCount; index++) {
    const start = pos;
    const key = text();
    const type = u32();
    const parsed = value(type);
    kv.push({ key, type, value: parsed, bytes: buffer.subarray(start, pos) });
  }
  const tensors = [];
  for (let index = 0; index < tensorCount; index++) {
    const name = text();
    const dimensions = u32();
    const dims = [];
    for (let dimension = 0; dimension < dimensions; dimension++) dims.push(u64());
    tensors.push({ name, dims, type: u32(), offset: u64() });
  }
  const alignment = kv.find(entry => entry.key === 'general.alignment')?.value || 32;
  return { kv, tensors, headerEnd: pos, alignment, dataStart: Math.ceil(pos / alignment) * alignment };
}

function encodeString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function encodeU32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; }
function encodeU64(value) { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; }

export function graftedHeader(header, sourceSize) {
  const get = key => header.kv.find(entry => entry.key === key);
  const blocks = get('qwen35moe.block_count');
  if (get('general.architecture')?.value !== 'qwen35moe' ||
      blocks?.type !== 4 || blocks.value !== QWEN_MTP_HEAD.layer || get('qwen35moe.embedding_length')?.value !== 2048 || get('qwen35moe.expert_count')?.value !== 256 ||
      get('qwen35moe.nextn_predict_layers') || header.tensors.some(tensor => tensor.name.startsWith(`blk.${QWEN_MTP_HEAD.layer}.`))) {
    throw setupError('The selected Qwen model is not a compatible Qwen3.6-35B-A3B GGUF without an MTP layer.');
  }
  const dataSize = sourceSize - header.dataStart;
  const lastEnd = Math.max(...header.tensors.map(tensor => tensor.offset));
  if (dataSize <= 0 || lastEnd >= dataSize) throw setupError('The selected Qwen model is truncated.');
  const base = Math.ceil(dataSize / header.alignment) * header.alignment;
  const parts = [Buffer.from('GGUF'), encodeU32(3), encodeU64(header.tensors.length + QWEN_MTP_HEAD.tensors.length), encodeU64(header.kv.length + 1)];
  for (const entry of header.kv) {
    if (entry.key !== 'qwen35moe.block_count') { parts.push(entry.bytes); continue; }
    parts.push(encodeString(entry.key), encodeU32(4), encodeU32(QWEN_MTP_HEAD.layer + 1));
    parts.push(encodeString('qwen35moe.nextn_predict_layers'), encodeU32(4), encodeU32(1));
  }
  const tensor = (name, dims, type, offset) => { parts.push(encodeString(name), encodeU32(dims.length), ...dims.map(encodeU64), encodeU32(type), encodeU64(offset)); };
  for (const entry of header.tensors) tensor(entry.name, entry.dims, entry.type, entry.offset);
  for (const [name, dims, type, offset] of QWEN_MTP_HEAD.tensors) tensor(`blk.${QWEN_MTP_HEAD.layer}.${name}`, dims, type, base + offset);
  const bytes = Buffer.concat(parts);
  return { bytes: Buffer.concat([bytes, Buffer.alloc(Math.ceil(bytes.length / header.alignment) * header.alignment - bytes.length)]), dataSize, padding: base - dataSize };
}

function receiptFile(paths) {
  return path.join(paths.receiptDir, `qwen-mtp-${createHash('sha256').update(paths.lingMtp).digest('hex').slice(0, 20)}.json`);
}

function stat(file) {
  try { const value = fs.statSync(file); return value.isFile() ? { size: value.size, mtimeMs: value.mtimeMs } : null; } catch { return null; }
}

export function qwenMtpReady(paths) {
  const receipt = readJson(receiptFile(paths));
  const source = stat(paths.ling);
  const target = stat(paths.lingMtp);
  const same = (left, right) => typeof left === 'string' && (process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right));
  return receipt?.version === RECEIPT_VERSION && receipt.head === QWEN_MTP_HEAD.sha256 && same(receipt.source?.path, paths.ling) &&
    source?.size === receipt.source.size && source.mtimeMs === receipt.source.mtimeMs &&
    target?.size === receipt.target?.size && target.mtimeMs === receipt.target.mtimeMs;
}

async function downloadHead(file, { report, signal, fetchImpl }) {
  const hash = createHash('sha256');
  let received = 0;
  let lastReport = 0;
  const partial = `${file}.partial`;
  try {
    const response = await request(QWEN_MTP_HEAD.sourceUrl, { fetchImpl, signal, headers: { Range: `bytes=${QWEN_MTP_HEAD.offset}-${QWEN_MTP_HEAD.offset + QWEN_MTP_HEAD.size - 1}` } });
    if (response.status !== 206 || !response.body) throw setupError('The MTP source did not return the pinned byte range. Retry later.');
    const out = fs.createWriteStream(partial);
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        received += chunk.length;
        if (received > QWEN_MTP_HEAD.size) throw setupError('MTP download exceeded its pinned length.');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        if (Date.now() - lastReport > 250) { lastReport = Date.now(); report({ stage: QWEN_MTP_HEAD.id, message: 'Downloading the Qwen MTP accelerator layer.', progress: { received, total: QWEN_MTP_HEAD.size } }); }
      }
    } finally { await new Promise(resolve => out.end(resolve)); }
    if (received !== QWEN_MTP_HEAD.size || hash.digest('hex') !== QWEN_MTP_HEAD.sha256) throw setupError('Qwen MTP accelerator integrity check failed. Retry to download a clean copy.');
    fs.renameSync(partial, file);
  } finally { fs.rmSync(partial, { force: true }); }
}

export async function buildQwenMtp({ source, head, target, report = () => {}, signal }) {
  const header = readHeaderBytes(source);
  const sourceSize = fs.statSync(source).size;
  const { bytes, dataSize, padding } = graftedHeader(header, sourceSize);
  const total = bytes.length + dataSize + padding + QWEN_MTP_HEAD.size;
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const free = fs.statfsSync(directory);
  if (free.bavail * free.bsize < total + 1024 ** 3) throw setupError(`Building the Qwen MTP model needs about ${Math.ceil(total / 1024 ** 3)} GB of free disk space in ${directory}.`);
  const partial = `${target}.partial`;
  const output = fs.openSync(partial, 'w');
  const chunk = Buffer.alloc(16 * 1024 * 1024);
  let written = 0;
  let lastReport = 0;
  const write = buffer => {
    fs.writeSync(output, buffer, 0, buffer.length, written);
    written += buffer.length;
    if (Date.now() - lastReport > 250) { lastReport = Date.now(); report({ stage: QWEN_MTP_HEAD.id, message: 'Building the MTP-accelerated Qwen model.', progress: { received: written, total } }); }
  };
  const copy = (file, start, length) => {
    const input = fs.openSync(file, 'r');
    try {
      for (let offset = 0; offset < length;) {
        signal?.throwIfAborted();
        const count = fs.readSync(input, chunk, 0, Math.min(chunk.length, length - offset), start + offset);
        if (count <= 0) throw setupError('The Qwen source ended unexpectedly while building the MTP model.');
        write(chunk.subarray(0, count));
        offset += count;
      }
    } finally { fs.closeSync(input); }
  };
  try {
    write(bytes);
    copy(source, header.dataStart, dataSize);
    write(Buffer.alloc(padding));
    copy(head, 0, QWEN_MTP_HEAD.size);
    fs.fsyncSync(output);
  } catch (error) {
    fs.closeSync(output);
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.closeSync(output);
  if (stat(partial)?.size !== total) { fs.rmSync(partial, { force: true }); throw setupError('The MTP model build produced an unexpected size.'); }
  fs.renameSync(partial, target);
  return total;
}

export async function ensureQwenMtp(paths, { report = () => {}, signal, fetchImpl = fetch } = {}) {
  if (qwenMtpReady(paths)) return paths.lingMtp;
  if (!assetReady(paths, QWEN_ASSET, paths.ling)) throw setupError('Verify the Qwen model before building its MTP accelerator.');
  const head = path.join(paths.modelDir, 'qwen3.6-mtp-head.bin');
  report({ stage: QWEN_MTP_HEAD.id, message: 'Preparing the Qwen MTP accelerator layer.' });
  const cached = stat(head)?.size === QWEN_MTP_HEAD.size && createHash('sha256').update(fs.readFileSync(head)).digest('hex') === QWEN_MTP_HEAD.sha256;
  if (!cached) {
    fs.mkdirSync(paths.modelDir, { recursive: true });
    await downloadHead(head, { report, signal, fetchImpl });
  }
  await buildQwenMtp({ source: paths.ling, head, target: paths.lingMtp, report, signal });
  writeJson(receiptFile(paths), { version: RECEIPT_VERSION, head: QWEN_MTP_HEAD.sha256, source: { path: paths.ling, ...stat(paths.ling) }, target: { path: paths.lingMtp, ...stat(paths.lingMtp) } });
  fs.rmSync(head, { force: true });
  return paths.lingMtp;
}
