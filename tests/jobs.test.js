/**
 * Background-job tests (shared requirement #3): retries with visible attempts,
 * failure alerts, idempotent re-runs, and the budget guard.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setupTestDb, repos } = require('./helpers');
const { runTagJobCli, runEmbedJobCli, MAX_ATTEMPTS } = require('../src/jobs/batchJob');

before(async () => {
  const counts = await setupTestDb();
  assert.equal(counts.images, 56);
  assert.equal(counts.metadata, 56);
  assert.equal(counts.embeddings, 72);
});

test('setup ran the real pipeline: tag job 56/56 ok attempts, embed job 5 ok batches, >=61 cost calls', () => {
  const tagJob = repos.listJobs({ type: 'tag' }).find((j) => j.total === 56 && j.succeeded === 56);
  assert.ok(tagJob, 'setup tag job (total=56) present');
  assert.equal(tagJob.status, 'succeeded');
  const tagFull = repos.getJob(tagJob.id);
  assert.equal(tagFull.attempts.length, 56);
  assert.ok(tagFull.attempts.every((a) => a.status === 'ok'), 'all 56 vision attempts ok');

  const embedJob = repos.listJobs({ type: 'embed' }).find((j) => j.total === 72);
  assert.ok(embedJob, 'setup embed job (total=72) present');
  const embedFull = repos.getJob(embedJob.id);
  assert.equal(embedFull.attempts.length, 5, 'ceil(72/16) = 5 embed batches');
  assert.ok(embedFull.attempts.every((a) => a.status === 'ok'));

  assert.ok(repos.recentCostCalls(500).length >= 61, '56 vision + 5 embed batches logged');
});

test('idempotency: re-running tag and embed jobs on a done corpus is a 0-row no-op', async () => {
  const t = await runTagJobCli();
  assert.equal(t.total, 0, 'no pending images left');
  assert.equal(t.succeeded, 0);

  const e = await runEmbedJobCli();
  assert.equal(e.total, 0, 'no un-embedded texts left');
  assert.equal(e.succeeded, 0);
});

test('retries: a vision provider failure gets 3 recorded attempts, then the image fails + partial_failure alert', async () => {
  // No fixture exists for this id -> the provider throws on every attempt.
  repos.upsertImage({
    id: 'img-test-nofixture', localPath: 'fixtures/missing.jpg', sourceUrl: null,
    license: 'CC-BY', artist: 'test', speciesHint: 'red fox',
  });

  const s = await runTagJobCli();
  assert.equal(s.total, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.succeeded, 0);

  const job = repos.getJob(s.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.alert_sent, 1);
  const errs = job.attempts.filter((a) => a.entity_ref === 'img-test-nofixture' && a.status === 'error');
  assert.equal(errs.length, MAX_ATTEMPTS, 'exactly 3 retry attempts recorded');
  assert.ok(errs.every((a) => a.error && a.error.length > 0), 'every attempt records its error');
  assert.match(errs[0].error, /no vision fixture/);

  const img = repos.getImage('img-test-nofixture');
  assert.equal(img.status, 'failed');
  assert.ok(img.error, 'image carries the failure reason');

  const alerts = repos.listAlerts();
  assert.ok(alerts.some((a) => a.kind === 'partial_failure' && a.job_id === s.jobId), 'partial_failure alert raised');

  // A call that never succeeded must NOT appear in the cost log.
  const costRows = repos.recentCostCalls(500).filter((r) => r.entity_ref === 'img-test-nofixture');
  assert.equal(costRows.length, 0, 'no cost row for a call that never completed');
});

test('budget guard: COST_BUDGET_USD=0 stops the tag job before spending + budget_exceeded alert', async () => {
  repos.upsertImage({
    id: 'img-test-budget', localPath: 'fixtures/missing.jpg', sourceUrl: null,
    license: 'CC-BY', artist: 'test', speciesHint: 'red fox',
  });
  process.env.COST_BUDGET_USD = '0';
  try {
    const s = await runTagJobCli();
    assert.equal(s.total, 1);
    assert.equal(s.budgetStopped, true, 'summary flags the budget stop');

    const job = repos.getJob(s.jobId);
    assert.equal(job.status, 'failed');
    assert.match(job.error || '', /budget/i);

    const alerts = repos.listAlerts();
    assert.ok(
      alerts.some((a) => a.kind === 'budget_exceeded' && a.job_id === s.jobId),
      'budget_exceeded alert raised'
    );
    // the pending image was never charged or tagged
    const img = repos.getImage('img-test-budget');
    assert.equal(img.status, 'pending');
  } finally {
    delete process.env.COST_BUDGET_USD;
  }
});
