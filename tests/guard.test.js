/**
 * Guard unit tests — the mismatch guard is the capstone's safety core, so its
 * rules get their own file. Pure functions, no database.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGuard, canonicalizeSpecies, RULES } = require('../src/services/guard');

const CFG = { similarityThreshold: 0.5, lowConfidenceThreshold: 0.6 };
const FOX_POST = { id: 'p-fox-1', title: 'The red fox at dusk', body: 'red fox hunting mice', speciesHint: 'red fox' };

const meta = (over = {}) => ({
  subject: 'red fox', category: 'animal', caption: 'A red fox in a field.',
  attributes: ['orange fur'], confidence: 0.95, schemaValid: true, ...over,
});
const cand = (over = {}) => ({ id: 'img-1', metadata: meta(), score: 0.9, ...over });

test('canonicalizeSpecies collapses scientific and common names to one species', () => {
  assert.equal(canonicalizeSpecies('Vulpes vulpes'), 'red fox');
  assert.equal(canonicalizeSpecies('red fox'), 'red fox');
  assert.equal(canonicalizeSpecies('Canis lupus'), 'gray wolf');
  assert.equal(canonicalizeSpecies('grey wolf'), 'gray wolf');
  assert.equal(canonicalizeSpecies('Canis familiaris'), 'dog');
  assert.equal(canonicalizeSpecies('puppy'), 'dog');
  assert.equal(canonicalizeSpecies('brown bear'), 'bear');
  assert.equal(canonicalizeSpecies('white-tailed deer'), 'deer');
  assert.equal(canonicalizeSpecies('snow leopard'), null); // unknown species: no alias, guard cannot prove a mismatch
  assert.equal(canonicalizeSpecies(''), null);
});

test('approves a same-species, above-threshold, confident candidate', () => {
  const r = evaluateGuard({ post: FOX_POST, candidate: cand(), config: CFG });
  assert.equal(r.verdict, 'approve');
  assert.equal(r.rule, null);
  assert.match(r.reason, /red fox/);
  assert.match(r.reason, /0\.900/);
});

test('rejects wolf-on-fox-post as species_mismatch with a human-readable reason', () => {
  const r = evaluateGuard({ post: FOX_POST, candidate: cand({ metadata: meta({ subject: 'gray wolf' }) }), config: CFG });
  assert.equal(r.verdict, 'reject');
  assert.equal(r.rule, 'species_mismatch');
  assert.match(r.reason, /red fox/);
  assert.match(r.reason, /gray wolf/);
});

test('"Vulpes vulpes" on a Vulpes-vulpes post is a match, not a mismatch (canonicalization)', () => {
  const post = { ...FOX_POST, speciesHint: 'Vulpes vulpes' };
  const r = evaluateGuard({ post, candidate: cand({ metadata: meta({ subject: 'Vulpes vulpes' }) }), config: CFG });
  assert.equal(r.verdict, 'approve');
});

test('rejects below-threshold similarity even for the right species', () => {
  const r = evaluateGuard({ post: FOX_POST, candidate: cand({ score: 0.2 }), config: CFG });
  assert.equal(r.verdict, 'reject');
  assert.equal(r.rule, 'below_threshold');
  assert.match(r.reason, /0\.200 vs threshold 0\.5/);
});

test('rejects low vision confidence', () => {
  const r = evaluateGuard({ post: FOX_POST, candidate: cand({ metadata: meta({ confidence: 0.3 }) }), config: CFG });
  assert.equal(r.verdict, 'reject');
  assert.equal(r.rule, 'low_confidence');
});

test('never trusts unvalidated model output (highest-severity rule)', () => {
  const r = evaluateGuard({ post: FOX_POST, candidate: cand({ metadata: { subject: 'red fox', caption: 'x' } }), config: CFG });
  assert.equal(r.verdict, 'reject');
  assert.equal(r.rule, 'unvalidated_output');
});

test('severity ordering: species_mismatch beats below_threshold beats low_confidence', () => {
  const wolfLowScore = evaluateGuard({ post: FOX_POST, candidate: cand({ metadata: meta({ subject: 'gray wolf' }), score: 0.1 }), config: CFG });
  assert.equal(wolfLowScore.rule, 'species_mismatch');
  const foxLowAll = evaluateGuard({ post: FOX_POST, candidate: cand({ score: 0.1, metadata: meta({ confidence: 0.2 }) }), config: CFG });
  assert.equal(foxLowAll.rule, 'below_threshold'); // same species: mismatch passes, threshold fires first
});

test('inspect-why gets the full 4-rule trace, every rule evaluated', () => {
  const r = evaluateGuard({ post: FOX_POST, candidate: cand({ metadata: meta({ subject: 'gray wolf' }) }), config: CFG });
  assert.deepEqual(r.trace.map((t) => t.rule), RULES);
  assert.ok(r.trace.every((t) => typeof t.pass === 'boolean'));
  assert.ok(r.trace.every((t) => typeof t.detail === 'string' && t.detail.length > 0));
});

test('post without a species signal skips the mismatch rule instead of guessing', () => {
  const post = { id: 'p-x', title: 'Morning light', body: 'A beautiful morning.', speciesHint: null };
  const r = evaluateGuard({ post, candidate: cand({ metadata: meta({ subject: 'gray wolf' }) }), config: CFG });
  const speciesRule = r.trace.find((t) => t.rule === 'species_mismatch');
  assert.equal(speciesRule.pass, true); // no species signal -> cannot prove mismatch -> pass
  assert.equal(r.verdict, 'approve'); // score 0.9 and confidence 0.95 still clear
});
