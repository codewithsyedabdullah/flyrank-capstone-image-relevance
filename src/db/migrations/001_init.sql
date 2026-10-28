-- 001_init.sql — full schema for the image relevance & auto-tagging engine.
-- Run by src/db/migrate.js in order. Tables per brief §6 + shared requirements.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- isolated tenants (shared requirement #4: isolated tenants)
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- corpus images; status drives the batch job (idempotent re-runs skip tagged)
CREATE TABLE IF NOT EXISTS images (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  file_path    TEXT NOT NULL,
  source_url   TEXT,
  license      TEXT,
  artist       TEXT,
  category_hint TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','tagged','flagged','failed')),
  low_confidence INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_images_tenant_status ON images(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_images_low_conf    ON images(low_confidence);

-- validated vision output (invalid model output is never stored as trusted)
CREATE TABLE IF NOT EXISTS image_metadata (
  image_id     TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  category     TEXT NOT NULL,
  caption      TEXT NOT NULL,
  confidence   REAL NOT NULL,
  attributes_json TEXT NOT NULL,
  raw_json     TEXT,
  schema_valid INTEGER NOT NULL DEFAULT 1,
  validated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one row per subject/category/attribute per image
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id   TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  tag_type   TEXT NOT NULL CHECK (tag_type IN ('subject','category','attribute')),
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tags_image ON tags(image_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag   ON tags(tag);

-- blog posts to match images against
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  category_hint TEXT,
  species_hint TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_tenant ON posts(tenant_id);

-- embeddings for images (caption) and posts (text); cosine computed in-app
CREATE TABLE IF NOT EXISTS embeddings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('image','post')),
  entity_id   TEXT NOT NULL,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_id, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_type, entity_id);

-- background batch jobs (tag / embed) with progress + failure alert flag
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('tag','embed')),
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','succeeded','failed')),
  total      INTEGER NOT NULL DEFAULT 0,
  processed  INTEGER NOT NULL DEFAULT 0,
  succeeded  INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  alert_sent INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_status ON jobs(tenant_id, status);

-- per-attempt evidence for retries (shared requirement: retries visible)
CREATE TABLE IF NOT EXISTS job_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  entity_ref  TEXT,
  attempt_no  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id);

-- one row per (post, image) candidate: rank, cosine score, guard verdict + why
CREATE TABLE IF NOT EXISTS suggestions (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  post_id        TEXT NOT NULL REFERENCES posts(id),
  image_id       TEXT NOT NULL REFERENCES images(id),
  rank           INTEGER NOT NULL,
  score          REAL NOT NULL,
  verdict        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (verdict IN ('approved','rejected','pending')),
  guard_rule     TEXT,
  reason         TEXT,
  guard_trace_json TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at    TEXT,
  reviewed_by    TEXT,
  UNIQUE (post_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_suggestions_post    ON suggestions(post_id, score);
CREATE INDEX IF NOT EXISTS idx_suggestions_tenant_verdict ON suggestions(tenant_id, verdict);

-- human-in-the-loop review (approve / reject / inspect why)
CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('approve','reject')),
  reviewer      TEXT,
  reason        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_suggestion ON reviews(suggestion_id);

-- per-call cost log: every vision/embedding call attributed (PROBE 6).
-- call_id UNIQUE makes re-logged entries idempotent.
CREATE TABLE IF NOT EXISTS cost_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id     TEXT NOT NULL UNIQUE,
  tenant_id   TEXT,
  provider    TEXT NOT NULL,
  model       TEXT,
  operation   TEXT NOT NULL CHECK (operation IN ('vision','embedding')),
  entity_ref  TEXT,
  input_units TEXT,
  cost_usd    REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'ok',
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cost_log_created   ON cost_log(created_at);
CREATE INDEX IF NOT EXISTS idx_cost_log_operation ON cost_log(operation);

-- labeled eval runs: top-1 precision history (PROBE 5)
CREATE TABLE IF NOT EXISTS eval_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset        TEXT,
  top1_precision REAL NOT NULL,
  total          INTEGER NOT NULL,
  correct        INTEGER NOT NULL,
  threshold      REAL,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- failure alerts from background jobs (shared requirement: failure alert)
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
