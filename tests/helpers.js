/**
 * Test helpers — MUST be the first require in every test file.
 *
 * Why: src/db/index.js reads DATABASE_PATH at require time, so the env must
 * point at a per-process temp file BEFORE any src module loads. Each test file
 * runs in its own child process under `node --test`, so process.pid gives
 * every file its own isolated database.
 *
 * setupTestDb() runs the real pipeline (migrate → seed → tag job → embed job)
 * against that temp DB — fixture vision + cache embeddings, $0, seconds.
 */
const os = require('os');
const path = require('path');

process.env.DATABASE_PATH = path.join(os.tmpdir(), `flyrank-test-${process.pid}.sqlite`);
process.env.VISION_PROVIDER = process.env.VISION_PROVIDER || 'fixture';
process.env.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || 'cache';
process.env.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'all-minilm';

const { migrate } = require('../src/db/migrate');
const { seedDatabase } = require('../src/services/provision');
const { runTagJobCli, runEmbedJobCli } = require('../src/jobs/batchJob');
const repos = require('../src/repositories');

async function setupTestDb() {
  migrate();
  seedDatabase();
  await runTagJobCli();
  await runEmbedJobCli();
  return repos.healthCounts();
}

module.exports = { setupTestDb, repos };
