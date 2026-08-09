# AI Interview Web App — Design Doc (Office Hours)

**Date:** 2026-08-07
**Mode:** Intrapreneurship / client sales PoC
**Author:** huqianghui (via gstack /office-hours)
**Status:** APPROVED (brainstorm complete, ready for /spec)

---

## 1. What this is

A web app that runs SOP-based interviews with an AI digital-human interviewer.
Built as a **sales PoC for a client**: if the demo lands, the client 立项 (greenlights)
it as their main hiring tool. The deliverable that matters is "client greenlights",
not the software itself — but per the owner's decision, it is **built to production /
立项 standard**, no demo-only shortcuts, so the code becomes the project foundation
if greenlit.

**Four capabilities the client contracted to see:** AI, digital human, RAG, memory.

**Winning demo (one shot, end to end):** digital-human interviewer asks a question →
candidate answers by voice → interviewer asks a follow-up that cites an earlier answer
(memory) → on-the-spot report with SOP citations (RAG + scoring).

## 2. Who decides, and on what

Deciders in the room: **business leader / budget holder** + **IT lead**. No SOP expert
scoring line-by-line at the demo. Consequence: the "≥80% expert agreement" target is a
post-立项 engineering goal, not a demo acceptance bar.

## 3. Diagnostic findings (the six forcing questions)

- **Demand:** client is real, has budget authority, will greenlight on a good demo.
- **Status quo / pain:** (1) SOP-expert interviewers are time-scarce, (2) scoring is
  inconsistent across interviewers, (3) candidate volume exceeds screening capacity.
- **Memory:** = Foundry prompt agent's built-in session memory. Zero new dev. The demo
  script MUST include an explicit moment where it shows (follow-up cites an earlier answer),
  or the client won't see it.
- **Differentiation (vs HireVue/Vervoe/Spark Hire):** NOT single-axis. The moat is the
  **integrated closed loop + private control**. Off-the-shelf products do generic
  behavioral/skills assessment as hosted SaaS; none run in the client's own Azure scoring
  against the client's own SOP end to end. Landscape search confirmed: no incumbent does
  SOP-traceable compliance scoring; LLM-judge consistency is an industry-wide hard problem.

## 4. Demo pitch (differentiation narrative)

**Elevator line:**
> Off-the-shelf AI interview products are hosted SaaS that make candidates record videos
> and take generic assessments. We built a closed loop that **runs in your own Azure**:
> upload your SOP, AI auto-generates the question bank and scoring rubric, a **real
> digital-human interviewer converses with candidates in Chinese** and follows up, and a
> report is produced on the spot — data never leaves the enterprise boundary.

**Ordering rationale:**
1. **Private deployment / compliance leads** — IT's decisive vote; structurally impossible
   for hosted SaaS. Closes "why not buy off-the-shelf" up front.
2. **End-to-end closed loop is the spine** — the value the business leader hears; the only
   axis that ties the others together. Incumbents cover only one segment.
3. **Digital human + Chinese are highlights inside the loop** — shown on screen, not claimed.
4. **Cost/scale + customizable interviewer are Q&A ammo**, NOT in the opener (incumbents can
   catch up on these; leading with cost reads as insecure).

Moat axes (incumbents can't replicate): private deployment, end-to-end closed loop.
Catch-up axes (incumbents have or approach): digital human, Chinese, cost, customization.

## 5. Premises (agreed)

- **P1 — Quality over person-days.** PoC built to 立项/production standard. No demo-only
  shortcuts. Person-day estimates are NOT the driver. (Scope is still bounded — "highest
  standard" means the things we build are built solid, not that we build everything.)
- **P2 — Deciders are business + IT**, no line-by-line SOP expert at demo → ≥80% agreement
  is post-立项, not a demo bar.
- **P3 — Organize by FEATURE, not Phase 1/2.** The old phased plan is superseded.
- **P4 — memory = Foundry agent built-in session memory**, demo shows it explicitly. ✓
- **P5 — Differentiation = integrated closed loop + private control** (see §4), not a single
  feature.

## 6. Architecture decisions (from prior discussion)

- **Greenfield repo** (not a fork). Reference the **Avatar-platform layer** of
  github.com/huqianghui/AI-avatar-vibe-coding (NOT the older AI-Coach layer). Port infra
  patterns; rewrite domain logic; carry over zero pharma/HCP domain concepts.
- **Digital human = Foundry prompt agent + inline voice mode config** (voice/language/avatar
  on an interviewer-persona model, synced to the agent via microsoft.voice-live.* metadata).
  No VoiceLiveInstance concept. **WebRTC is the primary voice path** (avatar works over WebRTC
  in the reference Avatar layer), WebSocket as fallback.
- **Turn-by-turn interview state machine: built from scratch, channel-agnostic** (text + voice
  share progression logic; channel is only transport). **Follow-up-question hooks reserved**
  (per-question 0..N follow-up turns; Answer modeled as a group of turns so follow-up content
  is scorable without schema change).
- **RAG/traceability:** SOP chunked + vectorized into Azure AI Search / Foundry IQ; retrieve
  returns {title, url, page} citations; strict citation gating (missing field → drop; zero
  citations → templated refusal, never hallucinated). Half-day spike to confirm section-level
  traceability granularity before committing the ingestion approach.
- **Scoring engine:** reference the AI-Coach layer's scoring_engine PATTERN only (structured
  JSON output + weighted dimensions + anti-hallucination post-validation rails). Rewrite
  prompt + dimensions as Checklist 4-state judgment (required/recommended/forbidden + weight +
  SOP source quote), language-aware (SOP language, answer language, report language may differ).
- **Prompt registry:** DB-versioned + file-default (admin-editable without redeploy).
- **Auth:** anonymous candidate sessions (X-Anon-Session header, DB row authoritative, token
  in React state only) + admin JWT. **No multi-tenancy** for the PoC.
- **Languages:** zh + en + bilingual. i18n with locale-parity test.
- **CI hard gate:** every commit passes lint + typecheck + all tests + build. 100% pass.
  Tests genuinely cover core user stories (pytest + vitest + Playwright E2E).

## 7. Feature breakdown (organized by feature, not phase)

1. **Knowledge base + traceability** — SOP upload, chunk + vectorize, section-position metadata.
2. **Question bank** — Question model + admin + 10-question organization.
3. **Checklist (rubric)** — required/recommended/forbidden + weight + source text; AI-generated
   draft from SOP; business-editable UI.
4. **Scoring engine** — per-item Checklist comparison, 4-state judgment + rationale + SOP quote,
   coverage/total/grade, improvement suggestions + forbidden-item warnings, structured JSON API.
5. **Interviewer digital human** — Foundry prompt agent + voice mode (inline voice/language/avatar).
6. **Turn-by-turn interview state machine** — channel-agnostic, follow-up hooks, end-of-answer
   detection (voice: silence timeout + verbal cue + LLM judgment).
7. **Session memory surfacing** — Foundry agent built-in memory + explicit demo citation moment.
8. **Interview report** — total/per-question score + coverage + missing knowledge points +
   forbidden-item summary + export.
9. **Frontend interview page** — reuse Avatar-layer patterns (voice components, sources-panel,
   question progress indicator).

Dependencies: scoring engine (4) depends on Checklist (3) + knowledge base (1); state machine (6)
depends on question bank (2) + digital human (5). To be sequenced in /spec.

## 8. Chosen approach

**APPROACH A — Skeleton-first + end-to-end thin slice (CHOSEN).**
Stand up the repo scaffold (FastAPI + React + Fluent UI v9 + CI + auth) and one minimal
digital-human turn-by-turn Q&A slice (one hardcoded question, stub scoring), then fill in
each feature to production standard.
- Effort: M-L | Risk: Low
- **Why chosen:** exposes the two biggest technical risks (Foundry-agent voice path + vectorization
  traceability) in week one; always keeps a runnable demo to show the client; the winning-demo
  spine (digital-human interview) is proven earliest.
- Reuses: Avatar-layer WebRTC hook, voice components, agent_sync/agent_chat patterns, storage
  abstraction, prompt registry, auth.

**APPROACH B — Knowledge base + scoring first (bottom-up).** Solidify KB/Checklist/scoring/
question-bank behind a text UI, digital human last. Rejected: defers the biggest demo risk
(voice digital human) to the end.

**APPROACH C — Digital human first (demo-spine first).** Get Foundry agent + voice + state
machine running with stub scoring, backfill KB/scoring. Rejected: digital-human value is
incomplete without scoring + KB, so standalone-stage value is thin — though A captures most
of C's risk-first benefit while keeping the scaffold clean.

## 9. The assignment (next real-world actions)

**Blocking pre-work the owner should secure from the client before/early in build:**
1. SOP document(s) in final form — needed for KB + Checklist generation.
2. The 10 interview questions.
3. Judging criteria / Checklist source — and ideally 2-3 "model answer + expert score" samples
   (including a cross-language case) to calibrate scoring later.
4. Confirm the demo Azure environment (AI Search index quota, Foundry IQ access, Voice Live region).

**Immediate next step (tooling):** run gstack `/spec` to turn this doc into an executable,
dependency-ordered spec, then `/autoplan` (CEO + eng + design + DX plan reviews).

## 10. Open items

- End-of-answer detection UX tier for voice (silence timeout vs verbal cue vs LLM judgment) —
  decide during state-machine spec.
- Which of the 9 features are demo-must vs post-立项 — owner to bound during /spec (all are
  in scope by default under "quality over person-days", but the demo slice should be named).
- Foundry IQ retrieve API is preview (2026-05-01-preview) — confirm stability during the
  traceability spike.
