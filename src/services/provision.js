/**
 * provision.js — first-boot self-provisioning.
 *
 * Why: the corpus, fixtures and committed vectors are all in the repo, so a
 * fresh clone (or a wiped database directory) can reach a fully working state
 * with zero manual steps. `npm run bootstrap` runs the whole chain as one
 * process; the server calls provision() on boot so `npm start` works against
 * an empty database too.
 *
 * Safety: auto-tagging only runs when the vision provider is zero-cost
 * (fixture) or AUTO_PROVISION=1 is set explicitly; auto-embedding only for
 * cache/ollama providers. With a paid provider (gemini/hf) and an empty DB,
 * boot logs instructions instead of spending money.
 */
const fs = require('fs');
const path = require('path');
const { migrate } = require('../db/migrate');
const repos = require('../repositories');
const config = require('../config');
const { runTagJobCli, runEmbedJobCli } = require('../jobs/batchJob');

const ROOT = path.join(__dirname, '..', '..');

/** Load the corpus manifest + seed posts into the database (idempotent). */
function seedDatabase({ manifestPath, postsPath } = {}) {
  migrate();
  repos.ensureTenant(config.tenantId);
  const manifest = JSON.parse(fs.readFileSync(manifestPath || path.join(ROOT, 'data', 'manifest.json'), 'utf8'));
  let images = 0;
  for (const img of manifest.images) {
    repos.upsertImage(img);
    images++;
  }
  const posts = JSON.parse(fs.readFileSync(postsPath || path.join(ROOT, 'seeds', 'posts.json'), 'utf8'));
  let postCount = 0;
  for (const p of posts) {
    repos.upsertPost(p);
    postCount++;
  }
  return { images, posts: postCount, tenant: config.tenantId };
}

/**
 * Bring an empty database to a working state: seed → tag → embed.
 * Skips each step that is already done (idempotent). Returns final counts.
 */
async function provision() {
  migrate();
  let counts = repos.healthCounts();
  if (counts.images === 0) {
    console.log('[provision] database empty — seeding corpus (56 images, 16 posts)');
    seedDatabase();
    counts = repos.healthCounts();
  }
  const visionZeroCost = config.visionProvider === 'fixture' || process.env.AUTO_PROVISION === '1';
  if (counts.metadata === 0) {
    if (visionZeroCost) {
      console.log('[provision] no vision metadata — running tag job (fixture vision, $0)');
      await runTagJobCli();
    } else {
      console.log('[provision] database has no vision metadata and VISION_PROVIDER is not zero-cost.');
      console.log('[provision] run `npm run bootstrap` to tag the corpus, or set AUTO_PROVISION=1 to allow paid tagging on boot.');
    }
    counts = repos.healthCounts();
  }
  const embedZeroCost = ['cache', 'ollama'].includes(config.embeddingProvider) || process.env.AUTO_PROVISION === '1';
  if (counts.embeddings === 0) {
    if (embedZeroCost) {
      console.log('[provision] no embeddings — running embed job (provider=' + config.embeddingProvider + ')');
      await runEmbedJobCli();
    } else {
      console.log('[provision] database has no embeddings and EMBEDDING_PROVIDER is not zero-cost; run `npm run embed`.');
    }
    counts = repos.healthCounts();
  }
  return counts;
}

module.exports = { provision, seedDatabase };
