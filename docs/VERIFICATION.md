# How to verify the requirements and the system

This is the checklist for proving the AI-interview app meets its SPEC. It has two layers:

1. **Automated (zero Azure)** — one command per stack; this is the CI hard gate and covers every
   feature on mock providers. Anyone can run it in minutes.
2. **Manual (dogfood + live Azure)** — click the winning-demo path in a browser, and (optionally)
   run the real Foundry / Voice Live / Search integration.

The spec of record is [`../SPEC.md`](../SPEC.md); what's built vs. the spec is in
[`IMPLEMENTATION-STATUS.md`](IMPLEMENTATION-STATUS.md).

---

## Layer 1 — Automated gate (no Azure needed)

Everything runs on **mock providers**, so no Azure creds are required. This is exactly what CI runs
on every PR (`.github/workflows/ci.yml`: jobs `backend`, `frontend`, `e2e`).

### 1a. Backend — lint, format, migrations, tests + coverage

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # first time only
pip install -e ".[dev]"                              # first time only
ruff check app tests          # lint
ruff format --check app tests # format gate (run `ruff format` to fix)
alembic upgrade head          # migrations apply cleanly
pytest -q                     # 230 tests, ≥85% coverage gate (currently ~91%)
```

Expected: `All checks passed!`, `N files already formatted`, migrations run to head, and
`230 passed … Required test coverage of 85% reached.`

### 1b. Frontend — typecheck, lint, unit tests, build

```bash
cd frontend
npm ci            # first time only
npm run typecheck # tsc --noEmit
npm run lint      # eslint, --max-warnings 0
npm run test      # vitest — 21 unit/component tests
npm run build     # tsc -b && vite build
```

Expected: no type errors, no lint warnings, `21 passed`, a clean production build.

### 1c. End-to-end — real browser, mock providers

```bash
cd frontend
npx playwright install chromium   # first time only
npm run e2e                        # boots backend + frontend, runs 4 specs in Chromium
```

Expected: `4 passed`. Playwright boots a fresh migrated SQLite DB + the API (mock providers, known
admin token) on :8100 and the vite dev server on :5273, then drives:

| Spec | SPEC coverage | What it proves |
|---|---|---|
| Candidate text interview | F6/F7/F8/F9 | land → orientation → answer → **F7 follow-up quoting the candidate's own words** → report. |
| P3 boundary | P3 | candidate page never leaks `checklist`/`rubric`/`expected_points`/`weight`/`source_quote`. |
| Admin authors bank + checklist → scored report | F2b/F3b/F3/F4/F8 | admin sign-in → default bank → question → checklist draft (weights = 100) → candidate reaches a **scored** exec report (grade gauge + SOP-source-beside-answer) + per-item detail. |
| Voice, no mic | F9 AC#4 | voice with no microphone surfaces the permission / unavailable notice — never hangs. |

**If all of Layer 1 passes, every one of the 9 features + both admin editors is verified against
its acceptance criteria on mocks.** See the SPEC↔feature map in `IMPLEMENTATION-STATUS.md`.

---

## Layer 2 — Manual dogfood (mock providers, real clicks)

Run the two servers yourself and walk the winning-demo path in a browser.

```bash
# Terminal 1 — backend on :8000 (mock providers, admin token for the /admin page)
cd backend && source .venv/bin/activate
ADMIN_API_TOKEN=dev-admin \
DEFAULT_LLM_PROVIDER=mock DEFAULT_RETRIEVAL_PROVIDER=mock DEFAULT_VOICE_PROVIDER=mock \
uvicorn app.main:app --reload --port 8000

# Terminal 2 — frontend on :5173 (proxies /api → :8000)
cd frontend && npm run dev
```

Open **http://localhost:5173**. Routes: `/interview` (candidate) and `/admin` (editor).

### Winning-demo path (SPEC §1)

1. **Admin** (`/admin`): sign in with `dev-admin` → create a question bank, set it default → add a
   question → **Draft from SOP** and confirm the checklist weights total **100**.
2. **Candidate** (`/interview`): Start → orientation → answer the question in text.
3. **Memory (F7):** a follow-up appears **quoting your earlier answer** ("You mentioned…").
4. **Report (F8):** finish → executive report with an **A–F grade gauge**, strength/gap narrative,
   and **SOP source shown beside your answer** (the P14 evidence). Toggle detail for per-item
   judgments (met / partial / not-met / violated).
5. **P3 check:** nowhere on the candidate side do you see rubric/checklist/expected-points text.
6. **Voice (F9):** click answer-by-voice. With no mic (or denied), you get the mic-permission /
   voice-unavailable notice, not a hang.

This is the same path the E2E suite asserts — Layer 2 is the human confirmation of it.

---

## Layer 3 — Live Azure validation (optional, needs creds)

Only needed to prove the real Foundry IQ / Voice Live / Search integration (Layer 1 already proves
the app logic). Config resolves **DB > .env > code default**, so there are two ways to point the app
at a real resource:

**Option A — the admin config page (the runtime source of truth).** Boot on mocks as in Layer 2,
open `/admin` → **Azure config**, and enter the Foundry endpoint, API key, project, and a deployed
model. Save (the key is stored encrypted; the agent-sync + Voice Live adapters re-register
immediately) and hit **Test connection**. A candidate interview then runs against the
DB-configured resource — this proves "online mode reads from the user's config," no `.env` edit.

**Option B — `.env` (dev fallback).**

```bash
cd backend
cp .env.example .env     # then fill in real endpoints/keys — .env is gitignored, never commit it
```

Flip the providers to real (`DEFAULT_LLM_PROVIDER=azure_openai`, `DEFAULT_RETRIEVAL_PROVIDER=azure`,
`DEFAULT_VOICE_PROVIDER=azure`, `DEFAULT_AGENT_SYNC_PROVIDER=azure`) and boot as in Layer 2.

**Critical deploy knob — model deployments.** The model MUST be a deployment that exists on your
resource. `gpt-4o` (the neutral code default) is **NOT** deployed on the demo resource and 404s on
agent-create / Voice Live. Deployed there: `gpt-5.4-mini`, `gpt-4o-mini`, `gpt-5.4`, `gpt-5`. Set a
deployed model in the config page or via `FOUNDRY_AGENT_MODEL` / `VOICE_LIVE_DEFAULT_MODEL`. For
persistent encrypted config across restarts, set `ENCRYPTION_KEY`. See `backend/.env.example` for
every knob.

**What's been validated live** (against `avarda-demo-prj`, 2026-08-09 — see IMPLEMENTATION-STATUS):

- ✅ Interviewer agent create → read → delete on the real Foundry project.
- ✅ SOP knowledge base bound as an **MCPTool** (not `azure_ai_search`), persisted on the agent.
- ✅ A real retrieval turn returning a grounded answer citing SOP content (`【n:n†source】`).
- ✅ Voice Live credential chain (Entra bearer) through the signaling WebSocket handshake.

**Still pending a live human run** (needs a browser + mic, not code): the full voice WebRTC audio
round-trip — mic in, avatar audio/video out.

---

## One-glance summary

| Layer | Command(s) | Proves | Azure? |
|---|---|---|---|
| Backend gate | `ruff check` + `ruff format --check` + `alembic upgrade head` + `pytest -q` | API logic, scoring, migrations, 85%+ cov | No |
| Frontend gate | `npm run typecheck` + `lint` + `test` + `build` | UI logic, i18n parity, build | No |
| E2E | `npm run e2e` | Winning-demo path in a real browser | No |
| Dogfood | run both servers, click `/interview` + `/admin` | Human confirmation of the demo path | No |
| Live Azure | admin config page (or `backend/.env`) → real resource | Real Foundry IQ / Voice Live / Search | Yes |
