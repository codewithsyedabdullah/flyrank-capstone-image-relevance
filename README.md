# flyrank-capstone-image-relevance

**FlyRank AI Internship · Backend AI Engineering track · Week 8 capstone**
**AI Image Understanding & Content Matching Engine**

A service that understands an image library, auto-tags it with
**schema-validated** vision output, embeds captions and blog posts into one
semantic space, ranks the right image for each post — and **refuses with a
human-readable explanation when no match is confident enough**. A red-fox post
gets the red-fox photo; the wolf is rejected, not guessed.

**Headline quality number (labeled eval set, 15 posts): top-1 precision 15/15 = 1.000**
at `SIMILARITY_THRESHOLD=0.538` (band midpoint; see §Eval).

## Architecture

```
                 ┌──────────────────────────────────────────────────────────┐
                 │ committed, keyless data/ (826 KB total)                  │
                 │ manifest.json · fixtures/vision/*.json (56)              │
                 │ vectors/images.json (56×384) · vectors/posts.json (16×384)│
                 └───────────────┬──────────────────────────────────────────┘
                                 │
 images/ (real CC photos, gitignored — reproduced by scripts/fetch-corpus.js)
                                 │
                                 ▼
 ┌─────────────────── BACKGROUND BATCH JOBS (src/jobs/batchJob.js) ───────────────────┐
 │ TAG job:    56 images → vision provider → Zod schema → image_metadata + tags      │
 │             low-confidence → FLAGGED (never guessed) · retries ×3 · per-attempt    │
 │             rows · per-call cost log · budget guard · failure alerts               │
 │ EMBED job:  captions + post texts → embedding provider → embeddings (L2-normalized)│
 └───────────────────────────────┬────────────────────────────────────────────────────┘
                                 │
                                 ▼
 ┌──────────────────────── SQLite via node:sqlite (src/repositories) ─────────────────┐
 │ images · image_metadata · tags · posts · embeddings · suggestions · reviews ·      │
 │ jobs · job_attempts · cost_log · alerts · eval_runs · tenants · schema_migrations  │
 │ (real migration + indexes on every FK and query path — src/db/migrations/)         │
 └───────────────────────────────┬────────────────────────────────────────────────────┘
                                 │
   GET /api/posts/:id/images ────┤
     1. cosine ranking: post vector × all image vectors → candidate pool (top 25)
     2. mismatch guard judges EVERY candidate — 4 ordered rules, full trace
     3. answer = first guard-approved image, or "no confident match" + reasons
     4. every verdict persisted (idempotent upsert) → reviewable
                                 │
                                 ▼
   Review API:  GET  /api/suggestions/:id/why      (inspect — selected OR refused)
                POST /api/suggestions/:id/approve  |  POST .../reject
```

Layers: `routes/` (HTTP + Zod boundary) → `services/` (tagging, matching,
guard, cost, provisioning) → `repositories/` (SQL). `jobs/` runs the slow bulk
work off the request path. `providers/` swaps vision/embedding backends behind
one interface each. Routes never touch the database; services never touch HTTP.

## Quickstart (clean machine, ~1 minute, $0)

```bash
git clone https://github.com/codewithsyedabdullah/flyrank-capstone-image-relevance.git
cd flyrank-capstone-image-relevance
npm install
cp .env.example .env     # defaults are fully keyless: fixture vision + cache embeddings
npm run bootstrap        # ONE process: migrate → seed → tag → embed → eval
npm start                # http://localhost:4317
```

`npm run bootstrap` is the seed step: it tags all 56 images, embeds 72 texts,
runs the labeled eval, and prints the verification block (counts, flagged
images, cost summary, probe results). It is idempotent — safe to re-run.
`npm start` additionally self-provisions an empty database on boot
(`AUTO_PROVISION=0` disables; paid providers never auto-provision).

Granular scripts: `npm run migrate` · `npm run seed` · `npm run tag` ·
`npm run embed` · `npm run eval` · `npm run vectors` (regenerate committed
vectors via local Ollama) · `npm run fixtures` · `npm run fetch-corpus` ·
`npm run enrich` · `npm run eval-set` · `npm test` (55 tests).

## Verified behavior (the six acceptance probes)

All six were run live against the built system; transcripts in `EVIDENCE.md`.

| # | Probe | Command | Result |
|---|-------|---------|--------|
| 1 | batch job tags everything; low-confidence flagged | `npm run bootstrap` then `curl localhost:4317/api/images?flagged=1` | 56/56 tagged, 0 failed; **6 ambiguous-canid fixtures flagged** (confidence 0.44–0.55, genus-level *Canis* — genuinely uncertain) |
| 2 | red-fox post ranks the fox first | `curl "localhost:4317/api/posts/p-fox-1/images?top=10"` | **`img-red_fox-07` @ 0.8478**; wolf 0.3556 and dog 0.3172 rank far below and are guard-rejected |
| 3 | forced wolf on the fox post is rejected with explanation | `curl "localhost:4317/api/posts/p-fox-1/images?force_image=img-wolf-00"` | `verdict: reject`, `rule: species_mismatch`, *"Animal category mismatch: expected red fox, detected gray wolf"* |
| 4 | post with no suitable image refuses honestly | `curl localhost:4317/api/posts/p-other-1/images` | `verdict: no_confident_match`, `match: null`, per-candidate `below_threshold` reasons (best wrong score 0.4672) |
| 5 | eval script reports top-1 precision | `npm run eval` or `curl localhost:4317/api/eval` | **15/15 = 1.000**, threshold 0.538 — matches this README |
| 6 | every vision/embedding call attributed in the cost log | `curl localhost:4317/api/costs` | **61 calls** (56 vision + 5 embedding batches), each with provider, model, operation, entity ref, USD cost; budget guard status included |

## The mismatch guard (the production-critical part)

Four ordered rules, **all** evaluated so the trace explains the whole decision
path (`GET /api/suggestions/:id/why` returns it):

1. **unvalidated_output** — vision output that failed Zod validation is never
   trusted (retried, then the image fails; never persisted as truth).
2. **species_mismatch** — post species vs image species after canonicalization
   (*Vulpes vulpes* ≡ *red fox*, *Canis lupus* ≡ *gray wolf*, *Canis
   familiaris* ≡ *dog*…). Unknown species on either side passes this rule and
   falls through to the threshold — the guard never guesses.
3. **below_threshold** — cosine similarity below `SIMILARITY_THRESHOLD`.
4. **low_confidence** — vision confidence below `LOW_CONFIDENCE_THRESHOLD`
   (0.60). Low-confidence images are **flagged at ingest** and **rejected at
   match time** — two different jobs, one rule.

First failing rule decides; its human-readable detail is the rejection reason.
All pass → approve with score + confidence in the reason.

## Eval methodology + threshold defense

- **Labeled set**: 15 posts (3 per species: fox, wolf, dog, bear, deer). Each
  post's text is built from the *same iNaturalist observation* as its labeled
  photo — real place, real field notes, real observer tags — so precision
  measures real retrieval, not a species bag-of-words shortcut. Plus one
  out-of-corpus post (snow leopard) that must be refused.
- **Method**: sweep `SIMILARITY_THRESHOLD` 0.300→0.800 (step 0.025) through
  the *real* pipeline (ranking + guard). A post is correct iff the top-ranked
  **guard-approved** image is the labeled image; refusals and wrong images
  both count as misses.
- **Result**: precision 1.000 on the band **[0.300, 0.775]**; chosen
  **0.538** = band midpoint (most conservative value inside the perfect band).
- **Honest margins**: lowest correct-image score ≈ 0.795; highest wrong-image
  score 0.4672 (snow-leopard post's best candidate was a bear) → ~0.33
  separation. At 0.800 precision drops to 13/15 because two deer posts' *own*
  photos score 0.7953/0.7987 — the model puts a deer's own photo just under
  0.8. That is exactly why the threshold is 0.538 and not higher.
- **Concept match**: the brief's example works — a post mentioning
  *"Vulpes vulpes"* (`p-fox-2`) ranks `img-red_fox-09` top-1.

## Corpus & provenance

- **56 real photos** from the iNaturalist API (keyless): 10 each of red fox,
  gray wolf, dog, brown bear, white-tailed deer (research-grade, species-level
  IDs) + **6 genus-level *Canis* needs-ID observations** — photos the community
  genuinely could not separate into wolf/dog/coyote. Those six are the honest
  low-confidence fixtures (confidence 0.44–0.55, flagged).
- Every image carries license + attribution + source URL in
  `data/manifest.json` (Creative Commons / public domain; CC BY-NC included
  under fair-use educational terms — verify before reuse).
- The brief suggests Unsplash/Pexels; iNaturalist was chosen because it is
  keyless *and* carries the taxon/place/notes metadata needed for honest
  fixtures and photo-specific eval labels. Wikimedia Commons was unreachable
  from the build network; Openverse's API was dead (see BUILDLOG).
- The JPEGs themselves are **not committed** (gitignored; ~50 MB). The
  pipeline never reads them at runtime — it operates on the manifest, the
  vision fixtures, and the committed vectors. `scripts/fetch-corpus.js`
  re-downloads the photos.

## Providers & stack honesty

- **Vision = fixture JSON** (`data/fixtures/vision/*.json`), the $0 path
  FlyRank's own capstone-card Q&A blesses. Free vision APIs were verified
  broken at build time (Groq vision decommissioned, Gemini Flash rate-limited
  to zero on new accounts, OpenRouter vision paid-only). Fixtures are derived
  from real iNaturalist research-grade metadata — no invented labels. A live
  **Gemini** provider is implemented behind the same interface:
  `VISION_PROVIDER=gemini` + `GEMINI_API_KEY` (paid; not used for committed
  results).
- **Embeddings = local Ollama `all-minilm` (384-dim)**, generated once and
  committed to `data/vectors/` (676 KB). Default `EMBEDDING_PROVIDER=cache`
  reads exactly those files, so the evaluator runs **keyless and offline**.
  Live regeneration: `EMBEDDING_PROVIDER=ollama` (local, $0) or `hf`
  (Hugging Face Inference — our free account returned HTTP 402 "no remaining
  credits", so it was **not** used; do not trust docs that say HF).
- **Database = SQLite via built-in `node:sqlite`** (Node ≥22). The brief
  suggests PostgreSQL via Docker; Docker is absent on the build machine and
  pgvector is optional at ~50 images (brief §10). The repository layer
  isolates this choice — swapping to Postgres+pgvector is a repository-file
  change, not a rewrite. Vectors are stored as JSON and cosine is computed
  in-app (trivial at 56 images).
- **Stack**: Node 25 + Express 5 + Zod. Two npm dependencies, zero services.

## Text recipe & vector identity (reproducibility)

Identical in `scripts/generate-vectors.js` and the embed batch job:

- image text = `"<caption> <attr1>, <attr2>, ..."`
- post text = `"<title>. <body>"`

Vectors are L2-normalized before storage, so **cosine = dot product**. The
embedding model identity (`all-minilm`) is stored per row; the matcher only
queries vectors of the configured model.

## Background jobs, retries, alerts, idempotency

- Tag + embed run as **background batch jobs** (`src/jobs/batchJob.js`), off
  the request path, with progress in the `jobs` table (`GET /api/jobs/:id`).
- **Retries**: every provider call attempted up to 3× with backoff; every
  attempt (ok/error + error message) is a `job_attempts` row.
- **Failure alerts**: per-entity final failures → `partial_failure`; budget
  exhaustion → `budget_exceeded`; unexpected crashes → `job_crash`. Alerts are
  persisted (`GET /api/alerts`) and optionally POSTed to `WEBHOOK_ALERT_URL`.
- **Idempotency**: tag job skips non-pending images unless `?force=true`;
  embed job skips entities already embedded under the same model; re-tag of a
  tagged image → clean 409 (or 200 with `force`); job start is deduped (one
  active job per type per tenant); cost rows are unique by `call_id`.

## Cost tracking & budget guard

Every vision/embedding call — including $0 fixture and local-cache calls —
gets a `cost_log` row **before** the result is trusted: provider, model,
operation, entity reference, input units, USD cost, status. The budget guard
refuses new calls once `COST_BUDGET_USD` is exhausted (job fails +
`budget_exceeded` alert). Committed runs cost **$0.00** — but the machinery is
real and every one of the 61 calls is attributed.

## Review API

- `GET /api/posts/:id/suggestions` — persisted, ranked, verdict-labeled
- `GET /api/suggestions/:id/why` — score, verdict, guard rule, reason, full
  4-rule trace, vision metadata, plus the human review (if any)
- `POST /api/suggestions/:id/approve` `{reviewer}` ·
  `POST /api/suggestions/:id/reject` `{reviewer, reason}` (reason required,
  min 3 chars — Zod at the boundary)

## Tests

`npm test` → **55/55 pass** (guard 9, tagging 6, vectors 7, cost 4, jobs 5,
api 19, eval 5). Tests boot their own ephemeral server and use per-process
temp databases. (Note: `node --test tests/` with a directory argument is
broken on Node 25.2.1/Windows; the npm script uses the glob form.)

## Limitations (honest)

1. **Vision is fixture JSON, not a live model call.** The fixtures are real
   metadata-derived labels, but the pipeline has not run a live vision model
   over the corpus (the free options were broken; the card blesses fixtures).
   Gemini is one env var away but costs money and was not used.
2. **Embeddings are committed cache vectors** from one local Ollama run.
   Regenerating needs Ollama running (`EMBEDDING_PROVIDER=ollama`).
3. **SQLite, not Postgres+pgvector** — fine at 56 images (brief §10 allows
   in-DB arrays), not fine at millions. Repository layer keeps the swap cheap.
4. **Candidate pool = top 25** by cosine before the guard judges. A correct
   image ranked >25th would never be judged. At this corpus size the pool
   covers the retrieval-relevant set; the forced-candidate mechanism
   (`force_image`) makes any candidate visible for review.
5. **Corpus is 5 species + 1 ambiguous genus pool** across 2 classes of
   environment (wildlife photos). No perceptual-hash near-duplicate detection,
   no auto alt-text generation, no image-generation fallback (explicit
   non-goal — refusing honestly is the core behavior).
6. **Photos are not committed** (license/attribution recorded in the manifest;
   `fetch-corpus.js` re-downloads). The evaluator reproduces tags/vectors from
   committed data without the JPEGs.
7. **Build-machine sandbox quirk**: gitignored workspace paths (`db/`,
   occasionally `.env`) were flakily wiped between commands. The design
   response is `npm run bootstrap` (one atomic process) plus server
   self-provisioning — documented in BUILDLOG.

## Repository map

```
capstone.yaml         evaluator manifest (run/seed/test/base_url/endpoints)
README.md             this file
DESIGN.md             one-page design (as built)
EVIDENCE.md           one pasted proof per Section-6 requirement box + shared reqs
BUILDLOG.md           honest AI-usage log (where AI helped / was wrong / fixed)
src/
  server.js           Express boot + error middleware + self-provisioning
  config.js           env loading (.env first, before any src module)
  db/                 node:sqlite connection + migrate.js + migrations/001_init.sql
  repositories/       ALL SQL (layer isolation)
  schema/             Zod: vision output + API boundary
  providers/          vision (fixture|gemini) · embeddings (cache|ollama|hf)
  services/           tagging · guard · matching · cost · vectors · provision
  jobs/batchJob.js    tag + embed batch jobs: retries, alerts, budget, idempotency
  routes/api.js       18 /api routes (+ root)
scripts/              bootstrap · fetch/enrich corpus · fixtures · vectors ·
                      eval-set · eval · seed · run-tag-job · run-embed-job
seeds/                posts.json (16) · eval-set.json (15 labeled + notes)
data/                 manifest.json (56 images, licenses, attribution) ·
                      fixtures/vision/*.json · vectors/*.json · eval-run.json
tests/                7 files, 55 tests (node:test, zero deps)
```

## License

MIT. Corpus photos remain under their recorded Creative Commons licenses with
attribution in `data/manifest.json`.
