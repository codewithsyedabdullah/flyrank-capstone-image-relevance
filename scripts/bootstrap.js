/**
 * bootstrap.js — the one-command full pipeline, in ONE process:
 *   migrate → seed → tag (vision batch job) → embed (embedding batch job) →
 *   eval (threshold sweep + tuning + persisted suggestions).
 *
 * One process matters: it makes the run atomic against flaky sandboxes and
 * gives the evaluator a single reproducible command from clone to measured
 * precision. Each stage is idempotent, so re-runs are safe.
 *
 * Usage: npm run bootstrap
 */
require('../src/config');
const config = require('../src/config');
const { migrate } = require('../src/db/migrate');
const { seedDatabase } = require('../src/services/provision');
const { runTagJobCli, runEmbedJobCli } = require('../src/jobs/batchJob');
const { runEval } = require('./eval');
const repos = require('../src/repositories');
const matching = require('../src/services/matching');

(async () => {
  console.log('========== BOOTSTRAP: migrate → seed → tag → embed → eval ==========');
  migrate();
  const seeded = seedDatabase();
  console.log(`[bootstrap] seeded ${seeded.images} images, ${seeded.posts} posts`);

  const tag = await runTagJobCli({ force: false });
  console.log(`[bootstrap] tag job: ${tag.succeeded}/${tag.total} succeeded, ${tag.flagged} low-confidence flagged, ${tag.failed} failed`);

  const embed = await runEmbedJobCli();
  console.log(`[bootstrap] embed job: ${embed.succeeded}/${embed.total} texts embedded (model=${embed.model})`);

  const report = await runEval();

  // ---- in-process verification (evidence for EVIDENCE.md; no cross-process
  // window, so flaky external file syncs cannot invalidate it) ----
  const counts = repos.healthCounts();
  console.log('\n========== BOOTSTRAP VERIFICATION (in-process) ==========');
  console.log('counts:', JSON.stringify(counts));
  const flagged = repos.listImages({ flagged: '1', limit: 100 });
  console.log(`low-confidence flagged images (${flagged.length}):`, flagged.map((i) => `${i.id}(conf=${repos.getMetadata(i.id).confidence})`).join(', '));
  const { CostTracker } = require('../src/services/cost');
  console.log('cost_log summary:', JSON.stringify(new CostTracker(config.tenantId).summary(), null, 1));

  const fox = matching.rankImagesForPost('p-fox-1', { top: 5 });
  console.log('\n[probe2] fox post top-5:', JSON.stringify(fox.candidates.map((c) => ({ id: c.imageId, subject: c.subject, score: c.score, verdict: c.verdict, rule: c.rule })), null, 1));
  console.log('[probe2] match:', fox.match ? `${fox.match.imageId} score=${fox.match.score}` : 'NONE');

  const forced = matching.rankImagesForPost('p-fox-1', { top: 5, forceImageId: 'img-wolf-00' });
  const wolfRow = forced.candidates.find((c) => c.imageId === 'img-wolf-00');
  console.log('\n[probe3] forced wolf on fox post ->', wolfRow ? `${wolfRow.verdict} | rule=${wolfRow.rule} | score=${wolfRow.score} | reason=${wolfRow.reason}` : 'NOT SHOWN (bug)');

  const noMatch = matching.rankImagesForPost('p-other-1', { top: 3 });
  console.log('\n[probe4] snow-leopard post verdict:', noMatch.verdict);
  console.log('[probe4] reasons:', JSON.stringify(noMatch.reasons, null, 1));

  const why = matching.explainSuggestion('sg-p-fox-1-img-wolf-00');
  console.log('\n[why] sg-p-fox-1-img-wolf-00:', JSON.stringify({ score: why.score, verdict: why.verdict, guardRule: why.guardRule, reason: why.reason, trace: why.guardTrace }, null, 1));

  console.log('\n[bootstrap] COMPLETE — system is ready. Start the API: npm start');
  return report;
})().catch((e) => {
  console.error('BOOTSTRAP FAILED:', e);
  process.exitCode = 1;
});
