/**
 * repositories/index.js — the data layer. All SQL lives here; services and
 * routes never touch the database directly (shared requirement #1: layered
 * architecture). SQLite via node:sqlite; vectors stored as JSON, cosine
 * computed in-app (brief §10: in-DB arrays fine at this scale).
 */
const { getDb } = require('../db');

function upsertImage(entry) {
  const db = getDb();
  db.prepare(
    `INSERT INTO images (id, tenant_id, file_path, source_url, license, artist, category_hint)
     VALUES (?, 'default', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, source_url=excluded.source_url,
       license=excluded.license, artist=excluded.artist, category_hint=excluded.category_hint`
  ).run(entry.id, entry.localPath, entry.sourceUrl, entry.license, entry.artist, entry.speciesHint);
}

function getImage(id) {
  return getDb().prepare('SELECT * FROM images WHERE id = ?').get(id);
}

function listImages({ status, flagged, limit = 200 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (flagged === '1' || flagged === 'true') { where.push('low_confidence = 1'); }
  const sql = `SELECT * FROM images ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function imagesForTagging(force = false) {
  const db = getDb();
  return force
    ? db.prepare(`SELECT * FROM images ORDER BY id`).all()
    : db.prepare(`SELECT * FROM images WHERE status = 'pending' ORDER BY id`).all();
}

function updateImageStatus(id, status, { error = null, lowConfidence = null } = {}) {
  const db = getDb();
  const fields = ['status = ?', "updated_at = datetime('now')"];
  const params = [status];
  if (lowConfidence !== null) { fields.push('low_confidence = ?'); params.push(lowConfidence ? 1 : 0); }
  if (error !== null) { fields.push('error = ?'); params.push(error); }
  params.push(id);
  db.prepare(`UPDATE images SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

function upsertMetadata(imageId, data, rawJson) {
  const db = getDb();
  db.prepare(
    `INSERT INTO image_metadata (image_id, subject, category, caption, confidence, attributes_json, raw_json, schema_valid)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(image_id) DO UPDATE SET subject=excluded.subject, category=excluded.category,
       caption=excluded.caption, confidence=excluded.confidence, attributes_json=excluded.attributes_json,
       raw_json=excluded.raw_json, schema_valid=1, validated_at=datetime('now')`
  ).run(imageId, data.subject, data.category, data.caption, data.confidence, JSON.stringify(data.attributes), JSON.stringify(rawJson));
}

function getMetadata(imageId) {
  const row = getDb().prepare('SELECT * FROM image_metadata WHERE image_id = ?').get(imageId);
  if (row) {
    row.attributes = JSON.parse(row.attributes_json);
    try { row.raw = JSON.parse(row.raw_json); } catch { row.raw = null; }
  }
  return row;
}

function replaceTags(imageId, data) {
  const db = getDb();
  db.prepare('DELETE FROM tags WHERE image_id = ?').run(imageId);
  const ins = db.prepare('INSERT INTO tags (image_id, tag, tag_type, confidence) VALUES (?, ?, ?, ?)');
  ins.run(imageId, data.subject, 'subject', data.confidence);
  ins.run(imageId, data.category, 'category', data.confidence);
  for (const a of data.attributes) ins.run(imageId, a, 'attribute', data.confidence);
}

function tagsForImage(imageId) {
  return getDb().prepare('SELECT tag, tag_type, confidence FROM tags WHERE image_id = ? ORDER BY tag_type, tag').all(imageId);
}

function upsertPost(p) {
  const db = getDb();
  db.prepare(
    `INSERT INTO posts (id, tenant_id, title, body, category_hint, species_hint)
     VALUES (?, 'default', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body,
       category_hint=excluded.category_hint, species_hint=excluded.species_hint`
  ).run(p.id, p.title, p.body, p.categoryHint, p.speciesHint);
}

function listPosts() {
  return getDb().prepare('SELECT id, title, body, category_hint, species_hint FROM posts ORDER BY id').all();
}

function getPost(id) {
  return getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

function upsertEmbedding({ entityType, entityId, model, vector }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO embeddings (entity_type, entity_id, model, dim, vector_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id, model) DO UPDATE SET vector_json=excluded.vector_json, dim=excluded.dim, model=excluded.model`
  ).run(entityType, entityId, model, vector.length, JSON.stringify(vector));
}

function embeddingFor(entityType, entityId, model = null) {
  const sql = model
    ? 'SELECT * FROM embeddings WHERE entity_type = ? AND entity_id = ? AND model = ?'
    : 'SELECT * FROM embeddings WHERE entity_type = ? AND entity_id = ?';
  const row = getDb().prepare(sql).get(...(model ? [entityType, entityId, model] : [entityType, entityId]));
  if (row) row.vector = JSON.parse(row.vector_json);
  return row;
}

function imagesForEmbedding(model) {
  // images with validated metadata but no embedding yet FOR THIS MODEL
  return getDb().prepare(
    `SELECT i.id, im.caption, im.attributes_json FROM images i
     JOIN image_metadata im ON im.image_id = i.id
     LEFT JOIN embeddings e ON e.entity_type = 'image' AND e.entity_id = i.id AND e.model = ?
     WHERE e.id IS NULL ORDER BY i.id`
  ).all(model).map((r) => ({ ...r, attributes: JSON.parse(r.attributes_json) }));
}

function postsForEmbedding(model) {
  return getDb().prepare(
    `SELECT p.id, p.title, p.body FROM posts p
     LEFT JOIN embeddings e ON e.entity_type = 'post' AND e.entity_id = p.id AND e.model = ?
     WHERE e.id IS NULL ORDER BY p.id`
  ).all(model);
}

function imageCandidatesWithVectors(model) {
  return getDb().prepare(
    `SELECT i.id AS image_id, i.low_confidence, im.subject, im.category, im.caption, im.confidence,
            im.attributes_json, im.schema_valid, e.vector_json
     FROM images i
     JOIN image_metadata im ON im.image_id = i.id
     JOIN embeddings e ON e.entity_type = 'image' AND e.entity_id = i.id AND e.model = ?
     ORDER BY i.id`
  ).all(model).map((row) => ({
    ...row,
    attributes: JSON.parse(row.attributes_json),
    vector: JSON.parse(row.vector_json),
  }));
}

function createJob({ tenantId, type, total }) {
  const db = getDb();
  const id = `job-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO jobs (id, tenant_id, type, total) VALUES (?, ?, ?, ?)').run(id, tenantId, type, total);
  return { id };
}

function getJob(id) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (job) job.attempts = db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY id').all(job.id);
  return job;
}

function activeJob(tenantId, type) {
  return getDb().prepare(`SELECT * FROM jobs WHERE tenant_id = ? AND type = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(tenantId, type);
}

const JOB_UPDATABLE = ['status', 'total', 'processed', 'succeeded', 'failed', 'alert_sent', 'error', 'started_at', 'finished_at'];
function updateJob(id, fields) {
  const db = getDb();
  const keys = Object.keys(fields).filter((k) => JOB_UPDATABLE.includes(k));
  if (!keys.length) return;
  const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

function addAttempt({ jobId, entityRef, attemptNo, status, error = null, startedAt = null, finishedAt = null }) {
  getDb().prepare(
    'INSERT INTO job_attempts (job_id, entity_ref, attempt_no, status, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(jobId, entityRef, attemptNo, status, error, startedAt, finishedAt);
}

function upsertSuggestion(s) {
  const db = getDb();
  db.prepare(
    `INSERT INTO suggestions (id, tenant_id, post_id, image_id, rank, score, verdict, guard_rule, reason, guard_trace_json)
     VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id, image_id) DO UPDATE SET rank=excluded.rank, score=excluded.score, verdict=excluded.verdict,
       guard_rule=excluded.guard_rule, reason=excluded.reason, guard_trace_json=excluded.guard_trace_json,
       reviewed_at=NULL, reviewed_by=NULL`
  ).run(s.id, s.postId, s.imageId, s.rank, s.score, s.verdict, s.guardRule, s.reason, JSON.stringify(s.trace));
}

function suggestionsForPost(postId) {
  return getDb().prepare(
    `SELECT s.*, i.status AS image_status, im.subject, im.confidence AS vision_confidence
     FROM suggestions s
     JOIN images i ON i.id = s.image_id
     LEFT JOIN image_metadata im ON im.image_id = s.image_id
     WHERE s.post_id = ? ORDER BY s.rank`
  ).all(postId).map((r) => ({ ...r, guard_trace: JSON.parse(r.guard_trace_json || '[]') }));
}

function getSuggestion(id) {
  const row = getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (row) row.guard_trace = JSON.parse(row.guard_trace_json || '[]');
  return row;
}

function reviewSuggestion(id, { action, reviewer, reason }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE suggestions SET verdict = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?`).run(action === 'approve' ? 'approved' : 'rejected', now, reviewer || 'api', id);
  db.prepare('INSERT INTO reviews (suggestion_id, action, reviewer, reason) VALUES (?, ?, ?, ?)').run(id, action, reviewer || 'api', reason || null);
  return { suggestionId: id, action, reviewedAt: now };
}

function reviewsForSuggestion(suggestionId) {
  return getDb().prepare('SELECT * FROM reviews WHERE suggestion_id = ? ORDER BY id').all(suggestionId);
}

function addAlert({ jobId, kind, message }) {
  getDb().prepare('INSERT INTO alerts (job_id, kind, message) VALUES (?, ?, ?)').run(jobId || null, kind, message);
}

function listAlerts() {
  return getDb().prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 50').all();
}

function recordEvalRun({ dataset, top1Precision, total, correct, threshold, notes }) {
  getDb().prepare(
    'INSERT INTO eval_runs (dataset, top1_precision, total, correct, threshold, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(dataset, top1Precision, total, correct, threshold, notes);
}

function latestEval() {
  return getDb().prepare('SELECT * FROM eval_runs ORDER BY id DESC LIMIT 1').get();
}

function listJobs({ type = null, limit = 20 } = {}) {
  return type
    ? getDb().prepare('SELECT * FROM jobs WHERE type = ? ORDER BY created_at DESC LIMIT ?').all(type, limit)
    : getDb().prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function recentCostCalls(limit = 20) {
  return getDb().prepare('SELECT * FROM cost_log ORDER BY id DESC LIMIT ?').all(limit);
}

function recentEvalRuns(limit = 5) {
  return getDb().prepare('SELECT * FROM eval_runs ORDER BY id DESC LIMIT ?').all(limit);
}

function healthCounts() {
  const db = getDb();
  const c = (sql) => db.prepare(sql).get().n;
  return {
    images: c('SELECT COUNT(*) AS n FROM images'),
    images_tagged: c("SELECT COUNT(*) AS n FROM images WHERE status = 'tagged'"),
    images_flagged: c('SELECT COUNT(*) AS n FROM images WHERE low_confidence = 1'),
    images_failed: c("SELECT COUNT(*) AS n FROM images WHERE status = 'failed'"),
    metadata: c('SELECT COUNT(*) AS n FROM image_metadata'),
    embeddings: c('SELECT COUNT(*) AS n FROM embeddings'),
    posts: c('SELECT COUNT(*) AS n FROM posts'),
    suggestions: c('SELECT COUNT(*) AS n FROM suggestions'),
    suggestions_approved: c("SELECT COUNT(*) AS n FROM suggestions WHERE verdict = 'approved'"),
    cost_calls: c('SELECT COUNT(*) AS n FROM cost_log'),
    cost_total_usd: db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS t FROM cost_log').get().t,
  };
}

function ensureTenant(id = 'default') {
  getDb().prepare('INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)').run(id, id);
}

module.exports = {
  ensureTenant,
  upsertImage, getImage, listImages, imagesForTagging, updateImageStatus,
  upsertMetadata, getMetadata, replaceTags, tagsForImage,
  upsertPost, listPosts, getPost,
  upsertEmbedding, embeddingFor, imagesForEmbedding, postsForEmbedding, imageCandidatesWithVectors,
  createJob, getJob, activeJob, updateJob, addAttempt,
  upsertSuggestion, suggestionsForPost, getSuggestion, reviewSuggestion, reviewsForSuggestion,
  addAlert, listAlerts, recordEvalRun, latestEval, recentEvalRuns, listJobs, recentCostCalls, healthCounts,
};
