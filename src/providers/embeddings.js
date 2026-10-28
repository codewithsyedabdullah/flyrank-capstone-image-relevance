/**
 * Embedding providers — same interface, three implementations.
 *
 *   embedBatch(items: [{key, text}]) -> [{key, vector}]  (vectors L2-normalized)
 *
 * - CacheEmbeddingProvider (default): reads the committed vectors in
 *   data/vectors/*.json. Keyless, instant, fully reproducible for the
 *   evaluator. The vectors were generated ONCE by a real model (local Ollama —
 *   see scripts/generate-vectors.js and BUILDLOG.md for why HF Inference was
 *   not used: our account returned HTTP 402 "no remaining credits").
 * - OllamaEmbeddingProvider: local regeneration via POST /api/embed ($0).
 * - HFEmbeddingProvider: Hugging Face Inference router (router.huggingface.co;
 *   the legacy api-inference host is decommissioned). Requires an account with
 *   inference credits.
 *
 * Vector identity: the embedding MODEL recorded in the DB is
 * config.embeddingModel (env EMBEDDING_MODEL). All providers expose .model so
 * the embed job writes rows under the same identity the matcher queries.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { l2Normalize } = require('../services/vectors');

const ROOT = path.join(__dirname, '..', '..');

class CacheEmbeddingProvider {
  constructor() {
    this.name = 'cache';
    // Identity comes from env (single source of truth shared with the embed
    // job and the matcher); the file's model field is provenance metadata.
    this.model = config.embeddingModel;
    this.priceUsdPerCall = 0;
    let images, posts;
    try {
      images = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'vectors', 'images.json'), 'utf8'));
      posts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'vectors', 'posts.json'), 'utf8'));
    } catch (e) {
      const err = new Error(
        'committed vectors missing (data/vectors/*.json). Generate them first: ' +
        'EMBEDDING_PROVIDER=ollama node scripts/generate-vectors.js — or npm run embed with EMBEDDING_PROVIDER=ollama'
      );
      err.code = 'CACHE_MISSING';
      throw err;
    }
    this.byKey = { ...(images.vectors || {}), ...(posts.vectors || {}) };
    this.fileModel = images.model || posts.model || null;
  }

  async embedBatch(items) {
    const out = [];
    for (const item of items) {
      const v = this.byKey[item.key];
      if (!v) {
        const err = new Error(`no committed vector for ${item.key} — regenerate with EMBEDDING_PROVIDER=ollama`);
        err.code = 'CACHE_MISS';
        throw err;
      }
      out.push({ key: item.key, vector: v, cached: true });
    }
    return out;
  }
}

class OllamaEmbeddingProvider {
  constructor(host = process.env.OLLAMA_HOST || 'http://localhost:11434', model = process.env.OLLAMA_EMBEDDING_MODEL || 'all-minilm') {
    this.host = host.replace(/\/$/, '');
    this.model = model;
    this.name = 'ollama';
    this.priceUsdPerCall = 0; // local model, no API spend
  }

  async embedBatch(items) {
    const res = await fetch(`${this.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: this.model, input: items.map((i) => i.text) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.code = 'PROVIDER_HTTP';
      throw err;
    }
    const json = await res.json();
    const vectors = json.embeddings || [];
    if (vectors.length !== items.length) throw new Error('ollama returned wrong vector count');
    return items.map((item, i) => ({ key: item.key, vector: l2Normalize(vectors[i]), cached: false }));
  }
}

class HFEmbeddingProvider {
  constructor(token = process.env.HF_TOKEN, model = process.env.EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2') {
    if (!token) throw new Error('HF_TOKEN required for EMBEDDING_PROVIDER=hf');
    this.token = token;
    this.model = model;
    this.name = 'hf';
    this.priceUsdPerCall = 0.00005; // documented list-price estimate per inference request
  }

  async embedBatch(items) {
    const res = await fetch(`https://router.huggingface.co/hf-inference/models/${this.model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ inputs: items.map((i) => i.text) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`hf HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.code = 'PROVIDER_HTTP';
      throw err;
    }
    const vectors = await res.json();
    return items.map((item, i) => ({ key: item.key, vector: l2Normalize(vectors[i]), cached: false }));
  }
}

function getEmbeddingProvider(env = process.env) {
  const provider = (env.EMBEDDING_PROVIDER || 'cache').toLowerCase();
  if (provider === 'cache') return new CacheEmbeddingProvider();
  if (provider === 'ollama') return new OllamaEmbeddingProvider();
  if (provider === 'hf') return new HFEmbeddingProvider();
  throw new Error(`unknown EMBEDDING_PROVIDER "${provider}" (expected cache|ollama|hf)`);
}

module.exports = { getEmbeddingProvider, CacheEmbeddingProvider, OllamaEmbeddingProvider, HFEmbeddingProvider };
