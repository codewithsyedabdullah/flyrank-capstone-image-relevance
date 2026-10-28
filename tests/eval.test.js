/**
 * Eval-pipeline tests (brief §2): the labeled eval set must score top-1
 * precision 1.0, the fox/wolf/dog boundary must hold with real margins, and
 * out-of-corpus posts must refuse honestly.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupTestDb } = require('./helpers');
const matching = require('../src/services/matching');
const { runEval } = require('../scripts/eval');

const ROOT = path.join(__dirname, '..');
const evalSet = JSON.parse(fs.readFileSync(path.join(ROOT, 'seeds', 'eval-set.json'), 'utf8'));

before(async () => {
  const counts = await setupTestDb();
  assert.equal(counts.images, 56);
  assert.ok(evalSet.length === 15, 'labeled eval set has 15 posts');
});

test('all 15 labeled posts rank their labeled image top-1 (guard-approved)', () => {
  for (const e of evalSet) {
    const r = matching.rankImagesForPost(e.postId, { top: 1 });
    assert.ok(r.match, `${e.postId} refused every candidate`);
    assert.equal(r.match.imageId, e.correctImageId, `${e.postId} top-1 must be the labeled image`);
  }
});

test('runEval reports precision 1.0 and a threshold inside the tuned band', async () => {
  const report = await runEval({ persist: false });
  assert.equal(report.correct, 15);
  assert.equal(report.total, 15);
  assert.equal(report.top1_precision, 1);
  assert.ok(report.per_post.every((r) => r.ok), 'every per-post row correct');
  assert.ok(report.band[0] >= 0.3 && report.band[1] <= 0.8, `band ${report.band} sane`);
  assert.ok(report.threshold >= report.band[0] && report.threshold <= report.band[1]);
});

test('fox post beats forced wolf and dog by >0.3 cosine — both rejected species_mismatch', () => {
  const fox = matching.rankImagesForPost('p-fox-1', { top: 5, forceImageId: 'img-wolf-00' });
  assert.ok(fox.match.imageId.startsWith('img-red_fox-'), `fox post matched ${fox.match.imageId}`);
  assert.equal(fox.match.subject, 'red fox');

  const wolf = fox.candidates.find((c) => c.imageId === 'img-wolf-00');
  assert.ok(wolf, 'forced wolf visible in response');
  assert.equal(wolf.verdict, 'reject');
  assert.equal(wolf.rule, 'species_mismatch');
  assert.match(wolf.reason, /red fox/);
  assert.match(wolf.reason, /gray wolf/);
  assert.ok(fox.match.score - wolf.score > 0.3, `fox/wolf margin too thin: ${fox.match.score} vs ${wolf.score}`);

  const dog = matching.rankImagesForPost('p-fox-1', { top: 5, forceImageId: 'img-dog-00' });
  const dogRow = dog.candidates.find((c) => c.imageId === 'img-dog-00');
  assert.equal(dogRow.verdict, 'reject');
  assert.equal(dogRow.rule, 'species_mismatch');
  assert.ok(dog.match.score - dogRow.score > 0.3, `fox/dog margin too thin: ${dog.match.score} vs ${dogRow.score}`);
});

test('the brief\'s example: a "Vulpes vulpes" post matches the red fox photo', () => {
  const e = evalSet.find((x) => x.postId === 'p-fox-2');
  assert.ok(e, 'p-fox-2 present in eval set');
  const r = matching.rankImagesForPost('p-fox-2', { top: 1 });
  assert.equal(r.match.imageId, e.correctImageId);
  assert.equal(r.match.subject, 'red fox');
});

test('out-of-corpus post refuses honestly: no_confident_match + per-candidate reasons', () => {
  const r = matching.rankImagesForPost('p-other-1', { top: 3 });
  assert.equal(r.verdict, 'no_confident_match');
  assert.equal(r.match, null, 'no guessed best-effort image');
  assert.ok(r.reasons.length >= 1, 'refusal comes with reasons');
  assert.ok(r.reasons.every((x) => x.imageId && typeof x.score === 'number' && x.rule && x.reason));
  assert.ok(r.reasons.some((x) => x.rule === 'below_threshold'), 'at least one below_threshold reason');
});
