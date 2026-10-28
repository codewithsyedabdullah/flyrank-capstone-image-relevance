/**
 * Vector tests — normalization math + the committed all-minilm vectors that
 * make the evaluator run keyless. The concept-separation test uses the REAL
 * committed vectors (fox post vs fox/wolf/dog images), so it fails if the
 * recipe or the model identity ever drifts.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { l2Normalize, cosine } = require('../src/services/vectors');

const ROOT = path.join(__dirname, '..');
const imgVecs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vectors/images.json'), 'utf8')).vectors;
const postVecs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/vectors/posts.json'), 'utf8')).vectors;

test('l2Normalize produces unit vectors; zero vector stays zero', () => {
  const v = l2Normalize([3, 4]);
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-12);
  assert.deepEqual(l2Normalize([0, 0]), [0, 0]);
});

test('cosine returns 0 for empty or mismatched vectors', () => {
  assert.equal(cosine([], [1]), 0);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0);
  assert.equal(cosine(null, [1]), 0);
});

test('committed vectors: 56 images + 16 posts, 384-dim, all-minilm identity', () => {
  assert.equal(Object.keys(imgVecs).length, 56);
  assert.equal(Object.keys(postVecs).length, 16);
  assert.equal(imgVecs['img-red_fox-00'].length, 384);
  assert.equal(postVecs['p-fox-1'].length, 384);
});

test('committed vectors are L2-normalized (cosine = dot product is valid)', () => {
  for (const key of ['img-red_fox-00', 'img-wolf-00', 'p-fox-1']) {
    const v = imgVecs[key] || postVecs[key];
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, `${key} not normalized: norm=${norm}`);
  }
});

test('CONCEPT MATCH: fox post vector is much closer to fox image than wolf/dog', () => {
  const foxPost = postVecs['p-fox-1'];
  const fox = cosine(foxPost, imgVecs['img-red_fox-07']);
  const wolf = cosine(foxPost, imgVecs['img-wolf-00']);
  const dog = cosine(foxPost, imgVecs['img-dog-00']);
  assert.ok(fox > 0.7, `fox self-similarity too low: ${fox}`);
  assert.ok(fox > wolf + 0.2, `fox/wolf margin too thin: fox=${fox} wolf=${wolf}`);
  assert.ok(fox > dog + 0.2, `fox/dog margin too thin: fox=${fox} dog=${dog}`);
});

test('the brief\'s example works: "Vulpes vulpes" post text matches the red fox photo', () => {
  // p-fox-2's body literally contains "Vulpes vulpes"; its labeled image is a fox.
  const v = postVecs['p-fox-2'];
  assert.ok(v, 'p-fox-2 vector committed');
  const fox = cosine(v, imgVecs['img-red_fox-03']);
  const wolf = cosine(v, imgVecs['img-wolf-00']);
  assert.ok(fox > wolf + 0.2, `Vulpes vulpes should match fox photo, not wolf: fox=${fox} wolf=${wolf}`);
});
