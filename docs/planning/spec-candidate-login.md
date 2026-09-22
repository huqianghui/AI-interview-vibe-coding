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
