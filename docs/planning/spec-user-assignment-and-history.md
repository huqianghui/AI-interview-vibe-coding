# Spec: per-user interviewer + bank assignment, and interview history

Status: APPROVED, filed as #187 (from `/spec`, 2026-10-07). Owner answers: assignment is per logged-in user; no
assignment falls back to the global default; exactly one persona + one bank per user; history is
visible to BOTH admin (in the Users tab) and candidate and includes `abandoned` interviews.

## Context

Every candidate today gets the same interviewer and the same question bank: whichever persona and
bank carry `is_default`. An admin running interviews for several different roles cannot give each candidate the right interviewer and question set
without flipping the global default between interviews, which also repoints any interview already
in progress. Interviews are already stored, but nobody can see a user's past interviews: the API
only fetches one interview by id.

## Current State (verified 2026-10-07, main @ f5326e9)

| Concern | Today | Where |
|---|---|---|
| Interviewer for a new interview | global `get_default_persona(db)` | `backend/app/api/interview.py:329` (`_start_fresh`) |
| Persona read during an interview | global default, re-read on every call (5 call sites) | `interview.py:244`, `judge_flow.py:124,214`, `voice_live_ws.py:172` |
| Questions | `resolve_questions(db)` reads the CURRENT default bank on every call (7 call sites) | `backend/app/interview/questions.py:62`; `state_machine.py:216,287,415,740,877`; `judge_flow.py:116,208` |
| Session snapshot | `brain_mode`, `turn_mode` are pinned; **persona and bank are not** | `backend/app/models/interview.py:41` |
| Interview ownership | by `candidate_session_id` (one anonymous-session row), not by user | `interview.py:303` `_owned_interview` |
| User -> candidate session link | `AnonymousCandidateSession.user_id` (nullable; anonymous candidates have none) | `backend/app/models/anonymous_session.py:36` |
| Admin user list | read-only `GET /admin/users` | `backend/app/api/admin_users.py:20`, UI `frontend/src/pages/admin/UsersTab.tsx` |
| History list | none (admin or candidate) | - |

Consequence of the missing pin (architecture-review deferred item 1): switching the default bank
while an interview is in progress makes `current_question_index` point into a different bank.
Per-user assignment makes this routine instead of rare (an admin reassigns a user mid-interview),
so this spec fixes it as a prerequisite.

## Proposed Change

```
#1 Pin persona_id + bank_id on InterviewSession  ──>  #2 Per-user assignment  ──>  #3 History (admin + candidate)
```

Order rationale: #2 without #1 lets a reassignment corrupt a live interview; #3 needs #1 to show
which interviewer and bank each past interview used.

### 1. Session pin

- Migration: add to `interview_sessions`
  - `persona_id VARCHAR(36) NULL REFERENCES interviewer_personas(id) ON DELETE SET NULL`
  - `bank_id VARCHAR(36) NULL REFERENCES question_banks(id) ON DELETE SET NULL`
  - No backfill: existing rows stay NULL and keep today's behaviour (read the current default).
- `_start_fresh` resolves the persona + bank once (see #2) and writes both onto the new session.
- `resolve_questions(db, bank_id: str | None)`: `bank_id` given -> that bank's enabled questions;
  NULL -> current default bank (legacy rows); still falls back to `FALLBACK_QUESTIONS` when the
  bank is missing/disabled/empty. Every one of the 7 call sites passes `session.bank_id`.
- New `persona_service.get_session_persona(db, session)`: `session.persona_id` if that persona
  still exists, else the current default. The 5 per-interview call sites use it instead of
  `get_default_persona`.
- A pinned bank that is later DISABLED keeps serving its questions to the interview already
  pinned to it (an interview never changes question set mid-way); only new interviews skip it.

### 2. Per-user assignment

- Migration: add to `users`
  - `assigned_persona_id VARCHAR(36) NULL REFERENCES interviewer_personas(id) ON DELETE SET NULL`
  - `assigned_bank_id VARCHAR(36) NULL REFERENCES question_banks(id) ON DELETE SET NULL`
  - Two columns, not a separate table: the owner chose exactly one of each per user.
- Resolution at `_start_fresh` (and `restart`), per field independently:
  1. candidate session has a `user_id` AND that user's assigned persona/bank exists and is
     **enabled** -> use it;
  2. otherwise -> the global default (today's behaviour). Anonymous candidates always get step 2.
- `brain_mode` and `turn_mode` come from the RESOLVED persona (today: from the default persona).
- A resumed interview keeps its pinned persona + bank even if the assignment changed since; the
  new assignment applies from the user's next fresh start.
- API: `PATCH /admin/users/{user_id}/assignment`, admin-only.
  - Body: `{"persona_id": str | null, "bank_id": str | null}` (null = use the default).
  - 404 unknown user; 422 unknown or disabled persona/bank id; 200 returns the updated
    `AdminUserResponse`.
- `AdminUserResponse` gains `assigned_persona_id`, `assigned_bank_id` (nullable).
- UI, `UsersTab.tsx`: two dropdowns per `user`-role row, "Interviewer" and "Question bank", each
  listing enabled personas/banks plus a first option "Default (<current default name>)". Saves on
  change, shows a success/error toast. Admin rows show no dropdowns.

### 3. Interview history

- Ownership moves from the candidate-session row to the user: a logged-in candidate owns every
  interview whose candidate session has their `user_id` (a login after expiry mints a new
  candidate session, so session-scoped ownership would hide older interviews). Anonymous
  candidates keep session-scoped ownership. Non-owned ids still return 404 (no existence leak).
- Endpoints:
  - `GET /interview/history` (candidate): own interviews, newest first.
  - `GET /admin/users/{user_id}/interviews` (admin): that user's interviews, newest first, all
    statuses. 404 unknown user.
  - Both return `InterviewHistoryItem` rows:
    ```json
    {"id": "...", "status": "completed|in_progress|abandoned|created",
     "started_at": "...", "completed_at": "... | null",
     "persona_name": "... | null", "bank_name": "... | null",
     "total_score": 0-100 | null, "outcome": "... | null"}
    ```
    `persona_name`/`bank_name` are null for legacy rows and for a pinned row that was deleted;
    the UI shows "Default (not recorded)". Score/outcome are null unless a report exists.
  - All statuses are listed, including `abandoned` (owner decision).
- Opening a past report reuses the existing report view and `GET /interview/{id}/review`; the
  admin path gets a matching `GET /admin/interviews/{id}/review` (admin-only, any user).
- `GET /admin/interviews/{id}/transcript` (admin): the interview's `InterviewTurn` rows in order
  (`turn_index`, `role`, `turn_kind`, `content`, `created_at`), so an `abandoned` or
  `in_progress` interview, which has no report, still has something to read.
- UI:
  - Candidate: a "My interviews" list on the landing page below the start card (only for a
    logged-in user; hidden when empty). Each row: date, interviewer, bank, status chip, score;
    completed rows open the report.
  - Admin: inside the existing Users tab (owner, 2026-10-07: "admin 在 admin user 里面查看"), no
    new tab.
    - Each `user`-role row gets an "Interviews (N)" action that expands that user's history under
      the row: date started, date completed, interviewer, bank, status chip (`in_progress`,
      `completed`, `abandoned`, `created`), score, outcome. Newest first; all statuses, including
      in-progress.
    - Clicking a history row opens a detail view (drawer over the Users tab): the report (same
      `ReportView` the candidate sees, with its existing "Download PDF" button) when the interview
      was scored, and the full transcript below it for every status. Unscored rows show
      "No report yet (status)" + transcript; an `in_progress` row's transcript is what exists so
      far.
    - Download: the report PDF (existing `ReportPdfButton`), plus "Download transcript" which saves
      the transcript as a `.txt` built client-side (timestamp, speaker, text per line).
    - Expanded rows / open drawer survive admin tab switches, like the other admin tabs (#181).
- Strings in en-US and zh-CN.

### Found during implementation (2026-10-07)

- **Reports were never saved.** `POST /report` re-scored with the LLM on every call (median ~18 s
  per question), so a history had no score or report to show. `interview_sessions` gains
  `report_json` / `total_score` / `outcome`, written by every scoring run; the history reads them.
- **Admin "Generate report"** (`POST /admin/interviews/{id}/report`): a `completed` interview the
  candidate never submitted has no report, so the admin can score it from the detail view.
  409 before completion and for external-brain interviews.
- **Final route shapes:** candidate `GET /candidate/interviews`, `GET /candidate/interviews/{id}`
  (detail = item + saved report + transcript); admin `GET /admin/users/{id}/interviews`,
  `GET /admin/interviews/{id}`; plus `.../sop/{document_id}` on both so report citations open
  (same cited-documents-only rule as the live report). The separate `/review` and `/transcript`
  admin routes collapsed into the one detail route.

## Acceptance Criteria

1. Admin sets user U to persona X + bank Y; U logs in and starts an interview; the session row has
   `persona_id = X`, `bank_id = Y`; the first question is Y's first enabled question; the voice
   session uses X's voice/avatar/brain.
2. A user with no assignment, and an anonymous candidate, get the global default persona and bank
   (same as today); their sessions record the default's ids.
3. Assigned persona or bank disabled or deleted -> the next fresh start uses the default for that
   field only; no 500.
4. Changing U's assignment, or the global default bank, while U's interview is in progress does
   not change U's remaining questions or interviewer (failing test written FIRST against current
   main, then fixed).
5. Legacy sessions (NULL `persona_id`/`bank_id`) resume and score exactly as before.
6. `PATCH /admin/users/{id}/assignment` returns 403 for a non-admin token, 404 for an unknown
   user, 422 for an unknown/disabled id.
7. `GET /interview/history` returns only the caller's interviews, all statuses including
   `abandoned`, newest first, including interviews from an expired earlier candidate session.
8. `GET /admin/users/{id}/interviews` lists that user's interviews (all statuses incl.
   `in_progress`); `/admin/interviews/{id}/review` and `/transcript` work for any interview; all
   three are 403 for a non-admin token.
9. Candidate A requesting candidate B's interview or review gets 404.
10. In the Users tab the admin expands user U's interviews, opens a completed one, sees the same report
    the candidate sees, downloads its PDF, and downloads the transcript `.txt`; an `abandoned`
    interview opens with its transcript and "No report".
11. An `in_progress` interview appears in U's list with status "in progress" and its transcript
    so far.
12. OpenAPI snapshot + `schema.d.ts` regenerated (`scripts/export_openapi.py`, `npm run gen:api`).
13. All CI gates green (ruff check + format, pytest coverage >= 85%, tsc, eslint
    `--max-warnings 0`, vitest, e2e, README screenshot freshness).

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit (backend) | assignment resolution: assigned / unassigned / anonymous / disabled / deleted, per field | +6 |
| Unit (backend) | `resolve_questions(bank_id)` pinned / NULL legacy / disabled-pinned / empty | +4 |
| Integration (backend) | reassign + default-bank switch mid-interview keeps the questions (AC4) | +2 |
| Integration (backend) | assignment PATCH auth/validation; both history endpoints incl. abandoned + cross-session + 404 isolation | +8 |
| Unit (frontend) | UsersTab dropdowns save/err; per-user history expand; detail drawer (report vs no-report, in-progress); transcript download; landing "My interviews" | +9 |
| E2E (mock stack) | admin assigns -> candidate login -> interview runs with assigned bank -> appears in candidate history and in the admin Users tab history, PDF + transcript download | +1 |
| Live (local, real Azure) | assigned persona's voice/avatar actually used in the voice session | 1 run |

## Rollback Plan

All columns are nullable with `ON DELETE SET NULL`, and NULL means today's behaviour, so revert the
PR; the alembic downgrade drops the four columns. No data rewrite.

## Effort Estimate

human ~4 days / CC ~4-5 h: 1 h pin + call-site migration and the AC4 test; 1 h assignment API +
UsersTab; 2 h history endpoints + candidate list + admin Users-tab history + i18n; 0.5 h OpenAPI regen, e2e, screenshots.

## Files Reference

| File | Change |
|---|---|
| `backend/alembic/versions/<new>.py` | 4 nullable FK columns |
| `backend/app/models/interview.py:41` | `persona_id`, `bank_id` |
| `backend/app/models/user.py` | `assigned_persona_id`, `assigned_bank_id` |
| `backend/app/interview/questions.py:62` | `resolve_questions(db, bank_id)` |
| `backend/app/interview/state_machine.py` (5 sites), `judge_flow.py` (4 sites) | pass the session's bank / persona |
| `backend/app/api/interview.py:244,303,329` | resolution at start; user-scoped ownership; `/history` |
| `backend/app/api/voice_live_ws.py:172` | session persona |
| `backend/app/services/persona_service.py` | `get_session_persona` |
| `backend/app/api/admin_users.py` | assignment PATCH |
| `backend/app/api/admin_interviews.py` (new) | review, transcript |
| `backend/app/schemas/auth.py` | assignment fields; `InterviewHistoryItem` |
| `frontend/src/pages/admin/UsersTab.tsx`, `useUsersTab.ts` | dropdowns, per-user history, detail drawer |
| candidate landing page | "My interviews" |
| `frontend/src/api/openapi.json`, `schema.d.ts` | regenerated |

## Out of Scope

- Several assignments / interview rounds per user (owner: exactly one).
- Pinning the rubric at scoring time (architecture-review deferred item 2).
- Creating/editing user accounts from the UI (accounts still come from the boot seed).
- Deleting or exporting interview records.
- Per-user assignment for anonymous (not-logged-in) candidates.

## Related

- Architecture review 2026-10-06, deferred item 1 (session does not pin bank/persona).
- #105 candidate login (`AnonymousCandidateSession.user_id`).
- #112 restart / `abandoned` status.
