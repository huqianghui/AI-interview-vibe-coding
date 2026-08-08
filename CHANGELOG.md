# Changelog

## 0.4.1.0 (2026-08-08)

F6 — Turn-by-turn interview state machine, completed to all five ACs. The Step 0 spine (ask →
answer → advance → report over one channel-agnostic event) gains the follow-up hook and verbal
end-of-answer cue. No migration: `follow_up` turn_kind already existed and question follow-up
config is in-code (Step 0 question set).

### Added
- **Follow-up hook (AC #4).** A question may generate up to `max_follow_ups` follow-up turns
  (demo default 0/1). After a candidate answers, if a follow-up is owed the state machine records
  a `follow_up` interviewer turn and stays on the question; the next answer is a `follow_up`
  candidate turn. Progression (`asking → answering → follow_up×0..N → judged → next`) is derived
  from recorded turns, so it survives restarts. Demo q2 now carries one follow-up so the hook is
  exercised end-to-end.
- **Answer grouping (AC #4).** `scoring.group_answers` groups a question's candidate turns (main +
  0..N follow-up) into ONE answer, so a question with a follow-up is scored once, not twice — the
  report keeps exactly one entry per question.
- **Verbal end-of-answer cue (AC #3).** `interview.verbal_cue` — pure, CI-tested detect/strip for
  zh + en cue phrases ("我答完了" / "done" / …), matched only as a trailing terminator so
  cue-like words mid-answer are left intact. When `source=verbal_cue`, the cue is stripped from
  stored/scored content (it's transport signalling, not answer substance). Silence-timeout
  advancement remains native Voice Live EOU detection in the transport layer (F9), not backend
  logic.

### Notes
- Channel-agnostic contract (P9) unchanged: text, voice, and verbal_cue still converge on the
  single `answer_finalized(text, source)` event.
- Interview modules (`state_machine`, `scoring`, `questions`, `verbal_cue`) at 100% coverage.

## 0.4.0.0 (2026-08-08)

F5 — Interviewer digital human. A persona model + admin API configure the interviewer's identity,
voice knobs, and Foundry prompt-agent binding, with the demo-critical Voice Live metadata shape
verified in CI (no Azure needed to run or test).

### Added
- `InterviewerPersona` model + migration `b0fdc500f6d5` with a **partial-unique index**
  (`enabled = 1 AND is_default = 1`) so exactly one enabled default can exist — the invariant is
  DB-enforced, not app-enforced.
- `voice_live_metadata` — a pure, provider-agnostic, 100%-covered builder that owns the exact
  bytes of `microsoft.voice-live.*` agent metadata: snake_case `session` object, disabled caps as
  explicit `null` (EOU sub-object omitted when off), 512-char chunking across `.1`/`.2`/… keys,
  and a `decode_*` inverse for round-trip tests. This is the **guard for the F1 spike Trigger C
  silent failure** — a camelCase key drift turns Portal Voice mode OFF, and now fails CI here
  instead of at demo time.
- `persona_service` — CRUD + one-default enforcement (prefetch-before-flush, SPEC P8) + agent
  sync status transitions (`none`/`pending`/`synced`/`failed`).
- `AgentSyncAdapter` protocol with a `mock` provider (CRUD runs with zero Azure) and a
  coverage-omitted `azure` adapter (DefaultAzureCredential → API-key fallback; create-500 →
  probe-and-update recovery; immutable-agent `create_version` semantics).
- Admin persona API (`/admin/personas`) behind a fail-closed shared-bearer-token guard
  (`require_admin`) — persona config is interviewer-internal and off-limits to candidate sessions
  (SPEC P3/P4). Sync runs inline; a sync failure is a recorded `agent_sync_status=failed` state,
  never a 500 (F5 AC #4).

### Config
- `default_agent_sync_provider` (mock), `foundry_project_endpoint`, `foundry_agent_model`,
  `foundry_api_key`, `admin_api_token` — all default-empty so the app boots with zero Azure.

## 0.3.1.0 (2026-08-08)

F1 spike live-validation — ran the `retrieve` contract against a real Foundry IQ knowledge
base. **Verdict: GO.** The live run corrected three bugs in the reference contract that would
each have silently broken every grounded turn.

### Fixed (reference contract bugs, found live)
- `knowledgeSourceParams.knowledgeSourceName` must be the KB's *knowledge source* name, not the
  index/KB name (the reference passed the index name → HTTP 400). Added
  `azure_search_knowledge_source` config + adapter param.
- `sourceData` is `null` unless the request sends `includeReferenceSourceData: true`; the
  adapter now always sends it.
- `sourceData` fields are per-index (no universal `title`/`url`/`page`). The citation gate is
  now field-configurable (`required_fields` + `field_map`) while keeping the strict
  all-fields-or-drop invariant.

### Added
- `backend/scripts/smoke_retrieve.py` — standalone live `retrieve` smoke test (not in CI; reads
  `AZURE_SEARCH_*` from a gitignored `.env`, auths via key or Azure CLI Entra token).
- Field-map + custom-required-field tests for the gate; SPIKE.md updated with the live findings
  and GO verdict.

## 0.3.0.0 (2026-08-08)

F1 Foundry IQ traceability spike — the code-contract half of de-risking the citation
`retrieve` dependency (SPEC §6, highest risk). Live-validation half deferred to the client's
demo Azure env. All mock/stub-backed; zero Azure required to run or test.

### Added
- SOP models (`SopDocument` + `SopChunk`, SPEC F1) with page/section labels for traceability,
  plus Alembic migration.
- Strict citation full-field gate (`agents/citations.py`, SPEC F1): keeps a citation only if
  `title`+`url`+`page` all present; partials silently dropped; empty = no-match signal. Pure,
  provider-agnostic, 100% CI-covered.
- Azure retrieve adapter (`adapters/azure_retrieval.py`, coverage-omitted): ports the reference
  `retrieve` call shape (`api-version=2026-05-01-preview`); registers only with live creds.
- SOP text-extraction dispatch + overlapping section-aware chunking (`app/sop/`); binary
  parsers (pdf/docx/pptx) isolated in a coverage-omitted module; dispatcher degrades to `""`
  on any failure (never raises).
- `docs/SPIKE-F1-foundry-iq.md`: go/no-go as fallback triggers (P15) + deferred live-validation
  checklist (P16), including the camelCase-metadata Voice-mode trap and the AI Search
  `/docs/search` GA fallback path.

### Fixed
- Retrieval adapter selection keyed on `default_voice_provider` (wrong capability); added a
  dedicated `default_retrieval_provider` setting.

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
