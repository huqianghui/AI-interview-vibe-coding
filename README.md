# AI Interview

An SOP-based interview web app with an **AI digital-human interviewer** — built as a sales PoC to
production standard. A candidate is interviewed by a live avatar (Azure Voice Live + Azure AI
Foundry agent), answers by voice or text, gets a real-time nudge from a backend judge when an
answer trails off mid-thought (**Judged** turn mode), and receives an on-the-spot report where
every judgment traces back to the
client's own SOP document — **document name + page, item by item**.

> This repo is public: it contains no client names, no real SOP content, and no candidate data.
> Everything runs on mock providers by default — **zero Azure needed** to build, test, or demo.

**Four capabilities demonstrated:** AI · digital human · RAG · live judging.
The differentiator is **SOP-traceable, source-cited compliance scoring**: the system scores whether
answers comply with the client's *own* SOP, and every judgment points back to its source.

## Key scenarios

> Screenshots are current as of **v0.42.2.0**, captured on the zero-Azure mock stack (the one
> exception is the live digital-human shot below, which needs real Azure). The appearance is the
> project's own design language, **Warm Editorial / Foundry Purple** — a warm sand ground,
> Bricolage Grotesque + Literata, a purple action colour, and one shared content width — not
> Fluent's factory defaults.

### 1. Signing in — the interviewer is the screen

The candidate's first screen is the person who will interview them. The interviewer's portrait,
the one promise that matters before starting (*you can speak or type, and you decide when each
answer is finished*), and the form — nothing else.

![Candidate sign-in — interviewer portrait beside the form](docs/images/00-signin.png)

### 2. Before the interview — what you are walking into

Signed in, the candidate sees who is interviewing them and the three things people actually worry
about before starting. The next screen is the only one that says **how many questions there are**,
with a rail previewing them:

![Signed in — the interviewer, and what to expect](docs/images/01-landing.png)

![Orientation — the question count and how answering works](docs/images/01b-orientation.png)

### 3. The interview — digital-human interviewer, voice mode

In voice mode the candidate is interviewed face-to-face: Azure Voice Live streams a live 1080p
digital-human avatar that **speaks each question aloud** (captured below against real Azure — the
question is spoken in the persona's language while the pinned question stays authoritative), the
candidate answers by speaking, and the conversation transcript builds on the right. A status
legend shows the live voice state (ready / listening / speaking / muted).

![Voice mode — live digital-human avatar speaking the question, transcript streaming](docs/images/09-live-avatar-voice.png)

### 3b. Text mode — same flow, no Azure needed

Every question can also be answered by text; on mock providers the avatar stage falls back to the
audio orb, so the whole flow runs with zero Azure:

![Interview page in text mode — question, orb fallback, progress rail](docs/images/02-interview-question.png)

### 4. Judged turn mode — a real-time nudge when an answer trails off

In **Judged** turn mode a backend LLM judge listens during the candidate's pauses and, if the
answer trails off mid-thought, speaks or shows one short nudge ("please go on" class) — live,
before the candidate submits, never by quoting the candidate's own words or naming a rubric item.
(v0.39.3.0, owner directive 2026-09-28: the judge is **nudge-only** — the earlier "genuine
follow-up" and "redirect" verdicts are retired, and the judge never writes an interviewer turn.
Also retired, in v0.39.2.0: the linear-mode template follow-up that quoted the candidate at
submit — a submit now always advances to the next question, in every turn mode; per-question
**Max follow-ups** is kept for compatibility but is now inert.)

> No screenshot: a nudge needs a real judge verdict, which the mock stack does not produce. The
> screenshot that used to sit here showed the **linear-mode template follow-up retired in
> v0.39.2.0** — the capture was gated on the page quoting the candidate back ("You mentioned …"),
> which can no longer happen, so it silently kept shipping a picture of a feature that no longer
> exists. The behaviour is covered end to end by `e2e/bank-judged-live.spec.ts` against real Azure.

### 5. Review before scoring — explicit submit

After the last question the candidate reviews every answer in order; scoring starts only on an
explicit **Submit & evaluate** click (with an optional SOP coverage check):

![Pre-scoring review screen listing all answers](docs/images/04-review-before-scoring.png)

### 6. The report — SOP-cited compliance scoring

The executive view leads with a classification rating (*Meets Expectations / Needs Improvement /
Does Not Meet*) on a score gauge, and shows the **SOP source (document + page) beside the
candidate's answer** — the traceability claim, on screen. A detailed per-question,
per-checklist-item breakdown is one click away, and each SOP citation links to the original
source document.

![Executive report — rating badge, score gauge, SOP source beside the answer](docs/images/05-report-executive.png)

![Report detail — per-question breakdown](docs/images/06-report-detail.png)

### 7. Admin — question banks & AI-drafted scoring rubrics

Admins author question banks and per-question checklists. Checklists are **AI-drafted from the
SOP** (required / recommended / forbidden items, each with a source quote + page), weights
normalized to 100, fully editable:

![Admin workspace — banks, questions, and the scoring rubric editor](docs/images/07-admin-rubric-editor.png)

### 8. Admin — Foundry agent persona editor

A portal-faithful editor for the interviewer persona: model deployment, voice, greeting, the full
Azure avatar roster (video + photo styles), tools, per-persona knowledge, and per-engine voice
answer-submission timing (auto-submit on/off + silence window) — synced to a real
**Azure AI Foundry agent**, with an inline text/voice playground:

![Persona editor — avatar roster, model, Foundry agent sync status](docs/images/08-admin-agent-editor.png)

## Architecture

```
frontend  React 18 + TypeScript + Vite + Fluent UI v9 (own design language, not the
          factory theme) · TanStack Query · i18next (zh-CN / en-US)
backend   Python 3.11 + FastAPI + SQLAlchemy 2.0 async + Alembic · JWT auth
azure     AI Foundry agents (Responses API) · Voice Live (avatar, via a backend WS proxy)
          · Foundry IQ / AI Search (RAG with strict citation gating) · Blob Storage
infra     Azure Container Apps (Sweden Central) · Bicep · GitHub Actions OIDC (keyless)
```

- **Provider abstraction** — LLM / retrieval / voice each have a `mock` and an `azure`
  implementation; local dev and the whole CI suite run entirely on mocks.
- **Voice transport** — the browser talks to `/api/voice-live/ws`; the backend proxy holds the
  Azure Voice Live SDK connection, so avatar ICE/SDP, transcripts, and audio relay over one socket.
- **Config precedence** — DB-backed `ServiceConfig` (set in `/admin`, keys encrypted) > `.env` >
  code default.
- **Candidate privacy boundary (P3)** — the candidate API never exposes rubric/checklist content;
  enforced by tests.
- **Scoring is concurrent and survives failure** (v0.42.1.0 / v0.42.2.0) — each question is graded
  against its own checklist by its own LLM call, three at a time, streamed to the browser as NDJSON
  with a heartbeat so a long grade never looks like a dead connection. Measured on the live app:
  **80 s for a nine-question report**, down from 170-190 s sequential. A question that fails is
  marked *not scored* and excluded from the score rather than given a zero — nobody judged that
  answer — and the rest of the report still renders.

## Quickstart (zero Azure, mock providers)

**Backend** (Python 3.11+):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload            # http://localhost:8000
```

**Frontend** (Node 20+):

```bash
cd frontend
npm install
npm run dev                              # http://localhost:5173 (proxies /api → :8000)
```

Open `http://localhost:5173/interview` for the candidate flow. Admin surfaces are at `/admin`
(banks + rubrics + Azure config) and `/admin/agent` (persona editor); seed an admin user via
`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` env vars on backend boot.

For a **real Azure** run, copy `backend/.env.example` → `backend/.env` and fill in the Foundry /
Voice Live / Search values (or configure them in the `/admin` UI). The model must be a deployment
that exists on your resource.

## Testing

```bash
cd backend && pytest                     # 723 tests, 85% coverage gate
cd frontend && npm test                  # 623 vitest unit/component tests
cd frontend && npm run e2e               # Playwright E2E — boots both servers, real Chromium, zero Azure
```

CI gates every commit on ruff (check + format), pytest, tsc, eslint, vitest, and the Playwright
E2E suite. Live-Azure validation happens through opt-in specs (e.g. `LIVE_VOICE=1`) that self-skip
in CI.

The README screenshots regenerate with:

```bash
# Mock-stack scenarios (zero Azure; boots its own servers).
# Kill any stale stack FIRST: playwright reuses an already-running server, and that process serves
# the code it booted with — a four-hour-old backend once produced a screenshot of a bug fixed
# hours earlier.
pkill -f "uvicorn app.main:app.*8100"; pkill -f "vite.*5273"
cd frontend && SCREENSHOTS=1 npx playwright test e2e/readme-screenshots.spec.ts

# Live avatar shot (real dev servers on :5173/:8000 with real Foundry credentials)
cd frontend && LIVE_VOICE=1 SCREENSHOTS=1 npx playwright test readme-live-screenshots --config=e2e/live.config.ts
```

## Deployment

CI/CD deploys to **Azure Container Apps** via GitHub Actions with OIDC federated identity — no
stored cloud credentials, managed identity everywhere, keyless. See
[`infra/azure/README.md`](infra/azure/README.md) for one-time setup and
[`docs/planning/spec-azure-cicd-deploy.md`](docs/planning/spec-azure-cicd-deploy.md) for the design.

## Documentation

| Doc | What it covers |
|---|---|
| [`SPEC.md`](SPEC.md) | The authoritative living technical spec (9 features, quality bar, privacy rules) |
| [`docs/IMPLEMENTATION-STATUS.md`](docs/IMPLEMENTATION-STATUS.md) | Feature-by-feature status, shipped versions, live-Azure validation state |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | How to verify the requirements and run the system |
| [`docs/planning/`](docs/planning/) | Spec lineage: design docs, plans, and reviews |
| [`docs/avatar-weaknet-probe.md`](docs/avatar-weaknet-probe.md) | Weak-network digital-human media adaptation: measurement method, findings, and the shipped auto-downgrade implementation |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-release detail |
