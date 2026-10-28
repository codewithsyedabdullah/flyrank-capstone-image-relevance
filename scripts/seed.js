/**
 * seed.js — CLI + exported helper: load the corpus manifest (images) and
 * seeds/posts.json into the database. Idempotent (upserts). Does NOT
 * download images (scripts/fetch-corpus.js does that) and does NOT run AI
 * jobs (npm run tag / npm run embed — or npm run bootstrap for everything).
 */
require('../src/config');
const { seedDatabase } = require('../src/services/provision');

function seed() {
  return seedDatabase();
}

if (require.main === module) {
  const r = seed();
  console.log(`seeded: ${r.images} images (status=pending), ${r.posts} posts, tenant="${r.tenant}"`);
  console.log('next: npm run tag   (vision batch job)');
  console.log('      npm run embed (embedding batch job)');
  console.log('      npm run eval  (top-1 precision on the labeled set)');
  console.log('  or: npm run bootstrap (seed + tag + embed + eval, one process)');
}

module.exports = { seed };
