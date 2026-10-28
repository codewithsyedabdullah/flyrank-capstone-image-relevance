/**
 * run-embed-job.js — CLI entry for the embedding batch job.
 * Usage: npm run embed
 */
require('../src/config');
const { migrate } = require('../src/db/migrate');
const { runEmbedJobCli } = require('../src/jobs/batchJob');

(async () => {
  migrate();
  console.log('[embed-job] start');
  const s = await runEmbedJobCli();
  console.log('[embed-job] done:', JSON.stringify(s, null, 2));
  process.exitCode = s.failed ? 1 : 0;
})().catch((e) => {
  console.error('EMBED JOB FATAL:', e);
  process.exitCode = 1;
});
