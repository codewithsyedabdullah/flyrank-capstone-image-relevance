# BUILDLOG — honest AI-usage log

Rule from the brief: where AI helped, where it was wrong, what I changed.
Honesty is graded, perfection is not.

## Session 1 — Phase 1: design + repo skeleton

**AI (me, Claude via OpenCode) did:**
- Read the 11-page capstone PDF (text extracted with PyMuPDF locally) and mapped
  every Section 6 requirement box to a build phase.
- Probed the environment: Ollama running with **zero** models, Docker **missing**,
  Groq key has only 11 text models (no vision, no embeddings), ~1 GB free RAM.
  These facts drove the stack decisions below.
- Created the public repo `flyrank-capstone-image-relevance` (day-one rule).
- Wrote `DESIGN.md`, the skeleton, `.gitignore` (with `.env` before the first
  commit), MIT `LICENSE`, `.env.example`.

**Decisions made with the intern (his calls, not mine):**
- Vision = fixture JSON path (the one FlyRank itself blessed in the card Q&A).
- Embeddings = real vectors via a free Hugging Face Inference token.
- Database = SQLite via built-in `node:sqlite` (no Docker on this machine).

**Where AI was wrong / course-corrected:** none yet — nothing built beyond scaffolding.

**What I (the intern) can explain line-by-line:** all of it so far; the guard and
pipeline land in Phases 2–3 and I will re-verify each module by hand before
committing.

## Session 2 — Phase 2: corpus + vision pipeline (fixtures, Zod, cost log, tag job)

**AI did:**
- Built the corpus fetcher against the **iNaturalist API (keyless)** after
  Wikimedia Commons repeatedly died with ECONNRESET from the build network and
  Openverse's API returned nothing usable. Both verified dead — not guessed.
  Result: 56 real CC photos (10 each fox/wolf/dog/bear/deer, research-grade,
  species-level) + 6 genus-level *Canis* needs-ID observations.
- Enrichment pass: photo-specific captions built from each observation's real
  `place_guess`, observer notes and field tags (13 photos have real notes;
  captions never invent facts). Fixed a results-array unwrap bug — iNaturalist
  returns photos inside a `results` envelope; the first run wrote the envelope
  object instead of the array.
- Wrote the Zod vision schema, the tagging service (validate → persist →
  flag), the cost tracker with budget guard, and the tag batch job with
  retries. Generated the 56 vision fixtures from manifest metadata — the $0
  path FlyRank's own card Q&A blesses.

**Where AI was wrong / course-corrected:**
- Initially labeled the 6 ambiguous canids as *Vulpes* (fox genus). Wrong —
  those observations are genus-level *Canis* (community could not separate
  wolf/dog/coyote). Caught it by re-reading taxon ranks in the manifest;
  relabeled "canid (species uncertain)", confidence 0.44–0.55, so they flag
  honestly instead of posing as foxes.
- `addAttempt`/`logCall` initially used camelCase keys against snake_case
  repository columns. SQLite is lenient — the INSERTs succeeded and silently
  stored nulls. The live path would have logged attempts with no entity refs
  and cost rows with no cost. Caught in test review; fixed with explicit key
  mapping; a test now asserts a failed call has **no** cost row but exactly 3
  error attempts.
- The guard trace leaked the caption *string* as the `pass` value
  (`a && b && c` returns the last truthy operand). Fixed with `Boolean(...)`
  and a test asserting every trace `pass` is a real boolean.

**What the intern can explain line-by-line:** the whole tagging path — fixture
provider → Zod safeParse → `upsertMetadata`/`replaceTags` → status/flag, the
retry loop with backoff, and the cost row written **before** the result is
trusted.

## Session 3 — Phase 3: embeddings + matching engine + guard + eval

**AI did:**
- Tried Hugging Face Inference for embeddings first (the Session-1 decision).
  Our token authenticated but every call returned **HTTP 402 "no remaining
  credits"** — the free serverless pool was exhausted. Pivoted to local
  **Ollama all-minilm** (384-dim): generated all 72 vectors once, committed
  them to `data/vectors/` (676 KB) so the evaluator runs keyless. Docs say
  Ollama, not HF.
- `nomic-embed-text` crashed the Ollama process mid-run; switched to
  `all-minilm` after a 15/15 pre-guard ceiling check showed it was already
  perfect at 6× smaller.
- Built `guard.js` as its own module first (brief §1), then matching: cosine
  ranking → candidate pool → guard judges every candidate → persist explained
  suggestions → honest refusal.
- Eval script sweeps the threshold through the *real* pipeline; precision
  1.000 on band [0.300, 0.775]; chose the midpoint **0.538**.

**Where AI was wrong / course-corrected:**
- Candidate pool was 10; a forced-wolf probe fell outside it and the endpoint
  hid the very rejection the probe needs to see. Raised to 25 and made forced
  candidates always visible in the response.
- First eval-set generation picked photos by species only, so two same-place
  bear photos tied and one eval post was ambiguous. Rebuilt selection to be
  place-diverse and photo-specific: each eval post references the same
  iNaturalist observation as its labeled photo (real place, real notes).
- The first threshold defense was "0.800 looks safe" — wrong: two deer posts'
  *own* photos score 0.7953/0.7987. The honest number is the band midpoint
  0.538, with the margin analysis in the README.

**What the intern can explain line-by-line:** the guard's four ordered rules +
species canonicalization, matching's pool/forced-candidate/idempotent-upsert
logic, and eval's sweep + band-midpoint selection.

## Session 4 — Phase 4: review API, hardening, 55-test suite, docs, pre-commit fixes

**AI did:**
- Review API (approve / reject / inspect-why) + jobs/costs/eval/alerts
  endpoints; error middleware maps coded errors to clean 400/404/409/422/502
  JSON — never a stack trace, never a 500 for bad input.
- 55-test suite (`node:test`, zero extra deps) including an in-process
  ephemeral server for the API tests and per-process temp databases.
- `npm run bootstrap` (one atomic process: migrate → seed → tag → embed →
  eval) plus server self-provisioning (`src/services/provision.js`) — the
  design response to a flaky sandbox that kept wiping gitignored workspace
  paths (`db/`, occasionally `.env`) between commands.
- Full doc set: README rewrite, as-built DESIGN, `capstone.yaml`,
  `EVIDENCE.md`, this BUILDLOG.

**Where AI was wrong / course-corrected (all caught before committing):**
- `.gitignore` had an **unanchored `db/`** pattern — it matches `src/db/` at
  any depth. A naive `git add src/` would have silently excluded the entire
  persistence layer (`index.js`, `migrate.js`, `migrations/001_init.sql`) from
  the commit. Anchored to `/db/`; verified with `git check-ignore`.
- The `DB_PATH` fallback resolved to `src/db/app.sqlite` (a stray database was
  literally sitting there). Fixed to the root `db/app.sqlite`; stray deleted.
- `node --test tests/` (directory argument) is broken on Node 25.2.1/Windows —
  it treats the directory as the main module. `package.json` uses the glob
  form `node --test tests/*.test.js`.
- Test review fixes: three assertions missing their expected-value argument;
  the review API stores `action: 'approve'/'reject'` in `reviews` but
  `verdict: 'approved'/'rejected'` on the suggestion — tests initially
  asserted the wrong field.

**What the intern can explain line-by-line:** anything under `src/`. Every
module was re-read against the brief before this commit.
