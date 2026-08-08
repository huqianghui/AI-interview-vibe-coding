# Changelog

## 0.2.0.0 (2026-08-08)

Step 0 completion — frontend skeleton + end-to-end thin slice (ask → answer → placeholder
report), all mock/stub-backed (no Azure required to run).

### Added
- Interview state machine (SPEC F6): `InterviewSession` + `InterviewTurn` models, status
  lifecycle (created→in_progress→completed→scored), and the single channel-agnostic
  `answer_finalized(text, source)` event (SPEC P9) shared by text/voice/verbal-cue sources.
- Two hardcoded interview questions + deterministic stub scoring with the fixed 4-state
  judgment vocabulary (`met | partially_met | not_met | violated`) and coverage aggregation.
- Candidate-guarded interview API (`/candidate/interview/start|{id}/answer|{id}/report`) with
  IDOR ownership checks (a candidate can only drive their own interview; 404 hides existence).
- Alembic migration for the interview tables.
- Frontend skeleton: React 18 + TS + Vite 6 + Fluent UI v9 + TanStack Query + React Router +
  i18next (zh-CN/en-US). Interview page drives the thin-slice loop over the text channel;
  language switcher; typed API client with anonymous-session handling.
- Frontend CI job (typecheck + eslint + vitest + build) and Vitest tests for the API client
  and interview page.

## 0.1.0.0 (2026-08-07)

Step 0 skeleton — backend foundation + CI, all mock-backed (no Azure required to run).

### Added
- FastAPI backend scaffold: config (pydantic-settings), async SQLAlchemy 2.0 + SQLite,
  health endpoint, ruff + pytest tooling.
- Provider adapter layer: LLM + retrieval protocols, mock adapters (default local/CI
  providers, zero Azure), and a name-keyed registry. `DEFAULT_*_PROVIDER=mock`.
- Anonymous candidate session auth: JWT (`typ=anon` + `sid`), `X-Anon-Session` header,
  DB-row-authoritative expiry/revocation, session-create endpoint.
- Alembic async migrations + first migration (anonymous_candidate_sessions).
- CI hard gate (GitHub Actions): ruff lint + format check, migrations apply, pytest with
  85% coverage gate. In-memory SQLite test doubles.
- SPEC.md: full 9-feature technical spec (post /office-hours → /spec → /autoplan review).
