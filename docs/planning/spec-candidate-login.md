<!-- Promoted from the gstack /spec archive. Filed as GitHub issue #102 (https://github.com/huqianghui/AI-interview-vibe-coding/issues/102), 2026-09-22. -->

# Candidate login for `/interview` + admin-managed interview accounts

Owner decisions (2026-09-22, via `/spec`): D1 derived passwords (always viewable by admin, never stored in plaintext) · D2 only `role=user` may take interviews · D3 Users tab = list + view/reset password + create + deactivate/activate · D4 seeded usernames `user1 / user2 / user3`.

## Context

`/interview` is fully anonymous today: the frontend (`frontend/src/api/client.ts:215 ensureSession()`) calls `POST /public/candidate/session` (no auth, `backend/app/api/candidate_session.py:19`) and gets an `X-Anon-Session` token, so anyone with the URL can start an interview and burn Azure voice/scoring quota. The client requires the interview page to ask for a username + password, and wants the admin to maintain those accounts in the existing `/admin` page. Existing base: `User` model with `admin`/`user` roles, JWT `/auth/login`, `/admin/users` with list/patch/deactivate (no create). `SPEC.md` §4 currently says "Candidate: anonymous session" — this spec revises that line.

## Current State (verified 2026-09-22)

| Component | Today | Gap |
|---|---|---|
| `POST /public/candidate/session` | unauthenticated | must require a valid `user` JWT |
| `anonymous_candidate_sessions` | no `user_id` | add nullable FK so a session is attributable |
| `users` | only `hashed_password` | add `password_generation` for derived passwords |
| `/admin/users` (`backend/app/api/admin_users.py`) | GET list / GET one / PATCH / DELETE(soft) | no POST create, no reset-password, no `generated_password` in the response |
| `backend/app/services/user_seed.py` | seeds admin only | seed 3 candidate accounts |
| `/interview` (`frontend/src/pages/InterviewPage.tsx`) | no login | login gate + sign-out |
| `/admin` (`frontend/src/pages/AdminPage.tsx:175,438`) | tabs Content / Azure connection | add Users tab |
| `SECRET_KEY` | Container App secret from a bicep param, stable per deployment | derived passwords may depend on it |

## Proposed Change

**Auth model.** Keep the anonymous-session machinery (interview_sessions FK points at it; smallest change). Lock only the creation step: `POST /public/candidate/session` requires `Authorization: Bearer <user JWT>` with `role == "user"` and `is_active`; the session row records `user_id`. All other interview calls keep using `X-Anon-Session` unchanged.

**Derived passwords (D1).**
```
password = base32(HMAC-SHA256(key=SECRET_KEY, msg=f"candidate-password:v1:{username}:{generation}")).lower()[:12]
formatted as xxxx-xxxx-xxxx — the HYPHENATED string IS the password (hashed as such, typed exactly as shown); no login-side normalization, so /auth/login stays untouched
```
- `users.password_generation INTEGER NULL`: non-null = system-derived password, viewable by admin; NULL = self-set password (the admin account), not viewable.
- `hashed_password` still stores the bcrypt hash; `/auth/login` is unchanged. Derivation is used only for seeding and for the admin view/reset.
- Reset = generation + 1, re-derive, re-hash. Rotating `SECRET_KEY` invalidates every derived password; the admin must reset each one (documented in the client manual).

**Seeding (D4).** `user_seed.py` gains `seed_default_candidates()`: `user1`, `user2`, `user3`, role `user`, email `userN@local`, generation 1. Idempotent by username. Always on (unlike the admin seed, no env gate) because without accounts the interview page is unusable.

**Backend API (D3).**
| Endpoint | Change |
|---|---|
| `POST /public/candidate/session` | add `require_role("user")`; store `user_id`; admin account → 403 `detail="Admin accounts cannot take interviews"` |
| `GET /admin/users` | response gains `generated_password: str \| null` |
| `POST /admin/users` | new: `{username, full_name?}` → role `user`, generation 1, returns user incl. `generated_password`; duplicate username → 409 |
| `POST /admin/users/{id}/reset-password` | new: generation + 1, returns user incl. new password; 400 when generation is NULL |
| `PATCH /admin/users/{id}` | unchanged (is_active on/off) |

**Frontend.**
- `/interview`: with no candidate JWT show a login card (same look as the admin sign-in, copy "Candidate sign-in / 候选人登录"); on success store `sessionStorage.candidate_access_token` and continue the existing flow. `ensureSession` sends the bearer; a 401/403 clears the token and returns to the login card with the reason (403 → "Admin accounts cannot take interviews"). A "Sign out" button in the header clears both tokens and the saved interview id.
- `/admin`: new **Users** tab — table (username / password with copy / status / actions: reset password, deactivate/activate) + an "Add account" input.

**Migration.** New alembic revision after head `f6a7b8c9d0e1`: `users.password_generation`, `anonymous_candidate_sessions.user_id`.

## Acceptance Criteria
1. Unauthenticated `/interview` shows only the login card; `POST /public/candidate/session` without a bearer returns 401.
2. `user1` logs in with the password shown on the admin page and completes a full interview (text and voice paths).
3. The `admin` account logging in on the interview page sees the "admins cannot take interviews" message; the backend returns 403.
4. A deactivated account gets 401 on interview login; an already-running interview session keeps working (row-level checks, not retroactive).
5. After a backend restart (Azure rebuilds SQLite) the passwords of `user1..3` are byte-identical to before.
6. The admin Users tab can create, reset password, deactivate/activate; the displayed password logs in.
7. `anonymous_candidate_sessions.user_id` is non-null for every new session.
8. `SPEC.md` §4, `docs/IMPLEMENTATION-STATUS.md`, `CHANGELOG.md`, `delivery/docs/手册-v2.md` (new "候选人账号" section) updated.
9. All existing tests pass; backend coverage ≥ 85%.

## Testing Plan
| Layer | What | Count |
|---|---|---|
| Unit (backend) | derivation stability/format; seed idempotency; create / reset / 403 / 401 / 409 | +9 |
| Unit (frontend) | login card render, 401/403 branches, sign-out; Users tab create/reset/deactivate | +6 |
| E2E | the 13 specs that start an interview get a shared login step (read user1's password via the admin API); new admin Users tab spec | modify 13 + 1 new |
| Existing backend | 9 test files using anonymous sessions create a user and send the bearer | modify 9 |

## Rollback
Single PR; revert restores anonymous mode. The migration only adds nullable columns and downgrades safely.

## Effort (CC + gstack)
backend ~25 min · frontend ~30 min · test migration ~30 min · docs ~10 min.

## Files Reference
| File | Change |
|---|---|
| `backend/app/models/user.py` | `password_generation` column |
| `backend/app/models/anonymous_session.py` | `user_id` FK |
| `backend/alembic/versions/<new>_candidate_login.py` | migration |
| `backend/app/services/auth_service.py` | `derive_candidate_password()` |
| `backend/app/services/user_seed.py` | `seed_default_candidates()` |
| `backend/app/main.py` | call the candidate seed at boot |
| `backend/app/api/candidate_session.py` | `require_role("user")`, store `user_id` |
| `backend/app/api/admin_users.py` | POST create, POST reset-password, `generated_password` |
| `backend/app/schemas/auth.py` | `AdminUserResponse.generated_password`, `UserCreate` |
| `frontend/src/api/client.ts` | bearer on session creation, 401/403 handling, sign-out |
| `frontend/src/api/auth.ts` | candidate token helpers |
| `frontend/src/pages/InterviewPage.tsx` | login gate + sign-out |
| `frontend/src/pages/AdminPage.tsx` | Users tab |
| `frontend/src/api/admin.ts` | users API client |
| `frontend/src/i18n.ts` | en-US / zh-CN strings |
| `frontend/e2e/*.spec.ts` | shared candidate login helper |
| `SPEC.md` §4, `docs/IMPLEMENTATION-STATUS.md`, `CHANGELOG.md`, `delivery/docs/手册-v2.md` | docs |

## Clarifications (folded in after the codex quality gate, score 7/10)

- **Hyphens.** The 14-char hyphenated string is the password itself; `/auth/login` and `verify_password` are untouched.
- **SECRET_KEY rotation.** `GET /admin/users` computes `generated_password` only when `verify_password(derived, hashed_password)` is true; otherwise it returns `generated_password: null, password_stale: true` and the UI shows "Reset required". Reset always re-derives from the current key, restoring consistency. No silent invalidation of hashes.
- **What survives an ephemeral-SQLite rebuild (Azure public demo + client delivery).** Only the three seed accounts (generation 1, derived from the deployment's stable `SECRET_KEY`) — AC5 covers exactly these. Admin-created accounts, resets (generation > 1), and deactivations are lost on rebuild, the same as every other admin edit in this deployment model today (documented in the manual). A persistent-DB install keeps everything.
- **Seed idempotency.** By username only: if `user1/2/3` already exist in any state (other role, inactive, NULL generation) the seed leaves them untouched and logs at INFO.
- **Account creation rules.** Username trimmed and lowercased, `^[a-z0-9][a-z0-9._-]{2,31}$`, else 422; duplicate → 409; email auto-set to `{username}@local`; `full_name` defaults to the username; role always `user`; generation 1.
- **Deactivated account.** `get_current_user` (`backend/app/dependencies.py:50`) already rejects `is_active=False` on every bearer call, so a deactivated user cannot mint a NEW candidate session even with a valid JWT (401). An already-minted anonymous session keeps working until it expires (row-level checks only).
- **Pre-existing anonymous sessions / saved interviews.** `user_id` is nullable; old rows stay valid and resume works — but the page now shows the login card first, so resume only runs after a successful login. No data migration.
- **Sign-out.** Clears `sessionStorage.candidate_access_token`, `localStorage.anon_session_token`, `localStorage.interview_session_id`; leaves `sessionStorage.admin_api_token` alone; disconnects the voice hook first (existing teardown path).
- **403 wording.** A dedicated `require_candidate` dependency in `candidate_session.py` (not the generic `require_role`) raises 403 `detail="Admin accounts cannot take interviews"`; the login card displays the backend `detail` verbatim (i18n only for the 401 "wrong username or password" case).
- **Admin visibility rules.** `generated_password` is null for generation-NULL accounts (the admin) and non-null for derived accounts regardless of `is_active`; reset-password is 400 for generation-NULL accounts; concurrent resets are last-write-wins.
- **"Full interview" (AC2).** E2E asserts the existing report screen renders (`candidate-interview.spec.ts` already does), for both the text path and the mock-voice path.
- **Coverage (AC9).** `cd backend && pytest -q` with the configured `--cov-fail-under=85` (`pyproject.toml:61`); baseline today 85.53%.
- **Affected tests, enumerated.** E2E (13): admin-and-report, anon-recovery, audio-turn2-diagnostic, audio-diagnostic, avatar-diagnostic, candidate-interview, avatar-stability-probe, external-interview-live, external-voice-live, external-interview, readme-live-screenshots, readme-screenshots, voice-live-azure. Shared helper: `frontend/e2e/helpers/candidateLogin.ts` (logs in as seeded `admin`, reads `user1`'s `generated_password` from `GET /admin/users`, then logs in as `user1` and seeds `sessionStorage.candidate_access_token`). Backend (9): test_admin_checklist_api, test_anonymous_session, test_external_interview, test_interview_state_machine, test_interview_api, test_question_bank, test_scoring_service, test_report_stream, test_sop_source_features — via a new `candidate_auth` conftest fixture mirroring `admin_auth`.

## Out of Scope
- Per-candidate interview history / reports in admin (next round)
- Rename, hard delete, candidate self-service password change, login lockout
- Candidate JWT lifetime stays the 24h default
- Code-level silent-advance (no auto-response) mode for bank personas (separate track)

## Confirmed assumptions
- A1 usernames fixed `user1/user2/user3`, not env-configurable.
- A2 derived password: 12 lowercase base32 chars, shown `xxxx-xxxx-xxxx`.
- A3 Users tab has no pagination/search UI (the list API already supports `search`).
- A4 the Voice Live WS proxy keeps trusting `X-Anon-Session` only; no extra JWT check.

---

## Engineering review (`/plan-eng-review`, 2026-09-22) — decisions that supersede the spec above

**Scope decision (Step 0, SCOPE_REDUCED):** ship the minimal version — login gate on `/interview`, seeded `user1/user2/user3`, and a **read-only** admin Users tab (list + view derived passwords). No create-account and no reset-password endpoints or buttons in this PR (owner: accounts are generated once at first boot, like the admin account; runtime account management is not needed). Sign-out button kept.

| # | Finding | Decision |
|---|---|---|
| 1 | [P1] A leftover `anon_session_token` in localStorage plus the mount-time `resumeInterview()` (`InterviewPage.tsx:568-574`) would bypass the login gate; clearing it blindly would lose the in-progress interview | **1A** — session rows store `user_id`; `POST /public/candidate/session` returns the caller's existing unexpired, unrevoked session when one exists (idempotent), so resume survives re-login; the page shows the login card whenever the candidate JWT (sessionStorage) is absent, discards any leftover anon token, and always re-requests the session after login |
| 1+ | Interview endpoints trust `X-Anon-Session` alone (`dependencies.py:68-79`) — a copied anon token works for its 120-min TTL | **1+B** — keep as is (accepted residual risk); ownership is enforced only at session creation |
| 2 | [P1] `client.ts:198-207` 401 self-heal calls `ensureSession()` with no identity → after this change it fails with a bare red `401` line and no way out | **2A** — `ensureSession()` sends the bearer; 401/403 from the session endpoint raise a typed `CandidateAuthError(status, detail)` and clear both tokens; `InterviewPage.guard()` routes it to the login card showing the backend `detail` verbatim |
| 3 | [P2] `voice_live_ws.py:74-83` accepts any active non-anonymous JWT (no role check) — candidate JWTs now exist | **3 keep** — owner: any logged-in (non-anonymous) account may use the WS channel; no role check |
| 4 | [P2] `users.password_generation` is unnecessary under the reduced scope | **4B** — keep the column (seed = 1, admin = NULL) for a future reset feature; `generated_password` is shown only when `verify_password(derived, hashed)` is true, else `password_stale: true` |
| 5 | [P2] `config.py:25` default `SECRET_KEY` makes seeded passwords publicly computable | **5A → superseded by X1** — `SECRET_KEY` becomes REQUIRED: the code default is removed, boot fails with a clear "set SECRET_KEY (see .env.example)" error when it is missing. Local dev reads it from the gitignored `backend/.env` (already set), Azure/client deploys from bicep / gen-secrets.sh, E2E passes a test key in `playwright.config.ts` |
| 6 | [P3] `SPEC.md:64-66` says the anon token "never" touches localStorage; `client.ts:10,175` stores it there | **6A** — rewrite §4 with the login model and the real token storage (candidate JWT → sessionStorage; anon token → localStorage for resume) |
| 7 | [P2] DRY: 27-line admin login card (`AdminPage.tsx:390-416`) would be duplicated | **7A** — shared `components/LoginCard.tsx` (props: title, body, error, busy, onSubmit, testIdPrefix); AdminPage switches to it, `admin-*` testids preserved |
| 8 | [P2] DRY: third copy of the guarded get/set/clear token trio | **8A** — `api/tokenStore.ts` factory used by admin, anon and candidate tokens; exported names unchanged |
| 9 | [P2] DRY: seed user creation duplicated | **9B** — keep `seed_default_admin` and `seed_default_candidates` separate |

**Test review:** 35 gaps (6 E2E) + 2 mandatory regression suites (the 9 backend test files and 13 E2E specs that start an interview anonymously). All listed in the coverage diagram in the review transcript and in the `/qa` test plan (`~/.gstack/projects/…/huqianghui-feat-candidate-login-eng-review-test-plan-20260922-203452.md`). **Performance:** no blocking issues; `GET /admin/users` bcrypt-verifies only rows with `password_generation` set (3 rows, ~0.5 s total).

### What already exists (reused, not rebuilt)
- `require_role` / `get_current_user` (`dependencies.py:31-65`) — JWT + `is_active` check; deactivated users already get 401 on any bearer call.
- `/auth/login` + `auth_service` bcrypt helpers (already bcrypt-direct, dodging the passlib/bcrypt-5 pitfall).
- `admin_users.py` list / patch / soft-delete; `user_seed.py` admin seed pattern; `admin_auth` conftest fixture (mirror it as `candidate_auth`).
- Admin login card styles + `admin.*` i18n keys; existing E2E admin-login pattern (`candidate-interview.spec.ts` beforeAll).
- Anonymous-session machinery (`anonymous_session_service.py`) — kept; only creation is gated and the row gains `user_id`.

### NOT in scope (considered, deferred)
- Create-account / reset-password endpoints and buttons — accounts are generated once at boot; owner declined a TODO.
- Per-request JWT + session-ownership check on interview endpoints (1+A) — accepted residual risk; owner declined a TODO.
- Role check on the Voice Live WS JWT branch — owner explicitly keeps "any logged-in account".
- Per-candidate interview history in admin; rename / hard delete / self-service password change / login lockout.
- Bank-mode silent-advance switch — captured in `TODOS.md` (admin-configurable, default ON at 3 s).

### Failure modes (new code paths)
| Path | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| `require_candidate` | expired JWT mid-interview | unit + E2E | 401 → `CandidateAuthError` → login card | clear "please sign in again" |
| session reuse-if-active | two tabs log in as user1 simultaneously | unit | both get the same session row (idempotent) | consistent resume |
| `derive_candidate_password` | `SECRET_KEY` rotated after seeding | unit | verify fails → `password_stale` | "Reset required / not viewable" (no wrong password shown) |
| `seed_default_candidates` | `users` table not migrated yet on first boot | existing best-effort try in `lifespan` | logged, startup continues | admin sees no candidate rows → check logs |
| `GET /admin/users` | bcrypt verify slow under load | none (3 rows) | n/a | ~0.5 s list |
| Voice WS | candidate JWT used as WS token | existing specs (anon path) | accepted (3 keep) | n/a |
No critical gaps (every silent failure has a test or an explicit handling path).

### Worktree parallelization
| Step | Modules | Depends on |
|---|---|---|
| S1 backend auth: migration, `require_candidate`, session reuse, derivation, seed, admin list field | `backend/app/**`, `backend/alembic/`, `backend/tests/` | — |
| S2 frontend: `tokenStore`, `LoginCard`, InterviewPage gate, Users tab, i18n, unit tests | `frontend/src/**` | S1's API shapes (documented above; can mock) |
| S3 E2E helper + 13 spec updates | `frontend/e2e/` | S1 + S2 |
| S4 docs: SPEC §4, IMPLEMENTATION-STATUS, CHANGELOG, delivery manual | `docs/`, `SPEC.md`, `delivery/docs/` | S1 + S2 |
Lanes: **A** = S1 (backend). **B** = S2 (frontend, against the documented API contract). Launch A + B in parallel, merge, then S3 and S4 sequentially. No shared module directories between A and B.

### Implementation Tasks
Synthesized from the findings above; checkbox as you ship.
- [ ] **T1 (P1, human ~4h / CC ~20min)** — backend — alembic revision: `users.password_generation` (nullable int), `anonymous_candidate_sessions.user_id` (nullable FK); models updated. Surfaced by: spec + 4B. Files: `backend/alembic/versions/`, `backend/app/models/user.py`, `backend/app/models/anonymous_session.py`. Verify: `alembic upgrade head` on a fresh DB + `pytest -q`.
- [ ] **T2 (P1, human ~4h / CC ~15min)** — backend — `require_candidate` dependency (401 no/invalid/inactive, 403 admin with the exact detail) + `POST /public/candidate/session` reuse-if-active and `user_id` write. Surfaced by: 1A, 1+B, 2A. Files: `backend/app/api/candidate_session.py`, `backend/app/services/anonymous_session_service.py`, `backend/tests/test_anonymous_session.py`. Verify: new unit tests (200/401/403/reuse/expired→new).
- [ ] **T3 (P1, human ~3h / CC ~15min)** — backend — `derive_candidate_password(username, generation)` (HMAC-SHA256 over `SECRET_KEY`, domain label `candidate-password:v1`, 12 base32 chars as `xxxx-xxxx-xxxx`) + `seed_default_candidates()` (idempotent by username, WARNING on default key) wired into `lifespan`. Surfaced by: spec, 5A, 9B. Files: `backend/app/services/auth_service.py`, `backend/app/services/user_seed.py`, `backend/app/main.py`, `backend/tests/test_user_seed.py`. Verify: determinism/format/key-sensitivity tests; boot log check.
- [ ] **T4 (P1, human ~2h / CC ~10min)** — backend — `GET /admin/users` gains `generated_password` + `password_stale` (verify against hash; NULL generation → null/false). Surfaced by: 4B. Files: `backend/app/api/admin_users.py`, `backend/app/schemas/auth.py`, `backend/tests/test_auth.py` or new `test_admin_users.py`. Verify: 3 unit tests (ok / stale / admin).
- [ ] **T5 (P1, human ~1d / CC ~30min)** — frontend — `api/tokenStore.ts` factory (8A); `CandidateAuthError` + bearer on `ensureSession` + 401/403 handling (2A); `components/LoginCard.tsx` (7A) used by AdminPage and the new InterviewPage gate (resume effect only after auth; sign-out clears candidate JWT, anon token, saved interview id; voice teardown first); i18n en-US/zh-CN. Surfaced by: 1A, 2A, 7A, 8A. Files: `frontend/src/api/*.ts`, `frontend/src/components/LoginCard.tsx`, `frontend/src/pages/InterviewPage.tsx`, `frontend/src/pages/AdminPage.tsx`, `frontend/src/i18n.ts`. Verify: vitest (LoginCard, InterviewPage gate branches, tokenStore, client 401/403).
- [ ] **T6 (P1, human ~4h / CC ~15min)** — frontend — Admin **Users** tab (read-only table: username / password with copy / role / active; "not viewable" for NULL generation; "Reset required" when stale) + `api/admin.ts` users client. Surfaced by: scope decision. Files: `frontend/src/pages/AdminPage.tsx`, `frontend/src/api/admin.ts`, `frontend/src/pages/AdminPage.test.tsx`. Verify: vitest renders 3 rows + admin row state.
- [ ] **T7 (P1 REGRESSION, human ~1d / CC ~30min)** — tests — `candidate_auth` conftest fixture; update the 9 backend test files; `frontend/e2e/helpers/candidateLogin.ts` + the 13 E2E specs; new admin Users tab E2E. Surfaced by: test review (mandatory regression rule). Verify: `pytest -q` ≥ 85%; `npm run e2e` green.
- [ ] **T8 (P2, human ~2h / CC ~10min)** — docs — SPEC.md §4 (login model + real token storage, 6A), `docs/IMPLEMENTATION-STATUS.md`, `CHANGELOG.md`, `delivery/docs/手册-v2.md` "候选人账号" section (incl. SECRET_KEY rotation note and what survives an ephemeral rebuild). Surfaced by: spec AC8, 6A. Verify: docs review.
_No new tasks from Performance review._

### Outside voice (Claude subagent; codex refused to run because the project CLAUDE.md's gstack-install gate is not satisfied in its own skill directory) — cross-model decisions
| # | Outside-voice finding | Owner decision |
|---|---|---|
| X1 | Public default `SECRET_KEY` + log-only mitigation | **Adopted (owner's variant):** `SECRET_KEY` required, no code default, boot fails when missing; `.env.example` keeps a placeholder + `openssl rand -hex 32` hint |
| X2 | `password_generation` is YAGNI under the reduced scope | **Keep 4B** (column stays) |
| X3 | Candidate seed ungated while admin seed is gated | **Keep spec:** candidates always seeded; docstring explains why derived, always-on candidate credentials are acceptable where a known-credential admin is not |
| X4 | Decision 3 also means a candidate JWT can pick any `persona_id` on the WS | **Accepted explicitly** (no role check, no persona restriction) |
| X5 | Two devices logging in as `user1` share one interview session | **Accepted:** documented usage rule "one account = one person at a time" in the Users tab hint and the client manual; no code change |
| #4 | Precedent inversion undocumented | Folded: one paragraph in `user_seed.py` docstring |
| #7 | Resume-after-relogin path not traced | Folded: the login card does NOT touch `localStorage.interview_session_id`; after login `ensureSession()` replaces the anon token with the (idempotently reused) session; `resumeInterview()` then reads the saved id as today. E2E "close tab → re-login → same question" pins it |
| #8 | Two auth-failure UX paths | Folded: `request()`'s 401 self-heal calls `ensureSession()`; when that raises `CandidateAuthError` it propagates to the login card, so JWT loss mid-interview and at creation share one path; a pure anon-token expiry with a valid JWT mints a new session and the stale saved interview id is cleared by the existing resume fallback |
| #9 | Shared `LoginCard`/`tokenStore` couples the two flows | **Rejected** (7A/8A stand): `testIdPrefix` is test isolation, not behavioural divergence; post-login behaviour lives in the pages, not the card |

Implementation task delta: **T3** gains "make `SECRET_KEY` required (remove default, startup check, `.env.example` note, E2E key)"; **T6/T8** gain the "one account = one person at a time" hint + manual sentence.


## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN, SCOPE_REDUCED) | 9 issues + 5 cross-model decisions, 0 critical gaps, 35 test gaps planned |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** outside voice (Claude subagent) raised 9 points; 1 adopted (X1), 4 folded as clarifications (#4, #7, #8 + X5 documentation), 3 kept as previously decided (X2, X3, X4), 1 rejected (#9). No unresolved tension.
- **VERDICT:** ENG CLEARED — ready to implement (scope: login gate + seeded user1/2/3 + read-only Users tab).

NO UNRESOLVED DECISIONS
