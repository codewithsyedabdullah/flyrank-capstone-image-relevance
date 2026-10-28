/**
 * API surface tests — the HTTP layer the evaluator probes (Layer 2):
 * health, matching (fox ranks first / forced wolf+dog rejected with
 * explanations / honest no-match refusal), eval + cost endpoints, review
 * workflow, boundary validation (clean 4xx/404, malformed JSON), jobs with
 * retry attempts, idempotency, dedupe, and the job-crash alert path.
 *
 * The server boots on an ephemeral port in-process (createApp().listen(0)).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, repos } = require('./helpers'); // MUST be first: sets DATABASE_PATH before src loads
const { createApp } = require('../src/server');
const { runEval } = require('../scripts/eval');

let base, server, report;

const getJson = async (p) => {
  const r = await fetch(base + p);
  const b = await r.json().catch(() => null);
  return { http: r.status, body: b };
};
const postJson = async (p, obj) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
  });
  const b = await r.json().catch(() => null);
  return { http: r.status, body: b };
};
const postRaw = async (p, raw) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
  });
  const b = await r.json().catch(() => null);
  return { http: r.status, body: b };
};
const waitFor = async (fn, { timeout = 10000, interval = 100, label = 'condition' } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for ${label}`);
};

before(async () => {
  const counts = await setupTestDb();
  assert.equal(counts.images, 56);

  // Real in-process eval run; its REAL numbers are recorded so GET /api/eval
  // has something honest to serve (eval.test.js covers the pipeline itself).
  report = await runEval({ persist: false });
  assert.equal(report.top1_precision, 1);
  repos.recordEvalRun({
    dataset: report.dataset, top1Precision: report.top1_precision, total: report.total,
    correct: report.correct, threshold: report.threshold,
    notes: 'recorded by tests/api.test.js from an in-process runEval (persist=false)',
  });

  server = createApp().listen(0);
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  if (server.closeAllConnections) server.closeAllConnections();
});

test('GET / smoke + /api/health reports corpus counts, providers and thresholds', async () => {
  const root = await getJson('/');
  assert.equal(root.http, 200);
  assert.ok(root.body.name.includes('flyrank'));

  const { http, body } = await getJson('/api/health');
  assert.equal(http, 200);
  assert.equal(body.ok, true);
  assert.equal(body.counts.images, 56);
  assert.equal(body.counts.images_tagged, 50);
  assert.equal(body.counts.images_flagged, 6);
  assert.equal(body.counts.metadata, 56);
  assert.equal(body.counts.embeddings, 72);
  assert.equal(body.counts.posts, 16);
  assert.ok(body.counts.cost_calls >= 61);
  assert.equal(body.providers.vision, 'fixture');
  assert.equal(body.providers.embedding, 'cache');
  assert.equal(body.thresholds.similarity, report.threshold);
});

test('PROBE 2 — red-fox post ranks a red fox first; every approved candidate is a red fox', async () => {
  const { http, body } = await getJson('/api/posts/p-fox-1/images?top=10');
  assert.equal(http, 200);
  assert.equal(body.verdict, 'match');
  assert.ok(body.match.imageId.startsWith('img-red_fox-'), `matched ${body.match.imageId}`);
  assert.equal(body.match.subject, 'red fox');
  assert.ok(body.match.score > 0.7, `fox self-score too low: ${body.match.score}`);
  assert.equal(body.candidates[0].imageId, body.match.imageId);
  assert.ok(body.candidates.length >= 5);
  const approved = body.candidates.filter((c) => c.verdict === 'approve');
  assert.ok(approved.length >= 1);
  assert.ok(approved.every((c) => c.subject === 'red fox'), 'guard approves only same-species');
  assert.equal(body.embeddingModel, 'all-minilm');
});

test('PROBE 3 — forced wolf AND dog on the fox post: visible, far lower, rejected species_mismatch with explanation', async () => {
  const wolf = await getJson('/api/posts/p-fox-1/images?force_image=img-wolf-00&top=3');
  assert.equal(wolf.http, 200);
  const w = wolf.body.candidates.find((c) => c.imageId === 'img-wolf-00');
  assert.ok(w, 'forced wolf visible in candidates');
  assert.equal(w.verdict, 'reject');
  assert.equal(w.rule, 'species_mismatch');
  assert.match(w.reason, /red fox/);
  assert.match(w.reason, /gray wolf/);
  assert.ok(wolf.body.match.score - w.score > 0.3, `fox/wolf margin thin: ${wolf.body.match.score} vs ${w.score}`);
  assert.ok(wolf.body.match.imageId.startsWith('img-red_fox-'), 'fox still wins');

  const dog = await getJson('/api/posts/p-fox-1/images?force_image=img-dog-00&top=3');
  const d = dog.body.candidates.find((c) => c.imageId === 'img-dog-00');
  assert.equal(d.verdict, 'reject');
  assert.equal(d.rule, 'species_mismatch');
  assert.match(d.reason, /red fox/);
});

test('PROBE 4 — out-of-corpus post: no_confident_match + reasons, never a guessed image', async () => {
  const { http, body } = await getJson('/api/posts/p-other-1/images?top=5');
  assert.equal(http, 200);
  assert.equal(body.verdict, 'no_confident_match');
  assert.equal(body.match, null);
  assert.ok(body.reasons.length >= 1);
  assert.ok(body.reasons.every((r) => r.imageId && typeof r.score === 'number' && r.rule && r.reason));
  assert.ok(body.reasons.some((r) => r.rule === 'below_threshold'));
});

test('PROBE 5 — /api/eval serves the recorded run: precision 1, 15/15, tuned threshold', async () => {
  const { http, body } = await getJson('/api/eval');
  assert.equal(http, 200);
  assert.ok(body.latest, 'eval run recorded');
  assert.equal(body.latest.top1_precision, 1);
  assert.equal(body.latest.total, 15);
  assert.equal(body.latest.correct, 15);
  assert.ok(body.latest.threshold >= 0.3 && body.latest.threshold <= 0.775);
  assert.ok(Array.isArray(body.history) && body.history.length >= 1);
});

test('PROBE 6 — /api/costs attributes every vision/embedding call', async () => {
  const { http, body } = await getJson('/api/costs');
  assert.equal(http, 200);
  assert.ok(body.summary.total_calls >= 61, `expected >= 61, got ${body.summary.total_calls}`);
  const vision = body.summary.by_operation.find((o) => o.operation === 'vision');
  const embedding = body.summary.by_operation.find((o) => o.operation === 'embedding');
  assert.ok(vision && vision.calls >= 56);
  assert.ok(embedding && embedding.calls >= 5);
  assert.ok(body.recent.length >= 1);
  assert.ok(body.recent.every((r) => r.provider && r.model && r.operation && r.entity_ref != null && typeof r.cost_usd === 'number'));
});

test('low-confidence images are flagged and listed (6 ambiguous Canis fixtures)', async () => {
  const { http, body } = await getJson('/api/images?flagged=1');
  assert.equal(http, 200);
  assert.equal(body.count, 6);
  assert.ok(body.images.every((i) => i.low_confidence === 1));
  assert.ok(body.images.every((i) => i.confidence < 0.6));
  assert.ok(body.images.every((i) => String(i.subject).toLowerCase().includes('canid')));
});

test('image detail: metadata + tags + embedding identity', async () => {
  const { http, body } = await getJson('/api/images/img-red_fox-07');
  assert.equal(http, 200);
  assert.equal(body.image.id, 'img-red_fox-07');
  assert.equal(body.metadata.subject, 'red fox');
  assert.equal(body.metadata.schema_valid, true);
  const tags = body.tags.map((t) => `${t.tag_type}:${t.tag}`);
  assert.ok(tags.includes('subject:red fox'));
  assert.ok(tags.includes('category:animal'));
  assert.ok(tags.some((t) => t.startsWith('attribute:')));
  assert.equal(body.embedding.model, 'all-minilm');
  assert.equal(body.embedding.dim, 384);
});

test('inspect-why on the refused wolf suggestion: rule, human reason, full 4-rule trace', async () => {
  const { http, body } = await getJson('/api/suggestions/sg-p-fox-1-img-wolf-00/why');
  assert.equal(http, 200);
  assert.equal(body.verdict, 'rejected');
  assert.equal(body.guardRule, 'species_mismatch');
  assert.match(body.reason, /red fox/);
  assert.match(body.reason, /gray wolf/);
  assert.equal(body.guardTrace.length, 4);
  const species = body.guardTrace.find((t) => t.rule === 'species_mismatch');
  assert.equal(species.pass, false);
  assert.ok(body.guardTrace.every((t) => typeof t.pass === 'boolean' && typeof t.detail === 'string'));
});

test('review workflow: approve + reject persist reviews visible via inspect-why', async () => {
  // find one approved and one rejected suggestion somewhere in the corpus
  let approvedId, rejectedId;
  for (const p of repos.listPosts()) {
    const sgs = repos.suggestionsForPost(p.id);
    if (!approvedId) approvedId = (sgs.find((s) => s.verdict === 'approved') || {}).id;
    if (!rejectedId) rejectedId = (sgs.find((s) => s.verdict === 'rejected') || {}).id;
    if (approvedId && rejectedId) break;
  }
  assert.ok(approvedId && rejectedId, 'both verdicts present');

  const a = await postJson(`/api/suggestions/${approvedId}/approve`, { reviewer: 'api-test' });
  assert.equal(a.http, 200);
  assert.equal(a.body.suggestion.verdict, 'approved');

  const r = await postJson(`/api/suggestions/${rejectedId}/reject`, {
    reviewer: 'api-test', reason: 'species mismatch — photo does not depict the post subject',
  });
  assert.equal(r.http, 200);
  assert.equal(r.body.suggestion.verdict, 'rejected');

  const whyA = await getJson(`/api/suggestions/${approvedId}/why`);
  assert.equal(whyA.body.verdict, 'approved');
  assert.equal(whyA.body.review.action, 'approve');
  assert.equal(whyA.body.review.reviewer, 'api-test');

  const whyR = await getJson(`/api/suggestions/${rejectedId}/why`);
  assert.equal(whyR.body.verdict, 'rejected');
  assert.equal(whyR.body.review.action, 'reject');
  assert.match(whyR.body.review.reason, /species mismatch/);
});

test('boundary: reject without reason -> clean 400', async () => {
  const { http, body } = await postJson('/api/suggestions/sg-p-fox-1-img-wolf-00/reject', { reviewer: 'api-test' });
  assert.equal(http, 400);
  assert.equal(body.error, 'validation failed');
  assert.ok(JSON.stringify(body.details).includes('reason'));
});

test('boundary: bogus force_image -> clean 400', async () => {
  const { http, body } = await getJson('/api/posts/p-fox-1/images?force_image=img-nonexistent-99');
  assert.equal(http, 400);
  assert.match(body.error, /not a valid image id/);
});

test('boundary: unknown post -> 404; unknown image tag -> 404; unknown route -> 404', async () => {
  const a = await getJson('/api/posts/nope-not-real/images');
  assert.equal(a.http, 404);
  assert.match(a.body.error, /post not found/);

  const b = await postJson('/api/images/img-does-not-exist/tag', {});
  assert.equal(b.http, 404);
  assert.match(b.body.error, /image not found/);

  const c = await getJson('/api/totally-bogus');
  assert.equal(c.http, 404);
  assert.equal(c.body.error, 'not found');

  const d = await getJson('/definitely-not-a-route');
  assert.equal(d.http, 404);
});

test('boundary: malformed JSON body -> clean 400, no stack trace', async () => {
  const { http, body } = await postRaw('/api/suggestions/sg-p-fox-1-img-wolf-00/approve', '{not valid json');
  assert.equal(http, 400);
  assert.ok(body.error && typeof body.error === 'string');
  assert.ok(!JSON.stringify(body).includes('stack'), 'no stack leak');
});

test('jobs: setup tag job (56 ok attempts) and embed job (5 ok batches) visible with attempts', async () => {
  const { http, body } = await getJson('/api/jobs?limit=50');
  assert.equal(http, 200);
  const tagJob = body.jobs.find((j) => j.type === 'tag' && j.total === 56);
  assert.ok(tagJob, 'setup tag job listed');
  const detail = await getJson(`/api/jobs/${tagJob.id}`);
  assert.equal(detail.http, 200);
  assert.equal(detail.body.attempts.length, 56);
  assert.ok(detail.body.attempts.every((a) => a.status === 'ok'));

  const embedJob = body.jobs.find((j) => j.type === 'embed' && j.total === 72);
  assert.ok(embedJob, 'setup embed job listed');
  const edetail = await getJson(`/api/jobs/${embedJob.id}`);
  assert.equal(edetail.body.attempts.length, 5);
});

test('idempotency: re-tag a tagged image -> 409; ?force=true re-tags it', async () => {
  const dup = await postJson('/api/images/img-red_fox-00/tag', {});
  assert.equal(dup.http, 409);
  assert.match(dup.body.error, /already tagged/);

  const forced = await postJson('/api/images/img-red_fox-00/tag?force=true', {});
  assert.equal(forced.http, 200);
  assert.equal(forced.body.ok, true);
  assert.equal(forced.body.metadata.subject, 'red fox');
});

test('idempotency: POST /api/jobs/tag + /api/jobs/embed on a done corpus -> 202, jobs succeed with 0 to do', async () => {
  const t = await postJson('/api/jobs/tag', {});
  assert.equal(t.http, 202);
  assert.ok(t.body.jobId);
  const tj = await waitFor(async () => {
    const j = await getJson(`/api/jobs/${t.body.jobId}`);
    return j.body.status === 'succeeded' || j.body.status === 'failed' ? j.body : null;
  }, { label: 'tag job to finish' });
  assert.equal(tj.status, 'succeeded');
  assert.equal(tj.total, 0);

  const e = await postJson('/api/jobs/embed', {});
  assert.equal(e.http, 202);
  const ej = await waitFor(async () => {
    const j = await getJson(`/api/jobs/${e.body.jobId}`);
    return j.body.status === 'succeeded' || j.body.status === 'failed' ? j.body : null;
  }, { label: 'embed job to finish' });
  assert.equal(ej.status, 'succeeded');
  assert.equal(ej.total, 0);
});

test('job dedupe: a running tag job makes POST /api/jobs/tag return the existing job (deduped:true)', async () => {
  const fake = repos.createJob({ tenantId: 'default', type: 'tag', total: 0 });
  repos.updateJob(fake.id, { status: 'running' });
  try {
    const r = await postJson('/api/jobs/tag', {});
    assert.equal(r.http, 202);
    assert.equal(r.body.deduped, true);
    assert.equal(r.body.jobId, fake.id);
  } finally {
    repos.updateJob(fake.id, { status: 'succeeded' }); // cleanup so later tests can start jobs
  }
});

test('alerts endpoint serves the alerts table', async () => {
  const { http, body } = await getJson('/api/alerts');
  assert.equal(http, 200);
  assert.ok(Array.isArray(body.alerts));
});

test('job crash path (LAST — mutates VISION_PROVIDER): gemini without key -> job failed + job_crash alert', async () => {
  const prevProvider = process.env.VISION_PROVIDER;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.VISION_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
  try {
    const r = await postJson('/api/jobs/tag', {});
    assert.equal(r.http, 202);
    assert.ok(r.body.jobId);

    const job = await waitFor(async () => {
      const j = await getJson(`/api/jobs/${r.body.jobId}`);
      return j.body.status === 'failed' || j.body.status === 'succeeded' ? j.body : null;
    }, { label: 'gemini job to crash' });
    assert.equal(job.status, 'failed');
    assert.match(job.error || '', /crash/i);

    const alerts = await getJson('/api/alerts');
    assert.ok(
      alerts.body.alerts.some((a) => a.kind === 'job_crash' && a.job_id === r.body.jobId),
      'job_crash alert raised'
    );
  } finally {
    if (prevProvider === undefined) delete process.env.VISION_PROVIDER;
    else process.env.VISION_PROVIDER = prevProvider;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});
