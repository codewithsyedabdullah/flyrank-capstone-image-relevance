/**
 * matching service — semantic ranking + the mismatch guard + persistence of
 * explained suggestions. This is the decision core of the capstone.
 *
 * For a post: embed(post) is already stored; every image with a stored caption
 * embedding becomes a candidate; cosine ranks them; the guard judges each
 * candidate; only guard-approved candidates are "suggested". When nothing
 * clears the bar the answer is "no confident match" with aggregated reasons —
 * never a guessed best-effort image.
 */
const config = require('../config');
const guard = require('./guard');
const repos = require('../repositories');

function thresholds() {
  return {
    similarityThreshold: config.similarityThreshold,
    lowConfidenceThreshold: config.lowConfidenceThreshold,
  };
}

const CANDIDATE_POOL = 25; // shortlist breadth: the guard judges all of them; the response returns top-N
const EMBEDDING_MODEL = () => config.embeddingModel;

/**
 * Rank images for a post and persist per-candidate guard verdicts.
 * forceImageId provokes a specific candidate (used by PROBE 3: force the wolf
 * onto the fox post and watch the guard reject it with an explanation).
 */
function rankImagesForPost(postId, { top = 5, forceImageId = null } = {}) {
  const post = repos.getPost(postId);
  if (!post) {
    const err = new Error(`post not found: ${postId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (forceImageId) {
    const forcedRow = repos.getImage(forceImageId);
    if (!forcedRow) {
      const err = new Error(`force_image ${forceImageId} is not a valid image id`);
      err.code = 'BAD_FORCE_IMAGE';
      throw err;
    }
  }
  const postVecRow = repos.embeddingFor('post', postId, EMBEDDING_MODEL());
  if (!postVecRow) {
    const err = new Error(`no embedding for post ${postId} under model ${EMBEDDING_MODEL()} — run the embed batch job first`);
    err.code = 'NO_EMBEDDING';
    throw err;
  }

  const candidates = repos.imageCandidatesWithVectors(EMBEDDING_MODEL());
  if (!candidates.length) {
    const err = new Error('no image candidates with metadata+embeddings — run tag and embed jobs first');
    err.code = 'NO_CANDIDATES';
    throw err;
  }

  // The post row uses snake_case columns; give the guard a normalized view.
  const postView = { id: post.id, title: post.title, body: post.body, speciesHint: post.species_hint };
  const GUARD_CONFIG = thresholds();

  // 1) semantic ranking (cosine over the shared embedding space)
  const scored = candidates.map((c) => {
    let dot = 0;
    const pv = postVecRow.vector;
    const iv = c.vector;
    const n = Math.min(pv.length, iv.length);
    for (let i = 0; i < n; i++) dot += pv[i] * iv[i];
    return { ...c, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);

  // 2) candidate pool = top-K, plus the forced candidate if it isn't already in
  let pool = scored.slice(0, CANDIDATE_POOL);
  const forced = forceImageId ? scored.find((c) => c.image_id === forceImageId) : null;
  if (forced && !pool.find((c) => c.image_id === forceImageId)) {
    pool = [...pool, forced];
  }

  // 3) the guard judges every candidate; verdicts persisted (idempotent upsert)
  const judged = pool.map((c, idx) => {
    const metadata = {
      subject: c.subject, category: c.category, caption: c.caption,
      confidence: c.confidence, attributes: c.attributes, schemaValid: c.schema_valid === 1,
    };
    const result = guard.evaluateGuard({ post: postView, candidate: { id: c.image_id, metadata, score: c.score }, config: GUARD_CONFIG });
    const suggestionId = `sg-${postId}-${c.image_id}`;
    repos.upsertSuggestion({
      id: suggestionId, postId, imageId: c.image_id, rank: idx + 1, score: c.score,
      verdict: result.verdict === 'approve' ? 'approved' : 'rejected',
      guardRule: result.rule, reason: result.reason, trace: result.trace,
    });
    return {
      suggestionId, imageId: c.image_id, rank: idx + 1, score: Number(c.score.toFixed(4)),
      verdict: result.verdict, rule: result.rule, reason: result.reason, trace: result.trace,
      forced: Boolean(forceImageId && c.image_id === forceImageId),
      subject: c.subject, confidence: c.confidence, caption: c.caption,
    };
  });

  // 4) the answer: first guard-approved candidate, or an honest refusal
  const approved = judged.filter((c) => c.verdict === 'approve');
  const match = approved.length ? approved[0] : null;

  // Response list: top-N by rank, ALWAYS including the forced candidate when
  // one was provoked — the reviewer must see the rejection itself, not just
  // the endpoint's verdict (PROBE 3: forced wolf on the fox post).
  let shown = judged.slice(0, top);
  if (forceImageId && !shown.find((c) => c.imageId === forceImageId)) {
    const forcedRow = judged.find((c) => c.imageId === forceImageId);
    if (forcedRow) shown = [...shown, forcedRow];
  }

  return {
    postId,
    match,
    verdict: match ? 'match' : 'no_confident_match',
    reasons: match
      ? null
      : judged.slice(0, 3).map((c) => ({ imageId: c.imageId, subject: c.subject, score: c.score, rule: c.rule, reason: c.reason })),
    candidates: shown,
  };
}

/**
 * Inspect-why: full explanation for one suggestion (selected OR refused).
 */
function explainSuggestion(suggestionId) {
  const s = repos.getSuggestion(suggestionId);
  if (!s) {
    const err = new Error(`suggestion not found: ${suggestionId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const image = repos.getImage(s.image_id);
  const metadata = repos.getMetadata(s.image_id);
  const post = repos.getPost(s.post_id);
  const reviews = repos.reviewsForSuggestion ? repos.reviewsForSuggestion(s.id) : [];
  return {
    suggestionId: s.id,
    post: post ? { id: post.id, title: post.title, speciesHint: post.species_hint } : null,
    image: image ? { id: image.id, sourceUrl: image.source_url, license: image.license, artist: image.artist } : null,
    vision: metadata
      ? { subject: metadata.subject, category: metadata.category, confidence: metadata.confidence, caption: metadata.caption, attributes: metadata.attributes, schemaValid: metadata.schema_valid === 1 }
      : null,
    score: s.score,
    rank: s.rank,
    verdict: s.verdict,
    guardRule: s.guard_rule,
    reason: s.reason,
    guardTrace: s.guard_trace,
    review: reviews.length ? reviews[reviews.length - 1] : null,
  };
}

module.exports = { rankImagesForPost, explainSuggestion, thresholds };
