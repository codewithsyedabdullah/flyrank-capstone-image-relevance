/**
 * eval.js — measure top-1 precision on the labeled eval set (seeds/eval-set.json)
 * and TUNE the similarity threshold on that same set (brief §2: "pick thresholds
 * using your own labeled eval set — and defend the fox/wolf boundary with a
 * precision number, not a feeling").
 *
 * Method (honest, no cheating):
 *   1. Sweep SIMILARITY_THRESHOLD 0.30→0.80. At each value, run the REAL
 *      ranking+guard pipeline (rankImagesForPost) for every labeled post.
 *      A post is correct iff the top-ranked guard-APPROVED image is the
 *      labeled image. Refusals and wrong images both count as misses.
 *   2. Pick the midpoint of the threshold band that achieves maximal
 *      precision (most conservative choice inside the perfect band).
 *   3. Re-run at the chosen threshold, persist suggestions, record the run in
 *      eval_runs, and write data/eval-run.json for README/EVIDENCE.
 *
 * Exported as runEval() so bootstrap and tests can call it in-process.
 * Usage: npm run eval
 */
require('../src/config');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../src/db/migrate');
const repos = require('../src/repositories');
const matching = require('../src/services/matching');
const config = require('../src/config');

const ROOT = path.join(__dirname, '..');
const STEP = 0.025;

function runPass(evalSet, threshold) {
  process.env.SIMILARITY_THRESHOLD = String(threshold);
  let correct = 0;
  const rows = [];
  for (const e of evalSet) {
    const r = matching.rankImagesForPost(e.postId, { top: 1 });
    const ok = Boolean(r.match && r.match.imageId === e.correctImageId);
    if (ok) correct++;
    rows.push({
      postId: e.postId,
      expected: e.correctImageId,
      got: r.match ? r.match.imageId : null,
      score: r.match ? r.match.score : null,
      verdict: r.verdict,
      ok,
    });
  }
  return { threshold, correct, total: evalSet.length, precision: correct / evalSet.length, rows };
}

async function runEval({ persist = true } = {}) {
  migrate();
  const evalSet = JSON.parse(fs.readFileSync(path.join(ROOT, 'seeds', 'eval-set.json'), 'utf8'));
  if (!evalSet.length) {
    throw new Error('empty eval set — generate it with node scripts/generate-eval-set.js');
  }

  // Pipeline readiness check (clear error instead of a sweep of NaNs).
  try {
    matching.rankImagesForPost(evalSet[0].postId, { top: 1 });
  } catch (e) {
    throw new Error('pipeline not ready: ' + e.message + ' — run: npm run bootstrap');
  }

  console.log(`[eval] dataset: seeds/eval-set.json (${evalSet.length} labeled posts)`);
  console.log(`[eval] embedding model: ${config.embeddingModel} | vision: ${config.visionProvider}`);
  console.log('[eval] sweeping SIMILARITY_THRESHOLD...');

  const sweep = [];
  for (let t = 0.3; t <= 0.801; t += STEP) {
    const tt = Math.round(t * 1000) / 1000;
    sweep.push(runPass(evalSet, tt));
  }
  for (const p of sweep) {
    console.log(`  threshold=${p.threshold.toFixed(3)}  precision=${p.correct}/${p.total} = ${p.precision.toFixed(3)}`);
  }

  const maxPrecision = Math.max(...sweep.map((p) => p.precision));
  const band = sweep.filter((p) => p.precision === maxPrecision);
  const lo = band[0].threshold;
  const hi = band[band.length - 1].threshold;
  const chosen = Math.round(((lo + hi) / 2) * 1000) / 1000;
  console.log(`\n[eval] max precision ${maxPrecision.toFixed(3)} achieved on band [${lo.toFixed(3)}, ${hi.toFixed(3)}] -> chosen midpoint ${chosen}`);

  // Final pass at the chosen threshold — this is the persisted, reported state.
  const final = runPass(evalSet, chosen);
  const misses = final.rows.filter((r) => !r.ok);
  console.log('\n=== per-post detail (chosen threshold) ===');
  for (const r of final.rows) {
    console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.postId} expected=${r.expected} got=${r.got} score=${r.score === null ? '—' : r.score.toFixed(4)} verdict=${r.verdict}`);
  }
  if (misses.length) {
    console.log('\nmisses:');
    for (const m of misses) console.log(`  ${m.postId}: expected ${m.expected}, got ${m.got}`);
  }

  const report = {
    dataset: 'seeds/eval-set.json',
    embeddingModel: config.embeddingModel,
    visionProvider: config.visionProvider,
    top1_precision: final.precision,
    correct: final.correct,
    total: final.total,
    threshold: chosen,
    band: [lo, hi],
    sweep: sweep.map((p) => ({ threshold: p.threshold, precision: p.precision })),
    per_post: final.rows,
    generatedAt: new Date().toISOString(),
  };

  if (persist) {
    repos.recordEvalRun({
      dataset: 'seeds/eval-set.json',
      top1Precision: final.precision,
      total: final.total,
      correct: final.correct,
      threshold: chosen,
      notes: `model=${config.embeddingModel}; vision=${config.visionProvider}; band=[${lo},${hi}] midpoint; top-1 = first guard-approved candidate equals labeled image`,
    });
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data', 'eval-run.json'), JSON.stringify(report, null, 2));
    console.log('\nreport -> data/eval-run.json + eval_runs table');
  }

  console.log('\n==========================================');
  console.log(`TOP-1 PRECISION: ${final.correct}/${final.total} = ${final.precision.toFixed(3)}`);
  console.log(`SIMILARITY_THRESHOLD=${chosen} (band [${lo}, ${hi}])`);
  console.log('==========================================');
  return report;
}

if (require.main === module) {
  runEval().catch((e) => {
    console.error('EVAL FAILED:', e);
    process.exitCode = 1;
  });
}

module.exports = { runEval };
