# EVIDENCE — one pasted proof per Section-6 requirement box (+ shared requirements)

All proofs are real command output from the committed code, captured
2026-10-27 (live API probes against a booted server) and 2026-10-28 (fresh
bootstrap, eval sweep, micro-proofs, full test suite) on the build machine
(Node v25.2.1, Windows 11). Providers for the committed runs:
`VISION_PROVIDER=fixture`, `EMBEDDING_PROVIDER=cache` (all-minilm vectors
committed in `data/vectors/`) — i.e. **keyless and $0**, exactly what an
evaluator gets on a clean clone.

Reproduce everything from scratch:

```
npm install
cp .env.example .env
npm run bootstrap     # migrate → seed → tag → embed → eval (one process, ~1 min)
npm start             # http://localhost:4317
npm test              # 55 tests
```

Live API proofs below were captured against a server booted on the bootstrap
database (`DATABASE_PATH` pointed at a temp SQLite file; `npm start` uses
`./db/app.sqlite`).

---

# Part A — Section 6 requirement boxes (13)

## AI processing

### Box 1 — Vision model produces structured output validated against a schema; invalid responses are never trusted

**Proof 1 — unit tests (Zod schema + never-trusted behavior):**

```
✔ Zod schema rejects incomplete vision output (1174.6077ms)
✔ Zod schema rejects out-of-range confidence and bad category (1.0643ms)
✔ invalid vision output throws SCHEMA_INVALID and never overwrites trusted metadata (1.9767ms)
✔ valid vision output is persisted: metadata + tags + status=tagged (31.9517ms)
```

**Proof 2 — live function demonstration** (invalid payload in → rejected result
out, no exception swallowed; produced 2026-10-28 by driving the committed
`validateVisionOutput()` directly — one-off verification harness, not shipped;
the same behavior is asserted by the unit tests below):

```
=== PROOF A — invalid vision output is rejected by the Zod schema (never trusted) ===
input: { subject: "fox" }  (missing category/attributes/caption/confidence)
result: {"ok":false,"error":"schema validation failed — category: Required; attributes: Required; caption: Required; confidence: Required"}
input: confidence=1.5, category="vehicle", attributes=[], caption="short"
result: {"ok":false,"error":"schema validation failed — category: Invalid enum value. Expected 'animal' | 'landscape' | 'object' | 'person' | 'plant' | 'other', received 'vehicle'; attributes: at least one attribute required; caption: caption must be at least 10 characters; confidence: confidence must be between 0 and 1"}
```

**Code:** `src/schema/vision.js` (schema: subject, category enum, ≥1 attribute,
caption ≥10 chars, confidence 0–1), `src/services/tagging.js` (`SCHEMA_INVALID`
propagates so the batch job retries, then fails the image — never persists).

**Reproduce:** `npm test` (tests/guard.test.js, tests/tagging.test.js)

### Box 2 — Low-confidence classifications are flagged instead of accepted

**Proof 1 — bootstrap run (56-image corpus):**

```
[bootstrap] tag job: 56/56 succeeded, 6 low-confidence flagged, 0 failed
low-confidence flagged images (6): img-ambiguous_canid-00(conf=0.53), img-ambiguous_canid-01(conf=0.51),
img-ambiguous_canid-02(conf=0.54), img-ambiguous_canid-03(conf=0.45), img-ambiguous_canid-04(conf=0.44),
img-ambiguous_canid-05(conf=0.55)
```

**Proof 2 — live API** (`GET /api/images?flagged=1`):

```json
{
  "http": 200,
  "count": 6,
  "flagged": [
    { "id": "img-ambiguous_canid-00", "subject": "canid (species uncertain)", "confidence": 0.53, "low_confidence": 1 },
    { "id": "img-ambiguous_canid-01", "subject": "canid (species uncertain)", "confidence": 0.51, "low_confidence": 1 },
    { "id": "img-ambiguous_canid-02", "subject": "canid (species uncertain)", "confidence": 0.54, "low_confidence": 1 },
    { "id": "img-ambiguous_canid-03", "subject": "canid (species uncertain)", "confidence": 0.45, "low_confidence": 1 },
    { "id": "img-ambiguous_canid-04", "subject": "canid (species uncertain)", "confidence": 0.44, "low_confidence": 1 },
    { "id": "img-ambiguous_canid-05", "subject": "canid (species uncertain)", "confidence": 0.55, "low_confidence": 1 }
  ]
}
```

These six are real iNaturalist genus-level *Canis* needs-ID observations —
the community itself could not separate wolf/dog/coyote — so the fixtures are
genuinely uncertain, and the system flags rather than guesses. Unit proof:
`✔ low-confidence output is FLAGGED, not silently accepted` and
`✔ confidence exactly at the floor is NOT flagged (>= comparison)`.

**Reproduce:** `npm run bootstrap` · `curl localhost:4317/api/images?flagged=1`

### Box 3 — Images are processed through a batch background job with retries

**Proof 1 — jobs list + job detail with per-batch attempts (live API, `GET /api/jobs` then `GET /api/jobs/:id`):**

```json
{
  "jobs": [
    { "id": "job-embed-mvr2ddll-y4u7p8", "type": "embed", "status": "succeeded", "total": 72, "succeeded": 72, "failed": 0 },
    { "id": "job-tag-mvr2dd04-6q1tg5", "type": "tag", "status": "succeeded", "total": 56, "succeeded": 56, "failed": 0 }
  ],
  "detail": {
    "id": "job-embed-mvr2ddll-y4u7p8",
    "type": "embed",
    "status": "succeeded",
    "total": 72, "succeeded": 72, "failed": 0,
    "attempts_count": 5,
    "attempts_sample": [
      { "entity_ref": "batch 1 (16 texts)", "attempt_no": 1, "status": "ok", "error": null, "started_at": "2026-10-27T19:13:52.698Z", "finished_at": "2026-10-27T19:13:52.701Z" },
      { "entity_ref": "batch 2 (16 texts)", "attempt_no": 1, "status": "ok", "error": null, "..." : "..." },
      { "entity_ref": "batch 3 (16 texts)", "attempt_no": 1, "status": "ok", "error": null, "..." : "..." }
    ]
  }
}
```

The tag job's detail carries all 56 per-image attempts (one row per image,
status `ok`) — asserted live by `tests/api.test.js` (`attempts.length === 56`,
every `status === 'ok'`).

**Proof 2 — retry path exercised by tests** (missing fixture → provider throws
→ exactly 3 attempts recorded → image `failed` → `partial_failure` alert → and
**no cost row** for a call that never completed):

```
✔ retries: a vision provider failure gets 3 recorded attempts, then the image fails + partial_failure alert
✔ budget guard: COST_BUDGET_USD=0 stops the tag job before spending + budget_exceeded alert
```

**Reproduce:** `npm test` (tests/jobs.test.js) · `GET /api/jobs` · `GET /api/jobs/:id`

## Matching system

### Box 4 — Vision and embedding costs are tracked per call

**Proof — live cost log** (`GET /api/costs`): 61 attributed calls — 56 vision
(fixture) + 5 embedding batches (cache/all-minilm; 72 texts ÷ 16 per batch =
ceil → 5). Every row: provider, model, operation, entity_ref, input_units,
cost_usd, status. `call_id` is UNIQUE so re-logging is a no-op (idempotent).

```json
{
  "summary": {
    "total_calls": 61,
    "total_cost_usd": 0,
    "budget_usd": 1,
    "budget_exceeded": false,
    "by_operation": [
      { "operation": "embedding", "calls": 5, "cost": 0 },
      { "operation": "vision", "calls": 56, "cost": 0 }
    ],
    "by_provider": [
      { "provider": "cache", "model": "all-minilm", "calls": 5, "cost": 0 },
      { "provider": "fixture", "model": "fixtures derived from iNaturalist metadata (FlyRank-blessed mock)", "calls": 56, "cost": 0 }
    ]
  },
  "sample_rows": [
    {
      "id": 61,
      "call_id": "embedding:job-embed-mvr2ddll-y4u7p8:b5:a1",
      "tenant_id": "default",
      "provider": "cache",
      "model": "all-minilm",
      "operation": "embedding",
      "entity_ref": "8 texts",
      "input_units": "8.0",
      "cost_usd": 0,
      "status": "ok",
      "error": null,
      "created_at": "2026-10-27 19:13:52"
    }
  ]
}
```

Unit proof (budget guard): `✔ budget guard: COST_BUDGET_USD=0 stops the tag job
before spending + budget_exceeded alert`.

**Reproduce:** `curl localhost:4317/api/costs` · `npm test` (tests/cost.test.js)

### Box 5 — Image and post embeddings are stored; posts return ranked image suggestions

**Proof 1 — counts** (`GET /api/health`): `"embeddings": 72` (56 image captions
+ 16 post texts), all under model `all-minilm`, 384-dim, L2-normalized.

**Proof 2 — ranked suggestions with guard verdicts** (`GET
/api/posts/p-fox-1/images?top=10`), verbatim:

```json
{
  "http": 200,
  "verdict": "match",
  "match": { "imageId": "img-red_fox-07", "subject": "red fox", "score": 0.8478 },
  "candidates": [
    { "id": "img-red_fox-07", "subject": "red fox", "score": 0.8478, "verdict": "approve",
      "reason": "Matched on subject \"red fox\" — semantic score 0.848 (>= 0.538), vision confidence 0.93 (>= 0.6)." },
    { "id": "img-red_fox-01", "subject": "red fox", "score": 0.7629, "verdict": "approve", "..." : "..." },
    { "id": "img-red_fox-03", "subject": "red fox", "score": 0.7620, "verdict": "approve", "..." : "..." },
    { "id": "img-red_fox-00", "subject": "red fox", "score": 0.7504, "verdict": "approve", "..." : "..." }
  ]
}
```

(The live response also carries `embeddingModel: "all-minilm"` and the active
`thresholds` — asserted in `tests/api.test.js`.)

**Reproduce:** `curl "localhost:4317/api/posts/p-fox-1/images?top=10"`

### Box 6 — Semantic matching works for equivalent concepts ("red fox" ↔ "Vulpes vulpes")

**Proof 1 — the brief's exact example, as a labeled eval row** (verbatim from
the eval run's per-post detail; post `p-fox-2`'s text is built from the same
iNaturalist observation as `img-red_fox-09`):

```
OK   p-fox-2 expected=img-red_fox-09 got=img-red_fox-09 score=0.8596 verdict=match
```

Full per-post detail at the chosen threshold — 15/15 correct, with the honest
margins visible (the two deer rows at 0.7987/0.7953 are why the threshold is
0.538, not higher):

```
OK   p-fox-1 expected=img-red_fox-07 got=img-red_fox-07 score=0.8478 verdict=match
OK   p-fox-2 expected=img-red_fox-09 got=img-red_fox-09 score=0.8596 verdict=match
OK   p-fox-3 expected=img-red_fox-00 got=img-red_fox-00 score=0.8525 verdict=match
OK   p-wolf-1 expected=img-wolf-04 got=img-wolf-04 score=0.9326 verdict=match
OK   p-wolf-2 expected=img-wolf-00 got=img-wolf-00 score=0.8868 verdict=match
OK   p-wolf-3 expected=img-wolf-06 got=img-wolf-06 score=0.9275 verdict=match
OK   p-dog-1 expected=img-dog-04 got=img-dog-04 score=0.8280 verdict=match
OK   p-dog-2 expected=img-dog-00 got=img-dog-00 score=0.8823 verdict=match
OK   p-dog-3 expected=img-dog-01 got=img-dog-01 score=0.8996 verdict=match
OK   p-bear-1 expected=img-bear-09 got=img-bear-09 score=0.8888 verdict=match
OK   p-bear-2 expected=img-bear-01 got=img-bear-01 score=0.8368 verdict=match
OK   p-bear-3 expected=img-bear-00 got=img-bear-00 score=0.8422 verdict=match
OK   p-deer-1 expected=img-deer-00 got=img-deer-00 score=0.8385 verdict=match
OK   p-deer-2 expected=img-deer-01 got=img-deer-01 score=0.7987 verdict=match
OK   p-deer-3 expected=img-deer-02 got=img-deer-02 score=0.7953 verdict=match
```

**Proof 2 — unit tests:**

```
✔ CONCEPT MATCH: fox post vector is much closer to fox image than wolf/dog
✔ the brief's example works: "Vulpes vulpes" post text matches the red fox photo
```

**Proof 3 — canonicalization inside the guard:** `Vulpes vulpes` → `red fox`
(see Box 7 proof; `guard.canonicalizeSpecies`).

**Reproduce:** `npm test` (tests/eval.test.js, tests/vectors.test.js)

## Safety layer

### Box 7 — The mismatch guard rejects incorrect recommendations (wolf-on-fox-post provably fails)

**Proof 1 — forced wolf on the fox post, live** (`GET
/api/posts/p-fox-1/images?force_image=img-wolf-00`):

```json
{
  "http": 200,
  "forced_candidate": {
    "id": "img-wolf-00",
    "subject": "gray wolf",
    "score": 0.3556,
    "verdict": "reject",
    "rule": "species_mismatch",
    "reason": "Animal category mismatch: expected red fox, detected gray wolf",
    "forced": true
  }
}
```

The same response shows the fox still winning: `match: img-red_fox-07 @
0.8478`. Forced dog (`img-dog-00`, score 0.3172) is rejected identically.

**Proof 2 — canonicalization + rejection demo** (pure functions, run against
the committed guard — one-off verification harness, 2026-10-28; both functions
are unit-tested in `tests/guard.test.js`):

```
=== PROOF B — guard canonicalization + wolf-on-fox-post rejection (pure functions) ===
canonicalizeSpecies("Vulpes vulpes")  = red fox
canonicalizeSpecies("red fox")        = red fox
canonicalizeSpecies("Canis lupus")    = gray wolf
evaluateGuard(wolf on fox post): {"verdict":"reject","rule":"species_mismatch","reason":"Animal category mismatch: expected red fox, detected gray wolf"}
trace rules: unvalidated_output=true species_mismatch=false below_threshold=false low_confidence=true
```

**Reproduce:** `curl "localhost:4317/api/posts/p-fox-1/images?force_image=img-wolf-00&top=3"` · `npm test` (tests/guard.test.js, tests/eval.test.js)

### Box 8 — Rejections include a human-readable explanation

**Proof — inspect-why on the refused wolf suggestion** (`GET
/api/suggestions/sg-p-fox-1-img-wolf-00/why`), verbatim — rule, reason, and
the full 4-rule trace (boolean `pass` on every rule):

```json
{
  "http": 200,
  "suggestionId": "sg-p-fox-1-img-wolf-00",
  "score": 0.355592668692934,
  "verdict": "rejected",
  "guardRule": "species_mismatch",
  "reason": "Animal category mismatch: expected red fox, detected gray wolf",
  "guardTrace": [
    { "rule": "unvalidated_output", "pass": true,  "detail": "vision output passed schema validation" },
    { "rule": "species_mismatch",   "pass": false, "detail": "Animal category mismatch: expected red fox, detected gray wolf" },
    { "rule": "below_threshold",    "pass": false, "detail": "semantic similarity 0.356 vs threshold 0.538" },
    { "rule": "low_confidence",     "pass": true,  "detail": "vision confidence 0.97 vs floor 0.6" }
  ]
}
```

**Reproduce:** `curl localhost:4317/api/suggestions/sg-p-fox-1-img-wolf-00/why`

### Box 9 — When no image clears the bar: "no confident match" + reasons

**Proof — snow-leopard post (out of corpus), live** (`GET
/api/posts/p-other-1/images`):

```json
{
  "http": 200,
  "verdict": "no_confident_match",
  "match": null,
  "reasons": [
    { "imageId": "img-bear-04", "subject": "bear", "score": 0.4672, "rule": "below_threshold",
      "reason": "semantic similarity 0.467 vs threshold 0.538" },
    { "imageId": "img-bear-05", "subject": "bear", "score": 0.4672, "rule": "below_threshold",
      "reason": "semantic similarity 0.467 vs threshold 0.538" },
    { "imageId": "img-bear-07", "subject": "bear", "score": 0.4243, "rule": "below_threshold",
      "reason": "semantic similarity 0.424 vs threshold 0.538" }
  ]
}
```

No guessed best-effort image: `match` is `null`, and the refusal carries the
per-candidate reasons. Unit proof: `✔ out-of-corpus post refuses honestly:
no_confident_match + per-candidate reasons`.

**Reproduce:** `curl localhost:4317/api/posts/p-other-1/images` · `npm test`

## Backend

### Box 10 — Database models for images, tags, embeddings, posts, suggestions, approvals/rejections — with the required indexes

**Proof 1 — live schema inspection** (`sqlite_master` on the running
database, 2026-10-28) — 13 app tables + 13 indexes + row
counts:

```
=== PROOF E — persistence: tables + indexes actually present in the database ===
tables (15): alerts, cost_log, embeddings, eval_runs, image_metadata, images, job_attempts, jobs, posts, reviews, schema_migrations, sqlite_sequence, suggestions, tags, tenants
indexes (13): idx_cost_log_created ON cost_log | idx_cost_log_operation ON cost_log | idx_embeddings_entity ON embeddings | idx_images_low_conf ON images | idx_images_tenant_status ON images | idx_job_attempts_job ON job_attempts | idx_jobs_tenant_status ON jobs | idx_posts_tenant ON posts | idx_reviews_suggestion ON reviews | idx_suggestions_post ON suggestions | idx_suggestions_tenant_verdict ON suggestions | idx_tags_image ON tags | idx_tags_tag ON tags
row counts: {"alerts":0,"cost_log":62,"embeddings":72,"eval_runs":1,"image_metadata":56,"images":56,"job_attempts":62,"jobs":4,"posts":16,"reviews":2,"schema_migrations":1,"sqlite_sequence":6,"suggestions":402,"tags":292,"tenants":1}
```

(`sqlite_sequence` is SQLite's internal AUTOINCREMENT counter. `cost_log` 62 =
61 bootstrap calls + the forced re-tag probe's single vision call;
`suggestions` 402 reflects extra probe queries — suggestion upserts are
idempotent per (post, image).)

**Proof 2 — the migration itself:** `src/db/migrations/001_init.sql` (DDL for
all 13 tables; indexes on every FK and query path — `idx_images_tenant_status`,
`idx_images_low_conf`, `idx_tags_image`, `idx_tags_tag`, `idx_posts_tenant`,
`idx_embeddings_entity`, `idx_jobs_tenant_status`, `idx_job_attempts_job`,
`idx_suggestions_post`, `idx_suggestions_tenant_verdict`,
`idx_reviews_suggestion`, `idx_cost_log_created`, `idx_cost_log_operation`;
UNIQUE on `embeddings(entity_type,entity_id,model)`,
`suggestions(post_id,image_id)`, `cost_log.call_id`).

**Reproduce:** `cat src/db/migrations/001_init.sql` · `curl localhost:4317/api/health`

### Box 11 — API endpoints validated; the review workflow (approve / reject / inspect why) exists

**Proof 1 — full review flow, live** (approve the fox suggestion, reject the
wolf one with a reason; both persisted and visible via inspect-why):

```json
{
  "approve": {
    "http": 200,
    "body": {
      "suggestionId": "sg-p-fox-1-img-red_fox-07",
      "action": "approve",
      "reviewedAt": "2026-10-27T19:14:24.404Z",
      "suggestion": { "id": "sg-p-fox-1-img-red_fox-07", "post_id": "p-fox-1",
        "image_id": "img-red_fox-07", "rank": 1, "score": 0.8478060640952775,
        "verdict": "approved", "guard_rule": null,
        "reason": "Matched on subject \"red fox\" — semantic score 0.848 (>= 0.538), vision confidence 0.93 (>= 0.6).",
        "reviewed_by": "probe-script", "..." : "..." }
    }
  },
  "reject": {
    "http": 200,
    "body": {
      "suggestionId": "sg-p-fox-1-img-wolf-00",
      "action": "reject",
      "reviewedAt": "2026-10-27T19:14:24.413Z",
      "suggestion": { "id": "sg-p-fox-1-img-wolf-00", "rank": 26, "score": 0.355592668692934,
        "verdict": "rejected", "guard_rule": "species_mismatch",
        "reason": "Animal category mismatch: expected red fox, detected gray wolf",
        "reviewed_by": "probe-script", "..." : "..." }
    }
  },
  "why_after_review": {
    "verdict": "approved",
    "review": { "id": 1, "suggestion_id": "sg-p-fox-1-img-red_fox-07",
      "action": "approve", "reviewer": "probe-script", "reason": null,
      "created_at": "2026-10-27 19:14:24" }
  }
}
```

**Proof 2 — validation at those endpoints** (reject without a reason → clean
400, not a 500):

```json
{ "http": 400, "body": { "error": "validation failed", "details": ["reason: Required"] } }
```

**Reproduce:** `POST /api/suggestions/:id/approve` · `POST
/api/suggestions/:id/reject` · `GET /api/suggestions/:id/why`

## Quality & documentation

### Box 12 — A small labeled evaluation dataset measures top-1 precision — the number is in the README

**Proof 1 — eval run output** (verbatim from `npm run bootstrap`, which runs
the same `runEval()` as `npm run eval`):

```
[eval] dataset: seeds/eval-set.json (15 labeled posts)
[eval] embedding model: all-minilm | vision: fixture
[eval] sweeping SIMILARITY_THRESHOLD...
  threshold=0.300  precision=15/15 = 1.000
  threshold=0.325  precision=15/15 = 1.000
  threshold=0.350  precision=15/15 = 1.000
  threshold=0.375  precision=15/15 = 1.000
  threshold=0.400  precision=15/15 = 1.000
  threshold=0.425  precision=15/15 = 1.000
  threshold=0.450  precision=15/15 = 1.000
  threshold=0.475  precision=15/15 = 1.000
  threshold=0.500  precision=15/15 = 1.000
  threshold=0.525  precision=15/15 = 1.000
  threshold=0.550  precision=15/15 = 1.000
  threshold=0.575  precision=15/15 = 1.000
  threshold=0.600  precision=15/15 = 1.000
  threshold=0.625  precision=15/15 = 1.000
  threshold=0.650  precision=15/15 = 1.000
  threshold=0.675  precision=15/15 = 1.000
  threshold=0.700  precision=15/15 = 1.000
  threshold=0.725  precision=15/15 = 1.000
  threshold=0.750  precision=15/15 = 1.000
  threshold=0.775  precision=15/15 = 1.000
  threshold=0.800  precision=13/15 = 0.867

[eval] max precision 1.000 achieved on band [0.300, 0.775] -> chosen midpoint 0.538

==========================================
TOP-1 PRECISION: 15/15 = 1.000
SIMILARITY_THRESHOLD=0.538 (band [0.3, 0.775])
==========================================
```

**Proof 2 — recorded run, live API** (`GET /api/eval`):

```json
{
  "latest": {
    "id": 1,
    "dataset": "seeds/eval-set.json",
    "top1_precision": 1,
    "total": 15,
    "correct": 15,
    "threshold": 0.538,
    "notes": "model=all-minilm; vision=fixture; band=[0.3,0.775] midpoint; top-1 = first guard-approved candidate equals labeled image",
    "created_at": "2026-10-27 19:14:05"
  }
}
```

**README states the same number** (headline + §Eval): "top-1 precision 15/15 =
1.000 at SIMILARITY_THRESHOLD=0.538". The labeled set itself:
`seeds/eval-set.json` — 15 posts, each with `correctImageId`, expected species,
and the iNaturalist observation ID the post text was built from. Honest margin
note: at 0.800 precision drops to 13/15 (two deer posts' own photos score
0.7953/0.7987) — documented in README §Eval.

**Reproduce:** `npm run eval` · `curl localhost:4317/api/eval`

### Box 13 — README with architecture explanation and diagram; required files present

**Proof 1 — required-files check** (file-existence scan against the repo
root, 2026-10-28):

```
=== PROOF F — required submission files present ===
PRESENT  README.md
PRESENT  capstone.yaml
PRESENT  EVIDENCE.md
PRESENT  BUILDLOG.md
PRESENT  .env.example
PRESENT  LICENSE
PRESENT  .gitignore
PRESENT  DESIGN.md
```

**Proof 2 — README contents:** architecture diagram (§Architecture), exact
run + seed steps (§Quickstart), the eval number (headline + §Eval), honest
limitations (§Limitations, 7 items).

**Reproduce:** `ls README.md capstone.yaml EVIDENCE.md BUILDLOG.md DESIGN.md .env.example LICENSE .gitignore`

---

# Part B — Shared requirements (7)

### 1. Layered architecture — data / logic / HTTP separated

**Proof — automated layer-isolation scan** (who is allowed to touch what;
source scan, 2026-10-28):

```
=== PROOF C — layer isolation (who requires node:sqlite / express) ===
files requiring node:sqlite: ["src\db\index.js"]
files requiring express   : ["src\routes\api.js","src\server.js"]
```

`node:sqlite` appears only in the data layer (`src/db/`); `express` only in
HTTP-layer files (`src/server.js` boot + `src/routes/api.js` router). Services,
repositories, jobs and providers import neither. Routes never touch the
database; services never touch HTTP. Layer sketch in DESIGN.md §4.

**Reproduce:** `grep -rl "node:sqlite" src/` · `grep -rl "express" src/`

### 2. Validation at the boundary — bad input → clean 4xx, never a 500

**Proof — live boundary transcript:**

```json
// POST /api/suggestions/sg-.../reject without "reason"
{ "http": 400, "body": { "error": "validation failed", "details": ["reason: Required"] } }

// GET /api/posts/p-fox-1/images?force_image=img-nonexistent-99
{ "http": 400, "body": { "error": "force_image img-nonexistent-99 is not a valid image id" } }

// GET /api/posts/nope-not-real/images
{ "http": 404, "body": { "error": "post not found: nope-not-real" } }

// GET /api/totally-bogus
{ "http": 404, "body": { "error": "not found", "path": "/api/totally-bogus" } }

The same boundary also returns a clean `400` for a malformed JSON request body
(`request body must be valid JSON (max 1mb)`) — covered by
`tests/api.test.js` (`boundary: malformed JSON body -> clean 400, no stack
trace`), which additionally asserts no stack trace leaks.

Plus idempotency boundary: re-tagging a tagged image → `409` with a clean
message (`image img-red_fox-00 is already tagged — pass ?force=true to re-tag`).
19 API tests cover these paths (`tests/api.test.js`).

**Reproduce:** the curls above against `npm start` · `npm test`

### 3. ≥1 background job — slow/bulk work off the request path, retries + failure alert

**Proof — retry + alert machinery, exercised by tests:**

```
✔ retries: a vision provider failure gets 3 recorded attempts, then the image fails + partial_failure alert (493.4326ms)
✔ budget guard: COST_BUDGET_USD=0 stops the tag job before spending + budget_exceeded alert (9.7245ms)
✔ job crash path (LAST — mutates VISION_PROVIDER): gemini without key -> job failed + job_crash alert (12.0891ms)
```

Job rows carry `status/total/succeeded/failed/alert_sent`; every attempt is a
`job_attempts` row (see Box 3 proof); alerts are queryable at
`GET /api/alerts` (empty on a clean run — proof in the live transcript:
`{ "count": 0, "alerts": [] }`).

**Reproduce:** `npm test` (tests/jobs.test.js) · `GET /api/jobs` · `GET /api/alerts`

### 4. Real persistence — schema as migrations, right indexes, isolated tenants

**Proof:** migration DDL `src/db/migrations/001_init.sql` applied by
`src/db/migrate.js` with a `schema_migrations` ledger (see Box 10 proof for
the live table+index+row-count inspection). Tenant isolation: every scoped
table carries `tenant_id` (`images`, `posts`, `suggestions`, `jobs`,
`cost_log`); `TENANT_ID` env selects the tenant; repositories filter by it.
Tests run against per-process temp databases, so suites never share state.

**Reproduce:** `cat src/db/migrations/001_init.sql` · `GET /api/health`

### 5. Idempotency where it matters — the retried action happens once

**Proof — live transcript:**

```json
// re-tag an already-tagged image without force
{ "without_force": { "http": 409, "body": { "error": "image img-red_fox-00 is already tagged — pass ?force=true to re-tag" } } }
// same call with force
{ "with_force": { "http": 200, "ok": true, "flagged": false, "subject": "red fox" } }

// POST /api/jobs/tag on a fully tagged corpus -> job succeeds with 0 to do
{ "http": 202, "body": { "jobId": "job-tag-mvr2e25n-sxjhqt", "status": "queued", "deduped": false } }
```

Also: embed job skips entities already embedded under the same model
(`imagesForEmbedding`/`postsForEmbedding` LEFT JOIN); suggestion upsert is
`ON CONFLICT (post_id, image_id)`; cost rows are UNIQUE by `call_id`; job
start dedupes against an active job (`deduped: true` returns the existing job
— covered by `✔ idempotency: re-running tag and embed jobs on a done corpus is
a 0-row no-op` and the dedupe test).

**Reproduce:** `POST /api/images/img-red_fox-00/tag` (409) → `?force=true` (200) · `npm test`

### 6. Secrets clean — env only, never logged

**Proof 1 — `.env` is gitignored before the first commit:**

```
$ git check-ignore -v .env
.gitignore:3:.env   .env
```

**Proof 2 — automated secret-pattern scan** (`ghp_`, `hf_`, `gsk_`, `nfp_`,
`sk-`, `AKIA`) over `src/`, `scripts/`, `seeds/`, `tests/`
(pattern scan, 2026-10-28):

```
=== PROOF D — no secrets in source (patterns: ghp_ hf_ gsk_ nfp_ sk- AKIA) ===
no secret patterns found in src/, scripts/, seeds/, tests/
```

**Proof 3 — `.env.example` ships placeholders only** (`GEMINI_API_KEY=`,
`HF_TOKEN=` — empty values, safe to commit).

**Reproduce:** `git check-ignore -v .env` · `cat .env.example`

### 7. Cost tracked per call, attributed, with a budget guard

**Proof:** Box 4 (61 attributed calls) + budget guard tests:

```
✔ budget guard: COST_BUDGET_USD=0 stops the tag job before spending + budget_exceeded alert
```

With `COST_BUDGET_USD=0` the tag job refuses to start spending
(`summary.budgetStopped=true`), the job row fails with a budget error, a
`budget_exceeded` alert is raised, and the pending image is left untouched.
`GET /api/costs` reports `budget_usd` and `budget_exceeded` live.

**Reproduce:** `COST_BUDGET_USD=0 npm run tag` · `curl localhost:4317/api/costs`

---

# Reproduction notes

- All live transcripts above were captured 2026-10-27 against the committed
  code with keyless providers; counts may shift by a few suggestion rows if
  probes are re-run (suggestions are persisted per query).
- The 6 flagged images are deliberate: genus-level *Canis* observations the
  iNaturalist community itself left as needs-ID. Honest uncertainty, flagged —
  not a pipeline defect.
- `npm test` = 55/55 passing at submission (guard 9, tagging 6, vectors 7,
  cost 4, jobs 5, api 19, eval 5).
