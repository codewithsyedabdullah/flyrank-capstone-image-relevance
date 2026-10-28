/**
 * guard.js — the mismatch guard. Its own module on purpose (brief §1:
 * "Build the guard as its own small module first; the capstone builds the
 * whole system around it").
 *
 * Input: a post, one candidate image (with validated metadata + cosine score),
 * and tuned thresholds. Output: approve | reject with a human-readable reason,
 * plus a full rule trace for the inspect-why endpoint.
 *
 * Rules run in order of severity; every rule is evaluated so the trace can
 * explain the whole decision path, not just the first failure.
 */

// Corpus-scoped species canonicalization. Scientific names and common names
// collapse to one canonical species so "Vulpes vulpes" === "red fox".
const SPECIES_ALIASES = [
  // longest first so multi-word aliases win
  ['canis familiaris', 'dog'],
  ['vulpes vulpes', 'red fox'],
  ['canis lupus', 'gray wolf'],
  ['gray wolf', 'gray wolf'],
  ['grey wolf', 'gray wolf'],
  ['red fox', 'red fox'],
  ['brown bear', 'bear'],
  ['domestic dog', 'dog'],
  ['cervidae', 'deer'],
  ['wolf', 'gray wolf'],
  ['fox', 'red fox'],
  ['dog', 'dog'],
  ['puppy', 'dog'],
  ['puppies', 'dog'],
  ['bear', 'bear'],
  ['deer', 'deer'],
  ['stag', 'deer'],
  ['elk', 'deer'],
];

function canonicalizeSpecies(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const [alias, canonical] of SPECIES_ALIASES) {
    if (t.includes(alias)) return canonical;
  }
  return null;
}

const RULES = ['unvalidated_output', 'species_mismatch', 'below_threshold', 'low_confidence'];

/**
 * @param {object} ctx
 * @param {{id:string, title:string, body:string, speciesHint?:string}} ctx.post
 * @param {{id:string, metadata?:object, score:number}} ctx.candidate
 * @param {{similarityThreshold:number, lowConfidenceThreshold:number}} ctx.config
 * @returns {{verdict:'approve'|'reject', rule:string|null, reason:string, trace:Array}}
 */
function evaluateGuard(ctx) {
  const { post, candidate, config } = ctx;
  const meta = candidate.metadata || {};
  const trace = [];

  // Rule 1 — never trust unvalidated model output.
  // Boolean() so the trace field is a real boolean (&& would otherwise leak
  // the caption string as the last truthy operand).
  const schemaValid = Boolean(meta.schemaValid === true && meta.subject && meta.caption);
  trace.push({
    rule: 'unvalidated_output',
    pass: schemaValid,
    detail: schemaValid
      ? 'vision output passed schema validation'
      : 'vision output failed schema validation — never trusted',
  });

  // Rule 2 — species mismatch (the wolf-on-the-fox-post case).
  const expected = canonicalizeSpecies(post.speciesHint || `${post.title} ${post.body}`);
  const detected = canonicalizeSpecies(meta.subject);
  const speciesPass = !(expected && detected && expected !== detected);
  trace.push({
    rule: 'species_mismatch',
    pass: speciesPass,
    detail: speciesPass
      ? expected
        ? `species compatible (expected ${expected}, detected ${detected || 'unknown'})`
        : 'no species signal on post — rule skipped'
      : `Animal category mismatch: expected ${expected}, detected ${detected}`,
  });

  // Rule 3 — semantic similarity threshold.
  const score = Number.isFinite(candidate.score) ? candidate.score : 0;
  const simPass = score >= config.similarityThreshold;
  trace.push({
    rule: 'below_threshold',
    pass: simPass,
    detail: `semantic similarity ${score.toFixed(3)} vs threshold ${config.similarityThreshold}`,
  });

  // Rule 4 — vision confidence.
  const conf = Number.isFinite(meta.confidence) ? meta.confidence : 0;
  const confPass = conf >= config.lowConfidenceThreshold;
  trace.push({
    rule: 'low_confidence',
    pass: confPass,
    detail: `vision confidence ${conf.toFixed(2)} vs floor ${config.lowConfidenceThreshold}`,
  });

  const failed = trace.find((r) => !r.pass);
  if (failed) {
    return { verdict: 'reject', rule: failed.rule, reason: failed.detail, trace };
  }
  return {
    verdict: 'approve',
    rule: null,
    reason:
      `Matched on subject "${meta.subject || 'unknown'}" — ` +
      `semantic score ${score.toFixed(3)} (>= ${config.similarityThreshold}), ` +
      `vision confidence ${conf.toFixed(2)} (>= ${config.lowConfidenceThreshold}).`,
    trace,
  };
}

module.exports = { evaluateGuard, canonicalizeSpecies, RULES };
