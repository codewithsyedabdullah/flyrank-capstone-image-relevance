/**
 * config.js — load .env (if present) BEFORE any service module reads env vars.
 * No dependency: a 15-line parser handles the KEY=VALUE subset we use.
 * Every entry point (server, scripts, tests) requires this first.
 */
const fs = require('fs');
const path = require('path');

(function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined ? v : fallback;
}

module.exports = {
  get tenantId() { return process.env.TENANT_ID || 'default'; },
  get port() { return Number(process.env.PORT || 4317); },
  get databasePath() { return process.env.DATABASE_PATH || path.join(__dirname, '..', 'db', 'app.sqlite'); },
  get visionProvider() { return (process.env.VISION_PROVIDER || 'fixture').toLowerCase(); },
  get embeddingProvider() { return (process.env.EMBEDDING_PROVIDER || 'cache').toLowerCase(); },
  get similarityThreshold() { return num('SIMILARITY_THRESHOLD', 0.5); },
  get lowConfidenceThreshold() { return num('LOW_CONFIDENCE_THRESHOLD', 0.6); },
  get costBudgetUsd() { return num('COST_BUDGET_USD', 1); },
  get embeddingModel() { return process.env.EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL || 'all-minilm'; },
};
