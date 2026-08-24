# Spec: 6-dimension MECE scoring + classification rating + deploy-time bank importer

Shipped **v0.31.0.0**. Extends the F4 scoring engine and F8 report from a letter-grade (A–F) model
to a client-facing **classification rating** driven by six weighted MECE dimensions, with
critical-error capping and a pending-conflict exemption, plus per-question weighting and a
deploy-time importer that lands a real inspection-interview bank into the (gitignored) DB.

> **Desensitization note.** This document describes the *mechanism* only. No client content — role
> titles, SOP bodies, document numbers, KPI thresholds, or the specific known-conflict figures —
> lives here or in any *committed* file. The real material stays in the gitignored
> `EU_avatar_inspector_interview/` source tree and lands only in the local DB (`*.db`, gitignored).
> The importer script (`backend/scripts/import_rfcsm_bank.py`) and its test are themselves
> **gitignored, local-only deploy artifacts** — they carry client-specific strings (bank/role names,
> the known-conflict figures, real SOP filenames), so they are never committed to the public repo.
> Run the importer from a local checkout at deploy time; it writes only to the DB.

## Problem

The engine scored each question as a set of `required / recommended / forbidden` checklist items,
weights summing to 100, emitting a weighted 0–100 score and an A–F letter grade. A client
evaluation contract instead asks for:

- a fixed **6-dimension MECE rubric** applied uniformly to every question, each dimension weighted;
- an overall **classification rating** — *Meets Expectations / Needs Improvement / Does Not Meet* —
  not a letter;
- **critical-error capping**: a confirmed critical error caps the overall rating at *Needs
  Improvement* regardless of the numeric score;
- a **pending-conflict exemption**: a known, not-yet-validated source conflict must be *disclosed*
  when the answer touches it, but must **not** trigger the cap while validation is pending.

Two latent gaps also surfaced: the interview-level score was a simple mean of question scores
(no per-question weighting), and there was no persisted report table to keep in sync (the report is
recomputed on demand), so the aggregation change is localised.

## Decisions (owner-locked)

- **Content landing:** a deploy-time importer script (committable) that reads the gitignored source
  and writes only to the DB. The DB is never committed.
- **Scoring model:** native **6 weighted MECE dimensions** — Factual/procedural accuracy **25**,
  Completeness **20**, Role/accountability boundary **15**, Evidence/traceability **15**, Risk
  judgement/escalation **15**, Clarity/non-ambiguity **10** (sum 100).
- **Result measure:** classification rating with thresholds **≥70 Meets / 40–69 Needs Improvement /
  <40 Does Not Meet** (deliberately aligned to the existing B=70 / D=40 letter-grade boundaries to
  minimise regression risk). The letter grade is retained internally for continuity.
- **Rubric composition:** pure 6-dimension uniform — each question = the 6 weighted `required`
  dimensions + the shared critical-error `forbidden` gates + one `advisory` forbidden gate carrying
  the pending conflict.
- **Conflict exemption:** the advisory gate fires `violated` + a *disclosure* warning but is
  excluded from the cap trigger.
- **Default bank:** the imported bank is set as the enabled system default (demoting the demo
  bank), reusing the one-enabled-default invariant.

## Design

### Model / migration
- `checklist_item.advisory: bool` (default `false`) — marks the pending-conflict gate. Threaded
  through `DraftItem` → `parse_draft_items` → `_persist_draft`/`update_items` and `RubricItem`.
- `question.weight: int` (default `1`) — per-question weight for interview-level aggregation
  (backward-compatible; equal weighting unchanged).
- One Alembic migration adds both columns.

### Scoring engine (`scoring_engine.py`)
- `OUTCOMES = (Meets Expectations, Needs Improvement, Does Not Meet)`; `outcome_for_score(score)`
  applies the 70/40 thresholds.
- `cap_outcome(natural, *, critical_fired)` lowers the natural outcome to *Needs Improvement* when a
  **non-advisory** forbidden fired, returning `(outcome, capped)`.
- A fired **advisory** forbidden is disclosed with a distinct warning prefix and is **excluded**
  from `critical_fired`, so it never caps.
- `QuestionResult` gains `outcome` + `capped`; `grade_for_score` is retained for regression/internal
  continuity. Existing 4-state weighted scoring (`met 1.0 / partial 0.5 / not_met 0 / violated 0`)
  is unchanged — the 6 dimensions are simply 6 `required` items.

### Aggregation (`state_machine.score_and_finalize`)
- Interview total becomes the **weight-normalised mean** of graded question scores:
  `Σ(score_i · weight_i) / Σ(weight_i)` (stub questions still excluded from the numerator).
- The report dict adds interview-level `outcome`/`capped` and per-question `outcome`/`capped`/
  `weight`; `ReportOut` exposes the matching optional fields (the report has no persisted table, so
  this is the only aggregation site).

### Deploy-time importer (`scripts/import_rfcsm_bank.py`, gitignored/local-only)
- Reads the gitignored source at run time and is itself gitignored (it carries client-specific
  strings, so it never enters the public repo): parses the question set, **F1-ingests** the real
  SOP/WI/JD documents
  (`ingest_document`, offline) into a `filename → SopDocument.id` map, creates the bank as the
  enabled default, adds the questions, and authors each rubric **programmatically** (bypassing the
  LLM draft path so real `source_document_id`s are bound) as 6 `required` dimensions + the critical
  gates + the advisory gate. The evidence/traceability dimension binds to the question's
  **first-cited** ingested document.
- **Idempotent:** skips an existing bank unless `--force` (which cascade-deletes the prior bank +
  its questions/checklists first). SOP docs are re-ingested only when absent or previously failed.

### Frontend report (`ReportView` / `ScoreGauge`)
- The executive headline shows the **outcome** badge (colour-tiered) alongside the gauge; the gauge
  colour tracks the outcome tier when present, else the letter band.
- A **cap note** renders when `capped`; the pending-conflict **disclosure** renders as a neutral
  note (not a red failure), partitioned from hard critical-error warnings by the backend's stable
  warning prefix. i18n in both `en-US` and `zh-CN`.

## Testing (zero Azure, mock providers)
- `scoring_engine`: dimension weighting; `outcome_for_score` boundaries; non-advisory violated →
  capped to *Needs Improvement*; advisory violated → disclosed, **not** capped.
- `state_machine`: equal-weight regression + unequal-weight aggregation; stubs excluded.
- checklist model/migration: `advisory` round-trips; `update_items` passthrough.
- importer: runs against a **synthetic** source dir in `tmp_path` (fabricated questions + `.txt`
  stand-in SOPs — never real client material) asserting bank-as-sole-default, 9 questions,
  6-dim weights summing to 100, gates + advisory, evidence dimension bound to an ingested document,
  idempotency, and `--force` rebuild.
- frontend vitest: three-tier outcome headline + cap note + neutral conflict disclosure; gauge
  outcome-awareness.

## Out of scope / deferred
- Persisted `interview_report` table (report stays recompute-on-demand).
- LLM-drafted 6-dim rubrics (importer authors them programmatically for exact source binding).
- Owner validation of the pending conflict (tracked separately; until then the advisory exemption
  holds).
