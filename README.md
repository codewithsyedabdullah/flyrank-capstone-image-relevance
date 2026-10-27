# flyrank-capstone-image-relevance

**FlyRank AI Internship · Backend AI Engineering track · Week 8 capstone**
**AI Image Understanding & Content Matching Engine**

A service that understands an image library, auto-tags it with schema-validated
vision output, embeds captions and blog posts into one semantic space, ranks the
right image for each post — and **refuses with a human-readable explanation when
no match is confident enough**. A red-fox post gets the red-fox photo; the wolf is
rejected, not guessed.

## Status

Phase 1 of 4 (design) — built in phases, one commit per session. See `DESIGN.md`
for the current design doc and `BUILDLOG.md` for the honest AI-usage log.

## Stack

- **Node.js 25 + Express 5** — HTTP layer
- **Zod** — boundary + vision-output schema validation
- **node:sqlite** (built into Node, zero install) — persistence with real
  migrations and indexes. The brief suggests PostgreSQL via Docker; Docker is not
  available on the build machine and pgvector is optional at ~50 images (brief
  §10), so SQLite was chosen for one-command reproducibility. The repository
  layer isolates this choice.
- **Vision**: fixture provider (pre-generated, schema-validated JSON — the path
  FlyRank blessed in the capstone card's Q&A because free vision APIs are broken;
  `VISION_PROVIDER=gemini` swaps in live calls behind the same interface)
- **Embeddings**: Hugging Face Inference API `sentence-transformers/all-MiniLM-L6-v2`
  (free token) with committed vectors for keyless reproduction
- **No credit card, ever.**

## Quickstart (final form — Phase 4)

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed        # downloads the ~50-image corpus + loads posts/eval set
npm start           # http://localhost:4317
```

## Repository map

```
src/
  server.js          HTTP bootstrap (Express)
  routes/            HTTP layer — validated endpoints
  services/          business logic (tagging, matching, eval, cost)
  guard.js           the mismatch guard — its own module, built first
  providers/         vision + embedding providers (fixture/gemini, hf/cache)
  repositories/      data access (SQLite)
  db/                migration runner + migrations/*.sql
  jobs/              background batch jobs (retries, idempotency, alerts)
  schema/            Zod schemas (vision output, API inputs)
scripts/             corpus fetch, fixture generation, seed, eval
seeds/               posts.json, eval-set.json (labeled)
data/                corpus manifest, vision fixtures, committed vectors
tests/               node:test suite (schema, guard, matching)
```

## Honesty notes (also in BUILDLOG.md)

- Vision model raw output is **fixture JSON** (FlyRank-blessed path; free vision
  APIs — Groq vision decommissioned, Gemini Flash rate-limited on new accounts,
  OpenRouter paid-only — were verified broken for this capstone). The pipeline
  around it is fully real: schema validation, low-confidence flagging, retries,
  batch job, DB writes, cost log. Live Gemini calls are one env var away.
- Embedding vectors are **real** (all-MiniLM-L6-v2), generated once via the free
  HF Inference API and committed so the evaluator runs keyless.
