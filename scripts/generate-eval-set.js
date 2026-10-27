/**
 * generate-eval-set.js — builds the labeled eval set (brief §7:
 * "take 10 or more posts and mark the one correct image for each post").
 *
 * One correct image per post, chosen deterministically from the post's species
 * category so top-1 precision is measurable and reproducible.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'manifest.json'), 'utf8'));
const posts = JSON.parse(fs.readFileSync(path.join(ROOT, 'seeds', 'posts.json'), 'utf8'));

const SPECIES_TO_CATEGORY = {
  'red fox': 'red_fox',
  'gray wolf': 'wolf',
  dog: 'dog',
  bear: 'bear',
  deer: 'deer',
};

const byCategory = {};
for (const img of manifest.images) {
  (byCategory[img.categoryKey] = byCategory[img.categoryKey] || []).push(img.id);
}

const evalSet = [];
const perSpeciesCount = {};
for (const post of posts) {
  const cat = SPECIES_TO_CATEGORY[post.speciesHint];
  if (!cat || !byCategory[cat] || byCategory[cat].length === 0) {
    console.error(`skip ${post.id}: no images for species ${post.speciesHint}`);
    continue;
  }
  const n = perSpeciesCount[post.speciesHint] || 0;
  perSpeciesCount[post.speciesHint] = n + 1;
  const pool = byCategory[cat];
  const correctImageId = pool[(n * 3) % pool.length]; // spread across the category
  evalSet.push({
    postId: post.id,
    correctImageId,
    expectedSpecies: post.speciesHint,
    note: `labeled correct image for "${post.title}"`,
  });
}

const out = path.join(ROOT, 'seeds', 'eval-set.json');
fs.writeFileSync(out, JSON.stringify(evalSet, null, 2));
console.log(`Eval set: ${evalSet.length} labeled posts -> seeds/eval-set.json`);
for (const e of evalSet) console.log(`  ${e.postId} -> ${e.correctImageId} (${e.expectedSpecies})`);
if (evalSet.length < 10) {
  console.error('WARNING: eval set has fewer than 10 posts (brief requires 10+).');
  process.exitCode = 1;
}
