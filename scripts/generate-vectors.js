/**
 * generate-vectors.js — embeds every image caption and every post text with
 * the configured embedding provider (default: local Ollama, $0, keyless) and
 * COMMITS the vectors to data/vectors/*.json so the evaluator runs keyless
 * (EMBEDDING_PROVIDER=cache reads exactly these files).
 *
 * Text recipe (must match src/jobs/batchJob.js — the embed job uses the same):
 *   image: "<caption> <attr1>, <attr2>, ..."
 *   post:  "<title>. <body>"
 *
 * Vectors are L2-normalized before storage, so cosine = dot product.
 *
 * Also prints an in-process eval preview: for each labeled eval post, rank all
 * image texts by raw cosine and report whether the labeled image is top-1
 * (pre-guard). This is the honest model/margin check before anything is
 * persisted — and the basis for the SIMILARITY_THRESHOLD defense.
 *
 * Usage: EMBEDDING_PROVIDER=ollama OLLAMA_EMBEDDING_MODEL=all-minilm node scripts/generate-vectors.js
 */
const fs = require('fs');
const path = require('path');

require('../src/config');
const { getEmbeddingProvider } = require('../src/providers/embeddings');
const { l2Normalize, cosine } = require('../src/services/vectors');

const ROOT = path.join(__dirname, '..');
const VECTORS_DIR = path.join(ROOT, 'data', 'vectors');
const BATCH = 16;

function imageText(fixture) {
  return `${fixture.caption} ${fixture.attributes.join(', ')}`;
}
function postText(p) {
  return `${p.title}. ${p.body}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embedChunkWithRetries(provider, chunk) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await provider.embedBatch(chunk);
    } catch (e) {
      console.error(`[vectors] batch failed (attempt ${attempt}/3): ${e.message}`);
      lastErr = e;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

async function embedAll(provider, items) {
  const vectors = {};
  for (let start = 0; start < items.length; start += BATCH) {
    const chunk = items.slice(start, start + BATCH);
    const rows = await embedChunkWithRetries(provider, chunk);
    for (const row of rows) vectors[row.key] = row.vector;
    process.stdout.write(`[vectors] ${Math.min(start + BATCH, items.length)}/${items.length}\n`);
  }
  return vectors;
}

(async () => {
  const provider = getEmbeddingProvider(process.env);
  if (provider.name === 'cache') {
    console.error('EMBEDDING_PROVIDER=cache has nothing to generate. Use ollama or hf, e.g.:');
    console.error('  EMBEDDING_PROVIDER=ollama OLLAMA_EMBEDDING_MODEL=all-minilm node scripts/generate-vectors.js');
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'manifest.json'), 'utf8'));
  const fixturesDir = path.join(ROOT, 'data', 'fixtures', 'vision');
  const posts = JSON.parse(fs.readFileSync(path.join(ROOT, 'seeds', 'posts.json'), 'utf8'));

  const imageItems = [];
  for (const img of manifest.images) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, `${img.id}.json`), 'utf8'));
    imageItems.push({ key: img.id, text: imageText(fixture) });
  }
  const postItems = posts.map((p) => ({ key: p.id, text: postText(p) }));

  console.log(`[vectors] provider=${provider.name} model=${provider.model}`);
  console.log(`[vectors] embedding ${imageItems.length} image texts + ${postItems.length} post texts`);

  const imageVectors = await embedAll(provider, imageItems);
  const postVectors = await embedAll(provider, postItems);

  fs.mkdirSync(VECTORS_DIR, { recursive: true });
  const meta = {
    model: provider.model,
    dim: imageVectors[manifest.images[0].id].length,
    provider: provider.name,
    recipe: 'image: "<caption> <attributes joined by comma>"; post: "<title>. <body>"; vectors L2-normalized; cosine = dot product',
    generatedAt: new Date().toISOString(),
    source: 'local Ollama REST /api/embed (keyless, $0) — see BUILDLOG.md for why HF Inference was not used (HTTP 402 no credits)',
  };
  fs.writeFileSync(path.join(VECTORS_DIR, 'images.json'), JSON.stringify({ ...meta, vectors: imageVectors }, null, 1));
  fs.writeFileSync(path.join(VECTORS_DIR, 'posts.json'), JSON.stringify({ ...meta, vectors: postVectors }, null, 1));
  console.log(`[vectors] wrote data/vectors/images.json (${Object.keys(imageVectors).length}) and posts.json (${Object.keys(postVectors).length})`);

  // ---- in-process eval preview (raw cosine, pre-guard) ----
  const evalSet = JSON.parse(fs.readFileSync(path.join(ROOT, 'seeds', 'eval-set.json'), 'utf8'));
  const postVec = postVectors;
  let top1 = 0;
  const rows = [];
  for (const e of evalSet) {
    const pv = postVec[e.postId];
    let best = null;
    for (const img of manifest.images) {
      const s = cosine(pv, imageVectors[img.id]);
      if (!best || s > best.score) best = { id: img.id, score: s };
    }
    const ok = best && best.id === e.correctImageId;
    if (ok) top1++;
    rows.push({ post: e.postId, expected: e.correctImageId, got: best.id, score: Number(best.score.toFixed(4)), ok });
  }
  console.log('\n=== eval preview (raw cosine top-1, pre-guard) ===');
  for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.post} expected=${r.expected} got=${r.got} score=${r.score}`);
  console.log(`\npreview top-1: ${top1}/${evalSet.length} = ${(top1 / evalSet.length).toFixed(3)}`);

  // ---- species-separation sanity (the brief's concept-match example) ----
  const foxPost = postItems.find((p) => p.key === 'p-fox-1');
  if (foxPost && imageVectors['img-red_fox-00'] && imageVectors['img-wolf-00']) {
    const fv = postVec['p-fox-1'];
    console.log('\n=== concept-match sanity ("red fox" vs "Vulpes vulpes" vs wolf) ===');
    console.log('cos(fox post, fox image) =', cosine(fv, imageVectors['img-red_fox-00']).toFixed(4));
    console.log('cos(fox post, wolf image) =', cosine(fv, imageVectors['img-wolf-00']).toFixed(4));
    console.log('cos(fox post, dog image) =', cosine(fv, imageVectors['img-dog-00']).toFixed(4));
  }
})().catch((e) => {
  console.error('VECTOR GENERATION FAILED:', e);
  process.exitCode = 1;
});
