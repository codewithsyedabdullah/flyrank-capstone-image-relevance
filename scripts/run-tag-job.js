/**
 * run-tag-job.js — CLI entry for the vision tagging batch job.
 * Usage: npm run tag [-- --force]
 */
require('../src/config');
const { migrate } = require('../src/db/migrate');
const { runTagJobCli } = require('../src/jobs/batchJob');

(async () => {
  migrate();
  const force = process.argv.includes('--force');
  console.log(`[tag-job] start (force=${force})`);
  const s = await runTagJobCli({ force });
  console.log('[tag-job] done:', JSON.stringify(s, null, 2));
  process.exitCode = s.failed ? 1 : 0;
})().catch((e) => {
  console.error('TAG JOB FATAL:', e);
  process.exitCode = 1;
});
