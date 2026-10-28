/**
 * migrate.js — tiny migration runner. Applies src/db/migrations/*.sql in
 * filename order, tracks applied versions in schema_migrations, runs each
 * migration in a transaction. Idempotent: re-runs are no-ops.
 */
const fs = require('fs');
const path = require('path');
const { getDb } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrate() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(path.basename(file).split('_')[0], 10);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${e.message}`);
    }
  }
  console.log(`[migrate] done (applied: ${files.map((f) => f).join(', ') || 'none new'})`);
  return files.length;
}

if (require.main === module) {
  try {
    migrate();
    console.log('Schema is up to date.');
  } catch (e) {
    console.error('MIGRATION FAILED:', e.message);
    process.exitCode = 1;
  }
}

module.exports = { migrate };
