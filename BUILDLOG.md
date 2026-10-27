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
