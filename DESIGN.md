# Design — AI Image Understanding & Content Matching Engine

One page, per the capstone ground rules: problem, data model, API surface, layer
sketch, one explicit non-goal.

## 1. Problem

A blog CMS must pair each article with the most relevant image from a library
**by meaning, not filename or keywords**. A wrong pairing (a wolf on a red-fox
post) is worse than no pairing. So the system must: tag images with validated
vision output, embed captions and posts into one semantic space, rank candidates,
and — the production-critical part — **refuse with a human-readable explanation
when nothing clears the bar**.

## 2. Data model (SQLite; migrations in `src/db/migrations/`)

| Table | Purpose | Key indexes |
|---|---|---|
| `tenants` | isolated tenants (default seeded) | `name` UNIQUE |
| `images` | corpus files + status (`pending/tagged/flagged/failed`) | `(tenant_id, status)` |
| `image_metadata` | validated vision output: subject, category, attributes, caption, confidence, raw JSON, `schema_valid` | `image_id` UNIQUE |
| `tags` | one row per subject/category/attribute per image | `(image_id)`, `(tag)` |
| `posts` | blog posts to match | `(tenant_id)` |
| `embeddings` | vectors for images (caption) and posts (text); `vector_json` | UNIQUE `(entity_type, entity_id, model)` |
| `jobs` / `job_attempts` | background batch runs + retry evidence | `(tenant_id, status)`, `(job_id)` |
| `suggestions` | one row per (post, image) candidate: rank, cosine score, guard verdict, reason | UNIQUE `(post_id, image_id)`, `(post_id)` |
| `reviews` | human approve/reject with reason + reviewer | `(suggestion_id)` |
| `cost_log` | every vision/embedding call, attributed, `call_id` UNIQUE (idempotent) | `(created_at)` |
| `eval_runs` | top-1 precision history | — |

Vectors are stored as JSON arrays and cosine is computed in-app: at ~50 images
this is trivial, and the brief itself allows in-DB arrays at this scale
(pgvector optional). The repository layer keeps a Postgres+pgvector swap to a
config change.

## 3. API surface (JSON everywhere; Zod at the boundary → clean 4xx, never 500)

| Method + path | Purpose |
|---|---|
| `POST /api/jobs/tag` | start/return the tagging batch job (idempotent; 202) |
| `GET /api/jobs/:id` | job progress, attempts, failure alert |
| `POST /api/jobs/embed` | caption/post embedding batch job |
| `GET /api/images?status=&flagged=` | admin table of images |
| `GET /api/images/:id` | metadata + tags + embedding status |
| `GET /api/posts` / `GET /api/posts/:id` | posts |
| `GET /api/posts/:id/images?top=5&force_image=<id>` | **ranked suggestions with guard verdicts** (`force_image` provokes PROBE 3) |
| `GET /api/suggestions/:id/why` | inspect why an image was selected or refused |
| `POST /api/suggestions/:id/approve` | review: approve `{reviewer}` |
| `POST /api/suggestions/:id/reject` | review: reject `{reviewer, reason}` |
| `GET /api/eval/precision?run=1` | run labeled eval set → top-1 precision |
| `GET /api/costs` | per-call cost log + budget guard status |
| `GET /api/health` | liveness |

## 4. Layer sketch

```
routes/ (HTTP, Zod boundary)  →  services/ (tagging, matching, eval, cost)
                                     ↑
jobs/ (batch worker: retries, idempotency, progress, failure alert)
guard.js (own module: tags + threshold + confidence → approve/reject + reason)
providers/ (vision: fixture|gemini · embeddings: hf|cache — same interface)
repositories/ (SQLite) ← migrations/*.sql
```

Flow: `images → batch job → vision → Zod-validated metadata (+low-conf flag) →
embed(caption) → image_vectors`; `posts → embed(text) → post_vectors`;
`GET /posts/:id/images → cosine ranking → guard → ranked+explained suggestions
| REJECTED with reason | "no confident match" + reasons → review API`.

## 5. The mismatch guard (ordered rules, each yields a human-readable reason)

1. Vision output not schema-valid → **reject** ("unvalidated model output").
2. Species mismatch — post subject species ≠ image subject species
   (expected *fox*, detected *wolf*) → **reject** ("Animal category mismatch:
   expected fox, detected wolf").
3. Cosine similarity < `SIMILARITY_THRESHOLD` → **reject** ("similarity below
   threshold: 0.42 < 0.55").
4. Image confidence < `LOW_CONFIDENCE_THRESHOLD` → **reject/flag**
   ("low-confidence classification — flagged for human review").
5. All pass → **approve** with explanation (score, matched subjects, attributes).

If every candidate is rejected, the post answer is **"no confident match" plus
the aggregated reasons** — never a guessed best-effort image.

## 6. Explicit non-goal

**No image-generation fallback.** When no image is good enough the system says
so; it does not fabricate a picture. (Brief lists generation as a stretch goal;
refusing honestly is this capstone's core behavior, so generation stays out by
design.) Secondary scope cuts: no frontend build (API + admin table only), no
multi-model benchmark (one vision + one embedding model, per brief §7).

## 7. Key decisions (with reasons)

- **SQLite via `node:sqlite`** — Docker is unavailable on the build machine; the
  brief allows in-DB arrays at 50 images; zero-install reproducibility for the
  evaluator. Experimental status is documented in the README.
- **Fixture vision provider** — free vision APIs verified broken (Groq vision
  decommissioned; Gemini Flash rate-limited on new accounts; OpenRouter
  paid-only). FlyRank's own Q&A on the capstone card blesses pre-generated JSON
  read by the same pipeline. The `gemini` provider behind the same interface is
  implemented and env-selectable.
- **Real embeddings, committed** — all-MiniLM-L6-v2 vectors generated once via
  the free HF Inference API and committed, so `npm run seed` works keyless; live
  regeneration stays one env var away.
- **Thresholds from the eval set, not feelings** — `SIMILARITY_THRESHOLD` is
  tuned against the labeled set; the number and the defense live in the README.
