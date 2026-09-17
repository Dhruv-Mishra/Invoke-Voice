import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { assetReady, stackPaths, TASK_SEARCH_ASSETS, TASK_SEARCH_MODEL_KEY } from '../../scripts/models.mjs';

export function createLocalTaskSearch({ dataDir, env }) {
  const paths = stackPaths(env);
  let extractorPromise;
  let retryAt = 0;
  const index = new SemanticTaskIndex({
    cacheFile: path.join(dataDir, 'task-search-vectors.json'), modelKey: TASK_SEARCH_MODEL_KEY,
    embed: async texts => {
      extractorPromise ??= import('@huggingface/transformers').then(({ pipeline }) => pipeline('feature-extraction', path.dirname(paths.taskSearchConfig), {
        device: 'cpu', dtype: 'q8', local_files_only: true,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      }));
      const extractor = await extractorPromise;
      const output = await extractor(texts, { pooling: 'mean', normalize: true, truncation: true, max_length: 256 });
      return output.tolist();
    },
  });
  return async (query, documents, lexical) => {
    if (!documents.length || Date.now() < retryAt || !TASK_SEARCH_ASSETS.every(asset => assetReady(paths, asset))) return lexical;
    try { return await index.search(query, documents, lexical); }
    catch {
      extractorPromise = undefined;
      retryAt = Date.now() + 60000;
      return lexical;
    }
  };
}

export class SemanticTaskIndex {
  constructor({ embed, cacheFile, modelKey, dimensions = 384 }) {
    this.embed = embed;
    this.cacheFile = cacheFile;
    this.modelKey = modelKey;
    this.dimensions = dimensions;
    this.vectors = new Map();
    this.queries = new Map();
    this.queue = Promise.resolve();
    this.loaded = false;
  }

  normalize(vector) {
    if (!Array.isArray(vector) || vector.length !== this.dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid task embedding');
    const norm = Math.hypot(...vector);
    if (!norm) throw new Error('Empty task embedding');
    return vector.map(value => value / norm);
  }

  search(query, documents, lexical) {
    const pending = this.queue.then(() => this.rank(query, documents, lexical));
    this.queue = pending.catch(() => {});
    return pending;
  }

  async rank(query, documents, lexical) {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const saved = JSON.parse(await readFile(this.cacheFile, 'utf8'));
        if (saved.modelKey === this.modelKey && Array.isArray(saved.vectors)) {
          for (const record of saved.vectors) {
            if (typeof record.id === 'string' && typeof record.hash === 'string') this.vectors.set(record.id, { hash: record.hash, vector: this.normalize(record.vector) });
          }
        }
      } catch { this.vectors.clear(); }
    }
    const next = new Map();
    const missing = [];
    for (const document of documents) {
      const hash = createHash('sha256').update(document.text).digest('hex');
      const cached = this.vectors.get(document.id);
      if (cached?.hash === hash) next.set(document.id, cached);
      else missing.push({ ...document, hash });
    }
    for (let offset = 0; offset < missing.length; offset += 8) {
      const batch = missing.slice(offset, offset + 8);
      const vectors = await this.embed(batch.map(document => document.text));
      if (vectors.length !== batch.length) throw new Error('Incomplete task embeddings');
      for (const [index, document] of batch.entries()) next.set(document.id, { hash: document.hash, vector: this.normalize(vectors[index]) });
    }
    const changed = missing.length > 0 || next.size !== this.vectors.size;
    this.vectors = next;
    if (changed) {
      try {
        await mkdir(path.dirname(this.cacheFile), { recursive: true });
        await writeFile(`${this.cacheFile}.tmp`, JSON.stringify({ modelKey: this.modelKey, vectors: [...next].map(([id, record]) => ({ id, ...record })) }));
        await rename(`${this.cacheFile}.tmp`, this.cacheFile);
      } catch {}
    }
    let queryVector = this.queries.get(query);
    if (!queryVector) {
      queryVector = this.normalize((await this.embed([query]))[0]);
      this.queries.set(query, queryVector);
      if (this.queries.size > 32) this.queries.delete(this.queries.keys().next().value);
    }
    const similarities = new Map([...next].map(([id, { vector }]) => [id, vector.reduce((sum, value, index) => sum + value * queryVector[index], 0)]));
    const best = Math.max(0, ...similarities.values());
    const scores = new Map(lexical.map((match, index) => [match.id, 1 / (index + 1)]));
    return documents
      .filter(document => scores.has(document.id) || (similarities.get(document.id) >= 0.35 && similarities.get(document.id) >= best - 0.1))
      .map(document => ({ id: document.id, score: (scores.get(document.id) || 0) * 0.4 + similarities.get(document.id) * 0.6 }))
      .sort((left, right) => right.score - left.score);
  }
}