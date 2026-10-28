/**
 * Tagging service tests — the brief's core reliability rule: vision output is
 * Zod-validated; invalid output is NEVER trusted (retried, then flagged).
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, repos } = require('./helpers');
const { processVisionResponse } = require('../src/services/tagging');
const { validateVisionOutput } = require('../src/schema/vision');

before(async () => {
  const counts = await setupTestDb();
  assert.equal(counts.images, 56);
  assert.equal(counts.metadata, 56);
});

test('Zod schema rejects incomplete vision output', () => {
  const v = validateVisionOutput({ subject: 'fox' });
  assert.equal(v.ok, false);
  assert.match(v.error, /category|attributes|caption|confidence/i);
});

test('Zod schema rejects out-of-range confidence and bad category', () => {
  assert.equal(validateVisionOutput({ subject: 'a', category: 'animal', attributes: ['x'], caption: 'long enough caption', confidence: 1.5 }).ok, false);
  assert.equal(validateVisionOutput({ subject: 'a', category: 'vehicle', attributes: ['x'], caption: 'long enough caption', confidence: 0.5 }).ok, false);
  assert.equal(validateVisionOutput({ subject: 'a', category: 'animal', attributes: [], caption: 'long enough caption', confidence: 0.5 }).ok, false);
  assert.equal(validateVisionOutput({ subject: 'a', category: 'animal', attributes: ['x'], caption: 'short', confidence: 0.5 }).ok, false);
});

test('invalid vision output throws SCHEMA_INVALID and never overwrites trusted metadata', () => {
  const before = repos.getMetadata('img-red_fox-00');
  assert.ok(before, 'setup should have tagged this image');
  assert.throws(
    () => processVisionResponse('img-red_fox-00', { subject: 'nope' }),
    (e) => e.code === 'SCHEMA_INVALID'
  );
  const after = repos.getMetadata('img-red_fox-00');
  assert.equal(after.subject, before.subject);
  assert.equal(after.confidence, before.confidence);
});

test('valid vision output is persisted: metadata + tags + status=tagged', () => {
  const raw = {
    subject: 'red fox', category: 'animal',
    attributes: ['orange fur', 'wild'],
    caption: 'A red fox in a snowy field at dusk.',
    confidence: 0.91,
  };
  const { metadata, flagged } = processVisionResponse('img-red_fox-00', raw);
  assert.equal(flagged, false);
  assert.equal(metadata.subject, 'red fox');

  const m = repos.getMetadata('img-red_fox-00');
  assert.equal(m.subject, 'red fox');
  assert.equal(m.schema_valid, 1);
  assert.ok(m.raw_json.includes('A red fox in a snowy field'));

  const tags = repos.tagsForImage('img-red_fox-00').map((t) => `${t.tag_type}:${t.tag}`);
  assert.ok(tags.includes('subject:red fox'));
  assert.ok(tags.includes('category:animal'));
  assert.ok(tags.includes('attribute:orange fur'));

  const img = repos.getImage('img-red_fox-00');
  assert.equal(img.status, 'tagged');
  assert.equal(img.low_confidence, 0);
});

test('low-confidence output is FLAGGED, not silently accepted', () => {
  processVisionResponse('img-red_fox-00', {
    subject: 'red fox', category: 'animal', attributes: ['orange'],
    caption: 'A red fox, species uncertain.', confidence: 0.3,
  });
  const img = repos.getImage('img-red_fox-00');
  assert.equal(img.status, 'flagged');
  assert.equal(img.low_confidence, 1);
});

test('confidence exactly at the floor is NOT flagged (>= comparison)', () => {
  processVisionResponse('img-red_fox-00', {
    subject: 'red fox', category: 'animal', attributes: ['orange'],
    caption: 'A red fox, borderline certainty.', confidence: 0.6,
  });
  const img = repos.getImage('img-red_fox-00');
  assert.equal(img.status, 'tagged');
  assert.equal(img.low_confidence, 0);
});
