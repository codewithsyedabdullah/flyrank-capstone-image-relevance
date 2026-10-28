/**
 * batchJob.js — the background batch jobs (tag + embed).
 *
 * Shared requirements this module carries:
 *  - #3 background job: slow/bulk AI work runs here, off the request path,
 *    with progress tracked in the jobs table (pollable via GET /api/jobs/:id).
 *  - retries: every provider call is attempted up to 3 times with backoff;
 *    every attempt is recorded in job_attempts (visible evidence).
 *  - failure alert: per-entity final failures, budget exhaustion, and job
 *    crashes all raise an alerts row + optional webhook POST.
 *  - idempotency: tag job skips non-pending images unless force; embed job
 *    skips entities already embedded under the same model; re-runs are no-ops.
 *  - #7 cost: every vision/embedding call is attributed in cost_log BEFORE
 *    the result is trusted, and the budget guard refuses new calls when the
 *    monthly budget is exhausted (BudgetExceededError → job fails + alert).
 */
const config = require('../config');
const repos = require('../repositories');
const { getVisionProvider } = require('../providers/vision');
const { getEmbeddingProvider } = require('../providers/embeddings');
const { CostTracker, BudgetExceededError } = require('../services/cost');
const { processVisionResponse } = require('../services/tagging');

const MAX_ATTEMPTS = 3;
const EMBED_BATCH = 16;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function now() { return new Date().toISOString(); }

/** Persist an alert row and, if configured, POST it to the ops webhook. */
function raiseAlert({ jobId, kind, message }) {
  repos.addAlert({ jobId, kind, message });
  const url = process.env.WEBHOOK_ALERT_URL;
  if (url) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ jobId, kind, message, at: now() }),
    }).catch(() => { /* webhook delivery is best-effort; the DB row is the record */ });
  }
}

/** One entity through the vision provider with retries + per-call cost log. */
async function tagOne(image, jobId, vision, cost) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = now();
    try {
      const raw = await vision.tagImage(image);
      cost.logCall({
        callId: `vision:${image.id}:${jobId}:a${attempt}`,
        provider: vision.name, model: vision.model, operation: 'vision',
        entityRef: image.id, inputUnits: 1, costUsd: vision.priceUsdPerCall || 0,
      });
      const { flagged } = processVisionResponse(image.id, raw);
      repos.addAttempt({ jobId, entityRef: image.id, attemptNo: attempt, status: 'ok', startedAt, finishedAt: now() });
      return { ok: true, flagged };
    } catch (e) {
      lastErr = e;
      repos.addAttempt({ jobId, entityRef: image.id, attemptNo: attempt, status: 'error', error: String(e.message || e).slice(0, 500), startedAt, finishedAt: now() });
      if (attempt < MAX_ATTEMPTS) await sleep(150 * attempt);
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Execute the tagging job (awaited). Called by startTagJob (API, async) and by
 * the CLI wrapper (awaited). Returns a summary; job row carries the state.
 */
async function executeTagJob(jobId, { force = false, tenantId = null } = {}) {
  const tenant = tenantId || config.tenantId;
  const vision = getVisionProvider();
  const cost = new CostTracker(tenant);
  const images = repos.imagesForTagging(force);
  repos.updateJob(jobId, { status: 'running', total: images.length, started_at: now() });

  const summary = { jobId, type: 'tag', provider: vision.name, model: vision.model, total: images.length, succeeded: 0, failed: 0, flagged: 0, budgetStopped: false };
  if (!images.length) {
    repos.updateJob(jobId, { status: 'succeeded', processed: 0, finished_at: now() });
    return summary;
  }

  for (const image of images) {
    try {
      cost.assertWithinBudget();
    } catch (e) {
      summary.budgetStopped = true;
      repos.updateJob(jobId, { status: 'failed', error: `budget guard: ${e.message}`, alert_sent: 1, finished_at: now() });
      raiseAlert({ jobId, kind: 'budget_exceeded', message: `Tag job ${jobId} stopped by budget guard: ${e.message}` });
      return summary;
    }
    const r = await tagOne(image, jobId, vision, cost);
    if (r.ok) {
      summary.succeeded++;
      if (r.flagged) summary.flagged++;
    } else {
      summary.failed++;
      repos.updateImageStatus(image.id, 'failed', { error: String(r.error && r.error.message || r.error).slice(0, 500) });
    }
  }

  repos.updateJob(jobId, {
    status: summary.failed ? 'failed' : 'succeeded',
    processed: images.length, succeeded: summary.succeeded, failed: summary.failed,
    alert_sent: summary.failed ? 1 : 0,
    error: summary.failed ? `${summary.failed} image(s) failed after ${MAX_ATTEMPTS} attempts` : null,
    finished_at: now(),
  });
  if (summary.failed) {
    raiseAlert({ jobId, kind: 'partial_failure', message: `Tag job ${jobId}: ${summary.failed}/${images.length} images failed after ${MAX_ATTEMPTS} attempts each.` });
  }
  return summary;
}

/** Fire-and-forget start with in-process dedupe (one active tag job per tenant). */
function startTagJob({ force = false, tenantId = null } = {}) {
  const tenant = tenantId || config.tenantId;
  const existing = repos.activeJob(tenant, 'tag');
  if (existing) return { jobId: existing.id, status: existing.status, deduped: true };
  const job = repos.createJob({ tenantId: tenant, type: 'tag', total: 0 });
  executeTagJob(job.id, { force, tenantId: tenant }).catch((e) => {
    repos.updateJob(job.id, { status: 'failed', error: `job crashed: ${String(e.message || e).slice(0, 500)}`, alert_sent: 1, finished_at: now() });
    raiseAlert({ jobId: job.id, kind: 'job_crash', message: `Tag job ${job.id} crashed: ${e.message}` });
  });
  return { jobId: job.id, status: 'queued', deduped: false };
}

/** CLI wrapper: creates the job and AWAITS it (npm run tag). */
async function runTagJobCli({ force = false } = {}) {
  const job = repos.createJob({ tenantId: config.tenantId, type: 'tag', total: 0 });
  return executeTagJob(job.id, { force, tenantId: config.tenantId });
}

/** One embedding batch through the provider with retries + cost log. */
async function embedBatchWithRetries(batch, jobId, batchIndex, embed, cost) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = now();
    try {
      const rows = await embed.embedBatch(batch);
      cost.logCall({
        callId: `embedding:${jobId}:b${batchIndex}:a${attempt}`,
        provider: embed.name, model: embed.model, operation: 'embedding',
        entityRef: `${batch.length} texts`, inputUnits: batch.length, costUsd: embed.priceUsdPerCall || 0,
      });
      repos.addAttempt({ jobId, entityRef: `batch ${batchIndex} (${batch.length} texts)`, attemptNo: attempt, status: 'ok', startedAt, finishedAt: now() });
      return rows;
    } catch (e) {
      lastErr = e;
      repos.addAttempt({ jobId, entityRef: `batch ${batchIndex} (${batch.length} texts)`, attemptNo: attempt, status: 'error', error: String(e.message || e).slice(0, 500), startedAt, finishedAt: now() });
      if (attempt < MAX_ATTEMPTS) await sleep(200 * attempt);
    }
  }
  throw lastErr;
}

async function executeEmbedJob(jobId, { tenantId = null } = {}) {
  const tenant = tenantId || config.tenantId;
  const embed = getEmbeddingProvider();
  const model = embed.model; // identity of the vectors we write (cache reads committed files for THIS model)
  const cost = new CostTracker(tenant);

  const images = repos.imagesForEmbedding(model);
  const posts = repos.postsForEmbedding(model);
  // Text recipe MUST match scripts/generate-vectors.js (documented in README):
  //   image: "<caption> <attribute>, <attribute>, ..."   post: "<title>. <body>"
  const items = [
    ...images.map((i) => ({ key: i.id, entityType: 'image', entityId: i.id, text: `${i.caption} ${i.attributes.join(', ')}` })),
    ...posts.map((p) => ({ key: p.id, entityType: 'post', entityId: p.id, text: `${p.title}. ${p.body}` })),
  ];

  repos.updateJob(jobId, { status: 'running', total: items.length, started_at: now() });
  const summary = { jobId, type: 'embed', provider: embed.name, model, total: items.length, succeeded: 0, failed: 0, budgetStopped: false };
  if (!items.length) {
    repos.updateJob(jobId, { status: 'succeeded', processed: 0, finished_at: now() });
    return summary;
  }

  for (let start = 0; start < items.length; start += EMBED_BATCH) {
    const chunk = items.slice(start, start + EMBED_BATCH);
    const batchIndex = start / EMBED_BATCH + 1;
    try {
      cost.assertWithinBudget();
    } catch (e) {
      summary.budgetStopped = true;
      repos.updateJob(jobId, { status: 'failed', error: `budget guard: ${e.message}`, alert_sent: 1, finished_at: now() });
      raiseAlert({ jobId, kind: 'budget_exceeded', message: `Embed job ${jobId} stopped by budget guard: ${e.message}` });
      return summary;
    }
    try {
      const rows = await embedBatchWithRetries(chunk, jobId, batchIndex, embed, cost);
      for (const row of rows) {
        const item = chunk.find((c) => c.key === row.key);
        repos.upsertEmbedding({ entityType: item.entityType, entityId: item.entityId, model, vector: row.vector });
      }
      summary.succeeded += chunk.length;
    } catch (e) {
      summary.failed += chunk.length;
      console.error(`[embed] batch ${batchIndex} failed after ${MAX_ATTEMPTS} attempts: ${e.message}`);
    }
  }

  repos.updateJob(jobId, {
    status: summary.failed ? 'failed' : 'succeeded',
    processed: items.length, succeeded: summary.succeeded, failed: summary.failed,
    alert_sent: summary.failed ? 1 : 0,
    error: summary.failed ? `${summary.failed} text(s) failed after ${MAX_ATTEMPTS} attempts per batch` : null,
    finished_at: now(),
  });
  if (summary.failed) {
    raiseAlert({ jobId, kind: 'partial_failure', message: `Embed job ${jobId}: ${summary.failed}/${items.length} texts failed after retries.` });
  }
  return summary;
}

function startEmbedJob({ tenantId = null } = {}) {
  const tenant = tenantId || config.tenantId;
  const existing = repos.activeJob(tenant, 'embed');
  if (existing) return { jobId: existing.id, status: existing.status, deduped: true };
  const job = repos.createJob({ tenantId: tenant, type: 'embed', total: 0 });
  executeEmbedJob(job.id, { tenantId: tenant }).catch((e) => {
    repos.updateJob(job.id, { status: 'failed', error: `job crashed: ${String(e.message || e).slice(0, 500)}`, alert_sent: 1, finished_at: now() });
    raiseAlert({ jobId: job.id, kind: 'job_crash', message: `Embed job ${job.id} crashed: ${e.message}` });
  });
  return { jobId: job.id, status: 'queued', deduped: false };
}

async function runEmbedJobCli() {
  const job = repos.createJob({ tenantId: config.tenantId, type: 'embed', total: 0 });
  return executeEmbedJob(job.id, { tenantId: config.tenantId });
}

/** Single-image tag (used by POST /api/images/:id/tag). Same retries + cost log. */
async function tagSingleImage(imageId, { force = false } = {}) {
  const image = repos.getImage(imageId);
  if (!image) {
    const err = new Error(`image not found: ${imageId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!force && image.status !== 'pending') {
    const err = new Error(`image ${imageId} is already ${image.status} — pass ?force=true to re-tag`);
    err.code = 'ALREADY_TAGGED';
    throw err;
  }
  const vision = getVisionProvider();
  const cost = new CostTracker(config.tenantId);
  const job = repos.createJob({ tenantId: config.tenantId, type: 'tag', total: 1 });
  try {
    cost.assertWithinBudget();
  } catch (e) {
    repos.updateJob(job.id, { status: 'failed', error: `budget guard: ${e.message}`, alert_sent: 1, finished_at: now() });
    raiseAlert({ jobId: job.id, kind: 'budget_exceeded', message: `Single-image tag of ${imageId} refused by budget guard: ${e.message}` });
    throw e;
  }
  const r = await tagOne(image, job.id, vision, cost);
  repos.updateJob(job.id, { status: r.ok ? 'succeeded' : 'failed', processed: 1, succeeded: r.ok ? 1 : 0, failed: r.ok ? 0 : 1, alert_sent: r.ok ? 0 : 1, error: r.ok ? null : String(r.error.message || r.error).slice(0, 500), finished_at: now() });
  if (!r.ok) raiseAlert({ jobId: job.id, kind: 'partial_failure', message: `Single-image tag of ${imageId} failed after ${MAX_ATTEMPTS} attempts: ${r.error && r.error.message}` });
  return { jobId: job.id, ...r };
}

module.exports = {
  executeTagJob, startTagJob, runTagJobCli,
  executeEmbedJob, startEmbedJob, runEmbedJobCli,
  tagSingleImage, MAX_ATTEMPTS,
};
