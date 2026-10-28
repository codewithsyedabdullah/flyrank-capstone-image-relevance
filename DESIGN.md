# Design — AI Image Understanding & Content Matching Engine (as built)

One page, per the capstone ground rules: problem, data model, API surface, layer
sketch, the guard, eval method, one explicit non-goal. Everything below
describes the code in `src/` as it ships — not the plan.

## 1. Problem

A blog CMS must pair each article with the most relevant image from a library
**by meaning, not filename or keywords**. A wrong pairing (a wolf on a red-fox
post) is worse than no pairing. So: tag images with schema-validated vision
output, embed captions and posts into one semantic space, rank candidates, and
— the production-critical part — **refuse with a human-readable explanation
when nothing clears the bar**.

## 2. Data model (SQLite; `src/db/migrations/001_init.sql`, applied by `migrate.js`)

| Table | Purpose | Indexes / constraints |
|---|---|---|
| `schema_migrations` | applied-migration ledger | PK version |
| `tenants` | isolated tenants (`default` seeded) | `name` UNIQUE |
| `images` | corpus rows; `status` ∈ pending/tagged/flagged/failed; `low_confidence` flag; `error` | PK; `idx_images_tenant_status`, `idx_images_low_conf` |
| `image_metadata` | **validated** vision output: subject, category, caption, confidence, `attributes_json`, `raw_json`, `schema_valid` | PK `image_id` (1:1 with images) |
| `tags` | one row per subject/category/attribute per image | `idx_tags_image`, `idx_tags_tag` |
| `posts` | blog posts to match (title, body, hints) | PK; `idx_posts_tenant` |
| `embeddings` | vectors for images (caption text) and posts (title+body); `vector_json`, `dim`, `model` | UNIQUE `(entity_type, entity_id, model)`; `idx_embeddings_entity` |
| `jobs` | tag/embed batch runs: status, total/processed/succeeded/failed, `alert_sent`, error | PK; `idx_jobs_tenant_status` |
| `job_attempts` | **every** retry attempt (ok/error + error message) — visible retry evidence | `idx_job_attempts_job` |
| `suggestions` | one row per judged (post, image): rank, cosine score, verdict, `guard_rule`, `reason`, `guard_trace_json`, review state | UNIQUE `(post_id, image_id)`; `idx_suggestions_post`, `idx_suggestions_tenant_verdict` |
| `reviews` | human approve/reject: action, reviewer, reason | `idx_reviews_suggestion` |
| `cost_log` | **every** vision/embedding call attributed: provider, model, operation, entity_ref, input_units, cost_usd, status | `call_id` UNIQUE (idempotent logging); `idx_cost_log_created`, `idx_cost_log_operation` |
| `alerts` | job failure alerts: partial_failure, budget_exceeded, job_crash | job_id |
| `eval_runs` | labeled-eval history: dataset, top1_precision, total/correct, threshold, notes | — |

Vectors are stored as JSON and cosine is computed in-app: at ~50 images this is
trivial, and brief §10 explicitly allows in-DB arrays at this scale. The
repository layer (`src/repositories/`) isolates the storage choice — a
Postgres+pgvector swap touches repository files only.

## 3. API surface (JSON everywhere; Zod at the boundary → clean 4xx, never a 500)

| Method + path | Purpose |
|---|---|
| `GET /` | service identity |
| `GET /api/health` | liveness + corpus counts + providers + thresholds |
| `GET /api/images?status=&flagged=&limit=` | image admin table |
| `GET /api/images/:id` | metadata + tags + embedding identity |
| `POST /api/images/:id/tag?force=` | (re)tag one image synchronously (409 unless force) |
| `GET /api/posts` · `GET /api/posts/:id` | posts |
| `GET /api/posts/:id/images?top=5&force_image=` | **ranked, guard-judged suggestions** (`force_image` provokes PROBE 3) |
| `GET /api/posts/:id/suggestions` | persisted suggestions for a post |
| `GET /api/suggestions/:id/why` | inspect why — selected **or** refused (score, rule, reason, full trace, review) |
| `POST /api/suggestions/:id/approve` | review `{reviewer}` |
| `POST /api/suggestions/:id/reject` | review `{reviewer, reason}` (reason required ≥3 chars) |
| `POST /api/jobs/tag` · `POST /api/jobs/embed` | start/return batch job (202; deduped; idempotent) |
| `GET /api/jobs?type=` · `GET /api/jobs/:id` | job list / detail incl. retry attempts |
| `GET /api/costs` | per-call cost log summary + rows + budget status |
| `GET /api/eval` | latest labeled-eval run + history |
| `GET /api/alerts` | failure alerts |

Error middleware maps coded errors: `NOT_FOUND`→404, `BAD_FORCE_IMAGE`/
`VALIDATION`→400, `ALREADY_TAGGED`/`NO_EMBEDDING`/`NO_CANDIDATES`/
`BUDGET_EXCEEDED`→409, `SCHEMA_INVALID`/`PROVIDER_INVALID_JSON`→422,
`PROVIDER_HTTP`/`FIXTURE_MISSING`→502, Zod→400 with field details, malformed
JSON→400. Unexpected errors → generic 500; stack never leaks.

## 4. Layer sketch

```
routes/api.js (+ schema/api.js Zod boundary)   ← HTTP only, no SQL
        ↓
services/  tagging · matching · guard · cost · vectors · provision
        ↓                                  ↑
jobs/batchJob.js  (tag + embed: retries, attempts, alerts, budget, idempotency)
        ↓
providers/  vision: fixture | gemini   ·   embeddings: cache | ollama | hf
        ↓
repositories/  (all SQL)  ← src/db (node:sqlite) ← migrations/001_init.sql
```

## 5. The mismatch guard (`src/services/guard.js` — own module by design)

Four ordered rules; **all four always evaluated** so the trace explains the
whole path; first failure decides verdict + reason.

1. `unvalidated_output` — metadata exists, is schema-valid, has subject+caption.
2. `species_mismatch` — canonicalize both sides and compare. Corpus aliases:
   *Vulpes vulpes*≡*red fox*, *Canis lupus*≡*gray wolf*, *Canis familiaris*≡*dog*,
   wolf/grey wolf→gray wolf, fox→red fox, puppy(s)/dog→dog, brown bear→bear,
   cervidae/stag/elk→deer. **Unknown species on either side passes** — the guard
   never guesses; the candidate then lives or dies by the threshold.
3. `below_threshold` — cosine ≥ `SIMILARITY_THRESHOLD` (0.538).
4. `low_confidence` — vision confidence ≥ `LOW_CONFIDENCE_THRESHOLD` (0.60).

Dual behavior by design: low-confidence output is **flagged at ingest**
(`images.low_confidence=1`, status `flagged`) and **rejected at match time**
(rule 4). Approve reason carries score + confidence; reject reasons are
human-readable ("Animal category mismatch: expected red fox, detected gray
wolf").

## 6. Matching (`src/services/matching.js`)

Cosine over the shared space (vectors L2-normalized → cosine = dot product).
Candidate pool = top 25 by cosine **plus** any `force_image` candidate outside
it (so a reviewer can always see the rejection itself). The guard judges every
pool candidate; all verdicts persist via idempotent upsert (re-ranking resets
stale review state). Answer = first guard-approved candidate; otherwise
`no_confident_match` with the top-3 aggregated reasons. Text recipe (identical
in `scripts/generate-vectors.js` and the embed job): image =
`"<caption> <attrs joined by ', '>"`, post = `"<title>. <body>"`.

## 7. Providers (one interface each, env-selectable)

- Vision: `fixture` (committed JSON derived from iNaturalist research-grade
  metadata — the card-blessed $0 path) | `gemini` (live, `GEMINI_API_KEY`).
- Embeddings: `cache` (committed `data/vectors/`, default, keyless) | `ollama`
  (local `/api/embed`, $0) | `hf` (HF Inference router; our free account
  returned 402 no-credits — not used for committed results).

## 8. Threshold + eval methodology

`scripts/eval.js` sweeps `SIMILARITY_THRESHOLD` 0.300→0.800 (step 0.025)
through the **real** ranking+guard pipeline over the 15-post labeled set
(`seeds/eval-set.json`; each post built from the same iNaturalist observation
as its labeled photo). Correct = top-ranked **guard-approved** image equals the
labeled image. Precision 1.000 on band [0.300, 0.775] → chosen **0.538**
(band midpoint). Margins: lowest correct-image score ≈0.795, highest wrong
0.4672 (snow-leopard post's best was a bear). At 0.800 precision is 13/15 —
two deer posts' own photos score 0.7953/0.7987 — which is why the threshold is
the band midpoint, not "high".

## 9. Provisioning / bootstrap

`npm run bootstrap` = one process: migrate → seed → tag job → embed job → eval.
`npm start` calls `provision()` on boot: seed if empty, tag if metadata empty
(zero-cost vision only), embed if embeddings empty (cache/ollama only).
`AUTO_PROVISION=0` disables; paid providers (gemini/hf) never auto-provision —
boot logs instructions instead of spending money.

## 10. Explicit non-goals

**No image-generation fallback** — when nothing clears the bar the system says
so; it does not fabricate a picture. Also out: frontend build (API + admin
table only), multi-model benchmarking (one vision + one embedding model, per
brief §7), near-duplicate detection.

## 11. Key decisions (with reasons)

- **SQLite via `node:sqlite`** — Docker absent on the build machine; brief §10
  allows in-DB arrays at 50 images; zero-install reproducibility for the
  evaluator. Experimental status documented.
- **Fixture vision** — free vision APIs verified broken (Groq vision
  decommissioned, Gemini Flash rate-limited to zero, OpenRouter paid-only);
  FlyRank's card Q&A blesses pre-generated JSON through the same pipeline.
  Gemini live path is one env var away.
- **Committed all-MiniLM vectors (Ollama-generated)** — HF Inference returned
  402 "no remaining credits"; local Ollama is $0 and keyless; committing
  `data/vectors/` makes the evaluator run offline.
- **Threshold from the eval band, not a feeling** — 0.538 is the midpoint of
  the only band achieving 15/15.
- **Candidate pool 25 + forced-candidate visibility** — a rejection the API
  hides cannot be reviewed; PROBE 3 must see the wolf.
- **Single-process bootstrap + self-provisioning** — the build sandbox flakily
  wipes gitignored workspace paths between commands; atomic provisioning makes
  `npm run bootstrap` and `npm start` reliable from any state.
