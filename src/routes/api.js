/**
 * routes/api.js — the HTTP layer. Zod validation AT the boundary: bad input
 * gets a clean 4xx JSON, never a stack trace (shared requirement #2).
 * Services/repos do the work; routes never touch the database directly.
 */
const express = require('express');
const config = require('../config');
const repos = require('../repositories');
const { getVisionProvider } = require('../providers/vision');
const { CostTracker } = require('../services/cost');
const matching = require('../services/matching');
const { startTagJob, startEmbedJob, tagSingleImage } = require('../jobs/batchJob');
const {
  matchQuerySchema, jobStartSchema, reviewApproveSchema, reviewRejectSchema, tagQuerySchema,
} = require('../schema/api');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- health / meta ----
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    tenant: config.tenantId,
    providers: { vision: process.env.VISION_PROVIDER || 'fixture', embedding: process.env.EMBEDDING_PROVIDER || 'cache' },
    embeddingModel: config.embeddingModel,
    thresholds: { similarity: config.similarityThreshold, lowConfidence: config.lowConfidenceThreshold },
    counts: repos.healthCounts(),
  });
});

// ---- images ----
router.get('/images', (req, res) => {
  const limit = Number(req.query.limit) || 200;
  const images = repos.listImages({ status: req.query.status, flagged: req.query.flagged, limit });
  const out = images.map((i) => {
    const m = repos.getMetadata(i.id);
    return {
      id: i.id, status: i.status, low_confidence: i.low_confidence, category_hint: i.category_hint,
      license: i.license, artist: i.artist, source_url: i.source_url,
      subject: m ? m.subject : null, confidence: m ? m.confidence : null,
      caption: m ? m.caption : null, schema_valid: m ? m.schema_valid === 1 : null,
    };
  });
  res.json({ count: out.length, images: out });
});

router.get('/images/:id', (req, res) => {
  const image = repos.getImage(req.params.id);
  if (!image) return res.status(404).json({ error: `image not found: ${req.params.id}` });
  const m = repos.getMetadata(image.id);
  const emb = repos.embeddingFor('image', image.id, config.embeddingModel);
  return res.json({
    image,
    metadata: m ? { subject: m.subject, category: m.category, caption: m.caption, confidence: m.confidence, attributes: m.attributes, schema_valid: m.schema_valid === 1 } : null,
    tags: repos.tagsForImage(image.id),
    embedding: emb ? { model: emb.model, dim: emb.dim } : null,
  });
});

// single-image tag (synchronous — one vision call; the batch job is for bulk)
router.post('/images/:id/tag', asyncHandler(async (req, res, next) => {
  const q = tagQuerySchema.parse(req.query);
  if (!repos.getImage(req.params.id)) return res.status(404).json({ error: `image not found: ${req.params.id}` });
  try {
    const r = await tagSingleImage(req.params.id, { force: q.force });
    const m = repos.getMetadata(req.params.id);
    return res.json({
      ok: r.ok, flagged: r.flagged, jobId: r.jobId,
      metadata: m ? { subject: m.subject, category: m.category, confidence: m.confidence, caption: m.caption, attributes: m.attributes } : null,
      error: r.error ? String(r.error.message || r.error) : null,
    });
  } catch (e) { next(e); }
}));

// ---- posts ----
router.get('/posts', (req, res) => res.json({ count: repos.listPosts().length, posts: repos.listPosts() }));

router.get('/posts/:id', (req, res) => {
  const post = repos.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: `post not found: ${req.params.id}` });
  return res.json(post);
});

// ---- the matching endpoint (PROBE 2/3/4) ----
router.get('/posts/:id/images', asyncHandler(async (req, res, next) => {
  const q = matchQuerySchema.parse(req.query);
  try {
    const result = matching.rankImagesForPost(req.params.id, { top: q.top, forceImageId: q.force_image });
    return res.json({
      ...result,
      embeddingModel: config.embeddingModel,
      thresholds: matching.thresholds(),
    });
  } catch (e) { next(e); }
}));

router.get('/posts/:id/suggestions', (req, res) => {
  return res.json({ postId: req.params.id, suggestions: repos.suggestionsForPost(req.params.id) });
});

// ---- inspect why (selected OR refused) ----
router.get('/suggestions/:id/why', (req, res, next) => {
  try {
    return res.json(matching.explainSuggestion(req.params.id));
  } catch (e) { next(e); }
});

// ---- review workflow ----
router.post('/suggestions/:id/approve', (req, res, next) => {
  try {
    const body = reviewApproveSchema.parse(req.body || {});
    const s = repos.getSuggestion(req.params.id);
    if (!s) return res.status(404).json({ error: `suggestion not found: ${req.params.id}` });
    const r = repos.reviewSuggestion(s.id, { action: 'approve', reviewer: body.reviewer });
    return res.json({ ...r, suggestion: repos.getSuggestion(s.id) });
  } catch (e) { next(e); }
});

router.post('/suggestions/:id/reject', (req, res, next) => {
  try {
    const body = reviewRejectSchema.parse(req.body || {});
    const s = repos.getSuggestion(req.params.id);
    if (!s) return res.status(404).json({ error: `suggestion not found: ${req.params.id}` });
    const r = repos.reviewSuggestion(s.id, { action: 'reject', reviewer: body.reviewer, reason: body.reason });
    return res.json({ ...r, suggestion: repos.getSuggestion(s.id) });
  } catch (e) { next(e); }
});

// ---- background jobs ----
router.post('/jobs/tag', (req, res) => {
  const body = jobStartSchema.parse(req.body || {});
  return res.status(202).json(startTagJob({ force: body.force }));
});

router.post('/jobs/embed', (req, res) => {
  jobStartSchema.parse(req.body || {});
  return res.status(202).json(startEmbedJob());
});

router.get('/jobs/:id', (req, res) => {
  const job = repos.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: `job not found: ${req.params.id}` });
  return res.json(job);
});

router.get('/jobs', (req, res) => {
  return res.json({ jobs: repos.listJobs({ type: req.query.type, limit: Number(req.query.limit) || 20 }) });
});

// ---- cost log + budget status (PROBE 6) ----
router.get('/costs', (req, res) => {
  const ct = new CostTracker(config.tenantId);
  return res.json({ summary: ct.summary(), recent: repos.recentCostCalls(20) });
});

// ---- eval (PROBE 5) ----
router.get('/eval', (req, res) => {
  return res.json({ latest: repos.latestEval(), history: repos.recentEvalRuns(5) });
});

// ---- failure alerts ----
router.get('/alerts', (req, res) => res.json({ alerts: repos.listAlerts() }));

module.exports = router;
