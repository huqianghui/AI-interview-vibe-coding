# Spec — External MCP interviewer integration (analysis + client-confirmation gate)

**Status:** Analysis. First client answers received 2026-08-25 (see §9) — scope collapses to a
**per-question, stateless** model; **one hard contradiction remains open** (§9.2) before build.
**Date:** 2026-08-25 (updated 2026-08-25 with first client round)
**Author:** analysis pass over a client-provided MCP result sample.
**Related:** [`../../SPEC.md`](../../SPEC.md) F4/F6/F7/F8, [`spec-mece-classification-scoring.md`](spec-mece-classification-scoring.md),
[`spec-voice-live-agent-contract.md`](spec-voice-live-agent-contract.md),
[`spec-voice-transcript-race-explicit-submit.md`](spec-voice-transcript-race-explicit-submit.md).

> **Purpose.** The client wants their MCP server wired into our interviewer agent, so that we
> **call the MCP server** and drive the candidate interaction (spoken + on-screen) from what it
> returns. This document captures (a) what the sample data actually is, (b) the problems in the
> data, (c) the architecture-level risks of integrating, and (d) the exact questions we must get
> the client to answer **before** any implementation. Do not implement from this doc — it is the
> pre-implementation analysis to bring back to the client.

---

## 1. What the client gave us

A single MCP tool-result sample (one turn, event = `main_question`):

```json
{
  "final_session_state_json": "{...string-encoded full session state, incl. per-dimension scores...}",
  "public_response_json": "{...string-encoded candidate-safe view: speech_text, display_text...}",
  "speech_word_count": 38
}
```

- **`final_session_state_json`** (string-encoded JSON): the *full* server-side session state —
  `schema_version:"1.0"`, `mode:"mock"`, `order[]` (9 question ids), `index`, `current_question_id`,
  `followup_count`, `covered_questions[]`, and `results[]` where each result carries the **six
  dimension scores** (`accuracy / completeness / role_boundary / evidence_traceability /
  risk_escalation / clarity`), `raw_overall`, `overall`, `level`, `critical_flags[]`,
  `feedback_summary`, `improvement_advice`, and `citations[]` (SOP **file names**).
- **`public_response_json`** (string-encoded JSON): the candidate-safe view — `event`,
  `speech_text` (what the avatar should say), `display_text` (what to show on screen), and a
  trimmed `session_state` (progress only, no scores). In the sample `analysis/scores/radar/
  critical_flags/citations` are all empty (correct for a `main_question` turn).
- **`speech_word_count`**: 38 (a length hint for the TTS/avatar layer).

### 1.1 This is the same interview as our repo's rf-CSM bank

The sample's `RFCMS-Q0x` ids, the six-dimension rubric, and `RFCMS-CONFLICT-001` map **1:1** to
this repo's `EU_avatar_inspector_interview/GCO_Inspection_Training_Bank_rf_CSM.md` and our shipped
**F4 MECE six-dimension scoring** (`backend/scripts/import_rfcsm_bank.py` `DIMENSIONS`). The client's
MCP server is a **parallel implementation of the same interview spec** we already ship — not a new
capability, but a second brain for the same job. This single fact drives every architecture risk
below.

---

## 2. Field-level correspondence to our shipped engine

| MCP `final_session_state_json` field | Our equivalent |
|---|---|
| `order[]`, `index`, `current_question_id` | `state_machine.py` question ordering + `current_question_index` (`models/interview.py`) |
| `followup_count` | `state_machine._follow_ups_asked` |
| `covered_questions[]` | answered-question derivation in `state_machine.py` |
| `results[].dimensions{six}` | F4 six MECE dims (`import_rfcsm_bank.py:66-103`) — **names differ, see §3.8** |
| `results[].raw_overall / overall` | `scoring_engine._weighted_score()` |
| `results[].level` | `scoring_engine.outcome_for_score()` (`:219`) — **casing differs, see §3.8** |
| `results[].critical_flags[]` | F4 critical-error cap (`scoring_engine.cap_outcome()` `:233`) |
| `results[].citations[]` (file names) | `ChecklistItem.source_document_id` → clickable `ReportView.tsx:SopSourceLink` — **model mismatch, see §3.7** |
| `RFCMS-CONFLICT-001` (bank header) | F4 **advisory** pending-conflict exemption (`ChecklistItem.advisory`) |

**Conclusion:** the MCP server owns exactly the responsibilities our `state_machine.py` +
`scoring_engine.py` own. Two turn-by-turn engines cannot both drive the same interview.

---

## 3. Problems in the data

### 3.1 Double JSON-string encoding
Both payloads are **string-encoded JSON**, so every turn needs a second `JSON.parse` / defensive
deserialize. Any format drift breaks the parse. Mitigated somewhat by `schema_version:"1.0"` —
we should validate against it and fail loudly on mismatch.

### 3.2 speech vs display use different question identity
- `speech_text` → **"Question 7 of 9: …"** (ordinal, candidate-friendly).
- `display_text` → **"RFCMS-Q03 — …"** (internal bank id).

Two problems: (a) the same question is announced two different ways (spoken "#7", shown "Q03") —
jarring; (b) **`RFCMS-Q03` is an internal id and must not appear on the candidate's screen** — it
is a demo-quality regression and an information leak. Any integration must scrub `display_text` to
an ordinal ("Question 7 / 9") before it reaches `Transcript.tsx`.

### 3.3 `results` count ≠ covered-question count
Sample: `covered_questions` = 6 (Q05, Q08, Q02, Q06, Q07, Q09) but `results` = **1** (only Q05).
So either the server scores lazily / returns only the latest, or the sample is truncated. **If our
F8 report reads `results` directly it will be missing 5 questions' scores.** Must confirm whether
results accumulate across turns or require a dedicated "get report" call. (§7 Q4.)

### 3.4 speech_text carries a role-setup preamble
`"I will act as the inspector. Answer as you would during a real inspection, using only facts you
can support. Question 7 of 9: …"`. Need to confirm whether this preamble appears **only on the
first question** or is **prepended every turn** (if every turn, the avatar re-reads the intro each
question). (§7 Q5.)

### 3.5 No answer-submission contract (largest gap)
The sample only shows **system → candidate** (question emission). It does **not** show:
- the tool input schema to **submit a candidate answer** (params? `answer` text? `question_id`?),
- how the server is invoked at all from our side.

Without this half of the contract, integration cannot be built. (§7 Q1.)

### 3.6 No session identifier → stateful vs stateless is unknown
`final_session_state_json` contains **no `session_id` / `thread_id`**. So we don't know whether the
MCP server is **stateful** (keeps state server-side under some key) or **stateless** (we must pass
the full prior state back every turn). This determines whether we must persist
`final_session_state_json` in `models/interview.py` and echo it each turn. (§7 Q2.)

### 3.7 citations are file names, not document ids — breaks clickable citations
MCP citations look like `"EMEA GCO - Regional CST Governance Handbook_v1.0_17Jul2025.pdf"`. Our
shipped **clickable SOP citation** feature (v0.31.1.0) resolves `source_document_id` through two
IDOR guards (`state_machine.cited_document_ids` `:429` + the `GET /{id}/sop/{document_id}`
endpoint). **The models are incompatible.** To keep citations clickable we must (a) ingest the
`Data_Sources_AI_Inspector/` files via `sop_ingestion.py`, and (b) build a **file-name → SopDocument.id**
map. Otherwise citations can only be shown as plain text (or would 404 on click).

### 3.8 `level` labels are close but not identical
MCP: `raw_overall:65 → level:"Needs improvement"`. Our F4: `Meets Expectations (≥70) / Needs
Improvement (40–69) / Does Not Meet (<40)`. **Thresholds agree** (65 → 40–69) but **casing/spelling
differ** (`"Needs improvement"` vs `"Needs Improvement"`), and MCP is English-only while our UI is
bilingual (zh-CN + en-US). Needs a display-mapping layer. Same for the six dimension keys, which
differ in name (MCP `role_boundary/evidence_traceability/risk_escalation` vs our
`role/evidence/risk`).

### 3.9 Only one event type observed
Only `event:"main_question"` is present. There must also be `follow_up`, a post-scoring event,
`session_complete`, and `error`. **No samples for these = integration blind spots.** (§7 Q3.)

---

## 4. Integration architecture: two paths, and why the easy one is a trap

Our backend **already supports MCP**, in two different ways. For *this* server they give opposite
outcomes.

### Path 1 — attach the MCP as a Foundry-agent tool (existing mechanism)
Add `type:"mcp"` to `persona.tools_config` → `gate_supported_tools()` (`persona_tools.py:60`) →
`_to_mcp_tool()` (`azure_agent_sync.py:250`) syncs it into the Foundry agent.

**Why this is wrong here.** The tool would be invoked **inside the Azure Foundry agent runtime, at
the agent's own discretion** — not in our backend process. That is fine for a *retrieval* tool
(our current `knowledge_base_retrieve`). But this server is **the whole interview brain** (it emits
questions, spoken text, and scores). Attaching it as an agent tool means **the Foundry agent decides
when to ask questions and what to say**, which directly collides with everything we shipped in
v0.30–v0.31.2.0:
- `useInterviewVoice.ts:658 speakQuestion()` cancel-then-speak assumes a **backend-authoritative
  question**;
- `feat/voice-followup-convergence` (v0.31.2.0) just **constrained the agent to NOT invent
  questions** — attaching this MCP hands question authority back to the agent;
- `persona_tools.py:68` only supports **unauthenticated public `http(s)` MCP servers**
  (`project_connection_id` is intentionally dropped) — if the client server needs auth or lives
  inside a private boundary, this path is impossible anyway.

### Path 2 — our backend is the MCP client; the MCP server is the brain (viable path)
Our backend calls the MCP server itself and **replaces / wraps** `state_machine.py` for this
persona: on each candidate answer we call the server, take back `public_response_json`, feed
`speech_text` into the existing `speakQuestion()` path, render scrubbed `display_text`, and map the
final `results` into our F8 report DTO. `final_session_state_json` never leaves the backend.

**This is the only path that fits this server.** It is a "who owns the brain" decision, not a
"add a tool" task.

### The core decision
**For this interview, either the MCP server is the brain (our `state_machine.py` demotes to a
transport/adapter) or we keep our own `state_machine.py` (and this MCP is not needed).** The two
turn-by-turn engines cannot run simultaneously.

---

## 5. Risk register (mapped to files)

| # | Risk | Where it bites | Severity |
|---|---|---|---|
| R1 | **Two brains / source-of-truth conflict** | `state_machine.py` (`answer_finalized:115`, `get_current_question:324`, `score_and_finalize:205`) vs MCP `order/index/results` | **Critical** — decide §4 first |
| R2 | **Voice authority conflict** | `useInterviewVoice.ts:658`, `voice_live_proxy.py`, `feat/voice-followup-convergence` persona contract | **High** — must route MCP `speech_text` through `speakQuestion`, agent must not self-author |
| R3 | **Privacy moat / data egress** | If MCP endpoint is outside the client Azure boundary, candidate answers leave the boundary → undermines the SOP-private-loop pitch + SPEC P3/P12 | **Critical** — confirm deployment (§7 Q6) |
| R4 | **Rubric-leak boundary** | `final_session_state_json` = full internal scoring = exactly what P3 "no rubric leak" must block; only `public_response_json` may reach `InterviewPage.tsx` | **High** — enforce backend-side split |
| R5 | **Session isolation + latency** | multi-candidate concurrency needs session keying (R depends on §3.6); each turn = MCP round-trip (+ possible server-side LLM) → seconds/turn vs "on-the-spot" UX | **Medium** — mask/stream |
| R6 | **Citation model mismatch** | §3.7 — `ReportView.tsx:SopSourceLink`, `cited_document_ids:429` | **Medium** — ingest + name→id map |
| R7 | **display_text id leak** | §3.2 — `Transcript.tsx` | **Medium** — scrub to ordinal |
| R8 | **Report completeness** | §3.3 — F8 report vs `results[]` | **Medium** — confirm accumulation |

---

## 6. What we can build offline (no client dependency, no risk to shipped code)

A **parse + map adapter prototype**, standalone, that does NOT touch `state_machine.py`:
1. defensive double-JSON parse + `schema_version` validation;
2. **public/private split** (drop `final_session_state_json` server-side; only `public_response_json`
   crosses to the client) — R4;
3. `display_text` scrub to ordinal — R7;
4. `level` + six-dimension + `citations` mapping into our F8 report DTO shape — R6/R8;
5. golden-file test against this exact sample.

This validates feasibility and sharpens the remaining questions without committing to Path 2.

---

## 7. Questions the client MUST answer before implementation

**Blocking (cannot build without these):**
1. **Answer-submission tool contract** — the MCP tool name + input schema to submit a candidate's
   answer (what params: session key? `answer` text? `question_id`? locale?). (§3.5)
2. **Stateful or stateless?** — is there a session/thread id we pass back, or must we return the
   full `final_session_state_json` each turn? Where is state keyed? (§3.6)
3. **Full event enumeration + a sample of each** — at minimum `follow_up`, the post-answer scoring
   event, `session_complete`, and `error`. (§3.9)

**Architecture-deciding:**
4. **Do `results[]` accumulate** across turns, or is there a dedicated "final report" call? Why does
   the sample show 6 covered but 1 result? (§3.3)
5. **Is the "I will act as the inspector…" preamble** first-question-only or every turn? (§3.4)
6. **Where is the MCP server deployed** — inside the client's Azure boundary, or an external
   endpoint? Auth model (public/unauthenticated vs token/managed identity)? (R3 — also decides
   whether Path 1 is even technically possible.)

**Confirmations (lower risk, still needed):**
7. Is `mode:"mock"` a test fixture, and what does the **real** (non-mock) shape look like?
8. Are the citation **file names stable identifiers** we can map to ingested `SopDocument`s, or do
   they change per version? (R6)
9. Language: is the server English-only, or can it emit zh-CN? (affects §3.8 mapping + our locale
   parity.)
10. Who owns the **question bank + rubric** going forward — the MCP server, or our DB
    (`import_rfcsm_bank.py`)? If the server, our F2/F3/F4 admin surfaces become read-only for this
    persona.

---

## 8. Recommendation

- **Do not** attach this server as a Foundry-agent tool (Path 1). It is a brain, not a retrieval
  tool, and would fight the shipped voice/follow-up authority model.
- **Do** treat this as a "who owns the brain" decision (§4). If we integrate, it is Path 2
  (backend-as-MCP-client, MCP-as-brain), gated on §7 Q1/Q2/Q3.
- **In parallel:** client answers §7 while we build the offline adapter prototype (§6) to de-risk
  the mapping. No changes to `state_machine.py` until §4 is decided and §7 blockers are closed.

---

## 9. First client round (2026-08-25) — answers, what collapses, and the one open contradiction

The client answered §7. Their mental model is **per-question, stateless, single-topic**: each turn
is one question; the candidate converses with the digital human about *only that question*; that
turn's conversation is scored against the rubric; everything else in the MCP state is ignored.

### 9.1 Answers (verbatim intent) and effect on scope

| §7 | Client answer | Effect |
|---|---|---|
| Q1 answer-submission | "No submission endpoint — just interview the current question, then evaluate the content with rubric + LLM." | See **§9.2 — this contradicts the sample.** |
| Q2 stateful/stateless | "Treat as stateless. Candidate converses with the avatar about the current question only; the current conversation is the thing evaluated." | **R1 (two brains) largely dissolves** — MCP is no longer a turn-by-turn engine; **our `state_machine.py` keeps driving** question-to-question. |
| Q3 event enumeration | "Why do I need the others? Q1+Q2 already cover it." | **Withdrawn.** Correct under a per-question model — `follow_up`/`session_complete`/`error` orchestration was only needed if MCP were the brain. |
| Q4 results accumulate | "Score the current question only; ignore the other results." | We use **only the current question's** score; `order/index/other results[]` ignored. Simplifies R8. |
| Q5 preamble frequency | "Every question — the candidate only ever has one question at a time." | **Confirmed.** Makes §3.2 **worse**, not better: the `RFCMS-Q0x` id in `display_text` leaks on *every* screen, so scrubbing to an ordinal is mandatory (R7). |
| Q6 deployment/auth | "Client's own data center, reached over the public internet. Today is about discussing the integration." | See **§9.3** — public endpoint needs auth; candidate answers transit the public internet to the client DC. |
| Q7 mock vs real | "Same." | ✅ mock shape == real shape. |
| Q8 filename→doc map | "Yes." | ✅ clickable citations feasible (ingest `Data_Sources_AI_Inspector/` + name→`SopDocument.id` map, R6). |
| Q9 language | "English only is fine for now." | ✅ drop the zh-CN mapping requirement for MCP output; our UI chrome stays bilingual. |
| Q10 bank/rubric owner | "Admin can maintain it." | Admin (our F2/F3/F4) owns the bank/rubric — but see **§9.4** (whose 9-question `order[]`?). |

### 9.2 THE open contradiction — who scored Q05? (must resolve before build)

**Q1 says "there is no answer-submission endpoint." But the sample's
`final_session_state_json.results[0]` already contains Q05's six-dimension scores.** Something had
to *see Q05's answer* to produce those numbers. Both cannot be true. The real flow must be one of:

- **Flow B — we score locally.** MCP is a **question source only**. Candidate answers by voice →
  scored by **our shipped F4 engine** + rubric → F8 report. MCP `results[]` are **discarded**.
  *Simplest; maximal reuse.* Open sub-question: if MCP only supplies question text, what is its
  value-add beyond an authoritative bank + preamble wording + rubric-of-record?
- **Flow A — MCP scores.** We send the current question's **answer / conversation text** to MCP;
  it returns the six dims + citations; we map into F8. Then "no submission endpoint" merely means
  "not a *separate* endpoint — it's the same tool call," and **we still need that tool's input
  schema + one answer-carrying example.** The sample's pre-computed Q05 score is direct evidence
  this input channel exists.

**This is the single blocking decision now.** Not the original 10 questions — just: **who computes
the score, us (Flow B) or MCP (Flow A)?** Everything else can proceed once this is fixed.

### 9.3 Public endpoint → auth + egress framing (raise today)

Q6 = "client data center, public internet." A publicly reachable, **unauthenticated** scoring/rubric
endpoint means anyone could submit answers and pull rubric-graded output → **rubric leak** (SPEC
P3). Minimum bar: a token / authenticated access. Also make explicit to the client: candidate
answers will **transit the public internet to the client DC** — usually acceptable since it is the
client's own DC, but the "data never leaves the boundary" wording must be adjusted accordingly (R3).

### 9.4 Residual open items (not blocking, but decide)

- **Who owns the 9-question `order[]`?** Q10 (admin maintains the bank) + Q4 (ignore MCP's other
  results) imply **order is ours** (F2). But the sample's `order[]` is MCP-managed. Confirm: our
  bank drives sequencing and MCP just serves a question by id, or MCP owns a parallel RFCMS bank
  (→ **two banks to reconcile**).
- Under Flow B, restate MCP's role in one sentence for the SOW so "integration" isn't oversold.

### 9.5 Revised recommendation

- Architecture is now **MCP-as-question-source, our engine drives turns** (a much lighter variant of
  Path 2). R1 downgraded from Critical to Low.
- **Blockers remaining:** exactly one — §9.2 (Flow A vs Flow B). If Flow A, also get the tool input
  schema + one answer-carrying sample.
- The offline adapter prototype (§6) is still worth building: parse + public/private split +
  `display_text` scrub + citation-name→id map are needed in **both** flows.

---

## 10. Round 2 — remaining questions for the client (client-ready)

> Round 1 closed most of the original §7. Below are the items newly exposed / still open on top of
> those answers, in priority order. **Item 1 is the only build blocker.**

### Blocking (cannot start integration dev)

1. **Who computes the current question's score?** — *STATUS: client confirming this afternoon (2026-08-25).*
   You said "there is no answer-submission endpoint," yet your sample already carries Q05's
   six-dimension score in `results`. Producing that score required something to read Q05's answer.
   Both can't hold — please confirm which is true:
   - **Flow A — MCP scores.** We send the candidate's current-question answer/conversation to MCP;
     MCP returns the six dims + citations. → If so, provide the **input schema for the "submit
     answer" call + one full answer-carrying example (input + output).**
   - **Flow B — we score locally.** MCP only serves the question (text + preamble); scoring is done
     entirely by our system (rubric + LLM); we ignore MCP's returned scores. → If so, confirm what
     MCP's role is beyond "supplying question text, preamble, and the rubric of record," so we can
     scope "integration" accurately.

### Needs a decision (not blocking)

2. **Auth on the public endpoint.** The MCP lives in your data center, reached over the public
   internet. If that endpoint is **unauthenticated**, anyone could submit answers and pull
   rubric-graded output — i.e., the rubric leaks. Confirm whether it requires a **token / other
   auth**, and how credentials are provided to us. (Also flagging: candidate answers transit the
   public internet to your DC — fine since it's your own DC, we just need the "data boundary"
   wording to match reality.)

### Closed (no need to re-ask; recorded)

Round 1: current-question-only scoring ✅ · preamble every question ✅ · mock == real ✅ · citation
filename→file mapping ✅ · English-only for now ✅ · admin maintains bank/rubric ✅ · stateless,
current-question interaction ✅

Round 2: **Question order & id — don't matter** ✅ (client: "the interview is about the question
*content*, order/numbering is irrelevant"). **Consequence:** we drive sequencing from *our* bank's
order + our own ordinals, and simply **drop / scrub the internal `RFCMS-Q0x` id out of
`display_text`** — this closes **R7** cleanly (no longer a tension, it's the intended behavior).

---

## 11. Afternoon call checklist (2026-08-25 — read straight through)

> Order matters: **ask "where do results live" (Shape 1 vs Shape 2) first, then "who scores".**
> The first decides whether we build anything at all and how much; the second only matters under
> Shape 2. Don't lead with the schema — in many cases it isn't needed.

### Step 0 (decided internally — do not ask client)

- ☑ **No new repo.** Both modes live in the same repo behind a source seam
  (`BankInterviewSource` / `McpInterviewSource`), reusing the whole voice + avatar + report + auth +
  admin + i18n platform.
- ☑ Order/id don't matter — use our own order + ordinals, scrub `RFCMS-Q0x`.
- ☑ **The MCP config UI already exists — nothing to build.** The existing `tools_config` +
  `ToolPicker` already lets us attach an MCP tool (`server_url`/`server_label`) to a persona — no
  extra "data source" dropdown needed. **But "attach MCP in the agent's tools" ≠ "results come back
  to our UI":** an agent-tool runs inside the Azure agent runtime, invoked at the model's discretion,
  and its return lands in the **agent's context** — it can *speak* `speech_text`, but `display_text`
  and scores **never reach our backend** (they're trapped in agent context, and
  `final_session_state_json` risks the agent reading it aloud to the candidate). So "just attach the
  tool" only holds under **Shape 1** (see Step 1).

### Step 1 (must ask — the most fundamental fork) ★★

- ☐ **Where does this interview's result / report ultimately live?**
  - **Shape 1 (we're just a shell):** questions/scores/report live in *your* MCP server
    (`final_session_state_json` *is* its own report state); you pull results from *your own* server.
    We only provide the avatar + voice conversational shell.
    → **In this case your "attach the MCP tool to the agent and confirm it's attached" IS the final
    answer — our dev effort is near zero.**
  - **Shape 2 (we present the result):** `display_text` / scores / citations must render in *our*
    interview UI and F8 report.
    → Can't rely on agent-tool (see Step 0); needs **backend-as-MCP-client** plus mapping. Go to Step 2.
- ☐ **Walk the client through the effort/safety delta (§12):** "attach the MCP tool" (Shape 1) is
  ≈0 dev but only works if *they* consume results from their own server; showing results in *our*
  report, or a hard no-rubric-leak guarantee, is Shape 2 / option ② — a real medium build. The
  ①+hook middle path is a possible optimization only, gated on 12.3, and does not close the leak
  boundary.

### Step 2 (Shape 2 only — must ask — decides the fork) ★

- ☐ **Who computes the current question's score?**
  - "**MCP scores**" → **Flow A**, go to Step 3.
  - "**You score with the rubric; MCP only serves questions**" → **Flow B**, skip to Step 4.

> **On "both sides can score" (internal clarification):** the target shape is **(b) the system
> supports both scoring modes, but each interview picks one per persona — never double-scores** —
> which is exactly what the source seam buys us. **Do NOT build (a) the same interview scored by
> both sides** (two divergent scores, unexplainable to the candidate, doubled latency/cost). **(c)
> local fallback when MCP is down** is a later optimization, not v1. Note too: **"we can also score"
> only has an outlet under Shape 2** (there's a UI/report to carry the result); under Shape 1 our F4
> engine is effectively off for that persona.

### Step 3 (Flow A only) — get schema + example

- ☐ **Submit-answer input schema**, field by field:
  - ☐ Which **MCP tool (name)** to call?
  - ☐ How is "which question" identified — pass the **id**, or echo the **question text**?
  - ☐ How is the answer passed — **plain text** or **full conversation**?
  - ☐ Stateless: must we **echo back the prior `final_session_state_json`** verbatim? (★ critical —
    decides whether we persist that state in the DB and replay it each turn.)
  - ☐ Any **locale / language** param?
- ☐ **One full "submit answer → get score" example** (input + output). (We only have the
  question-emission example; the scoring call is missing.)
- ☐ **One sample each of `error` and `session_complete`** (we own orchestration but must know what
  MCP failure looks like, for defensive handling).
- ☐ Confirm whether **MCP itself also returns follow-ups** — if so, reconcile with our voice
  follow-up so they don't fight.

### Step 4 (Shape 2 — both flows, settle in the same call)

- ☐ **Auth on the public endpoint**: token / other auth required? How are credentials provided?
- ☐ State it plainly: candidate answers **transit the public internet to your DC** — fine since
  it's your own DC, we just align the "data boundary" wording with reality.

### After the call (our side)

- ☐ Backfill the shape (1/2), chosen flow (A/B) + schema into §9 / §12.
- ☐ If Shape 2: regardless of A/B, start the **offline adapter prototype** (§6): parse +
  public/private split + `display_text` scrub + citation filename→id map (needed in both flows).
- ☐ If Shape 1: just attach the MCP tool to the target persona in the existing `ToolPicker` and run
  one connectivity check — near-zero dev.

---

## 12. The three link options, their prerequisites, and the effort delta (record for the client discussion)

The Shape-1 / Shape-2 fork in §11 collapses in practice into **three** concrete link options, not
two. The middle one (**hook**) is the subtle one — it's what makes "attach the tool" *sound* like it
could still feed our UI. This section records the distinction, the prerequisite that decides whether
each is even possible, the security-boundary difference, and the effort — **explicitly so it can be
walked through with the client** (they need to understand that "just attach the MCP tool" and "we
display the results in our report" are different asks with very different cost and safety profiles).

### 12.1 Where the "hook" idea comes from

Our backend is **already** in the loop as a relay: every Azure event flows through
`voice_live_proxy._forward_azure_to_client:256` before we forward it to the browser. So a hook point
**physically exists** — we could intercept an event, extract fields, split public/private, and
re-emit a custom frame *before* forwarding. The hook point is not the question. **The question is
what actually flows on that stream.**

### 12.2 The three options

| | **① Attach as Foundry tool** | **①+hook — intercept tool-result in the relay** | **② Backend is the MCP client** |
|---|---|---|---|
| Who invokes the MCP | Cloud LLM, at its own discretion | Cloud LLM (same as ①) | **Our backend code**, in a controlled sequence |
| Do we get the structured JSON? | No — return goes only into the model's context | **Only if** Azure Voice Live emits the tool call/return as an event on the proxied WS (**must be verified — see 12.3**) | **Yes — fully**, in-process |
| "Which fields to read / not read" enforced by | persona **prompt** in natural language (soft, prompt-injection-bypassable) | Our code at the hook (hard) **for the display copy** — but see boundary row | **Our code** (hard split) |
| `final_session_state_json` (rubric/scores) exposure | Enters the **cloud model's context** → model can be talked into reading rubric aloud (P3 risk) | **Still enters the cloud model's context** (the tool result is fed to the model) → same P3 risk; the hook only stops the *browser-forward* path, not the *spoken* path | **Never enters any LLM**; dropped in the backend, never crosses to the browser |
| Structured display in our F8 report | Basically not possible | Possible **for the intercepted copy** (render a custom frame) | **Yes** — native mapping into the report DTO |
| Timing control (display vs speech alignment) | None (model-driven) | Weak (model decides when it calls the tool) | **Full** (we call in order) |
| Effort | **≈ 0** — attach in `ToolPicker`, one connectivity check | **Low–medium** — one interceptor branch in `_forward_azure_to_client` + a public/private split + a custom frame + a small frontend renderer; **gated on 12.3 being true** | **Medium** — an `McpInterviewSource` (client + parse + hard split + `display_text` scrub + citation filename→id map + report DTO mapping) behind the source seam; the offline adapter prototype (§6) is the de-risking first slice |

### 12.3 The prerequisite that decides ① + hook

**Does Azure Voice Live push the agent's MCP tool call/return as an event onto the proxied WS
stream?** Today the stream carries realtime events (`response.audio.delta`,
`response.audio_transcript.delta`, avatar ICE/SDP, `response.done`) — **not** the raw
`final_session_state_json`.

- If **yes** (the Realtime/Voice Live protocol surfaces `response.function_call_arguments.*` / MCP
  tool events, as the portal's tool-call trace suggests) → the ①+hook middle path is technically
  real: intercept the tool-result event, pull `final_session_state_json`, split in the backend, emit
  a custom frame for the UI.
- If **no / audio only** → the hook only ever sees spoken words, not the source JSON → display must
  go to ②.

**Action:** confirm from the `azure-ai-voicelive` SDK event enum (fast, no client needed) whether
MCP/function-call events exist on this connection. This turns "to be verified" into "known".

### 12.4 Why ② remains the answer whenever "don't leak the rubric" is a hard requirement

Even if 12.3 is true, ①+hook has two irreducible defects that ② does not:

1. **The rubric-leak boundary stays soft.** In both ① and ①+hook, `final_session_state_json` is fed
   to the **cloud model** — so the model can still be induced to speak the rubric/scores. The hook
   guards only the *forwarded-to-browser* path, never the *spoken* path. In ② the state never
   touches any LLM.
2. **The agent must choose to call, and use the return well.** Tool timing/use is model-driven and
   not under our control; display copy and speech cadence can desync. ② is a controlled sequential
   call.

**Bottom line for the client:** "attach the MCP tool" (Shape 1, ≈0 dev) is real **only if the client
consumes the results from their own server and we don't parse/display anything**. The moment they
want the interview's scores/citations shown in *our* report, or want a hard guarantee the rubric is
never leaked to the candidate, that is Shape 2 / option ② — a real (medium) build, not a config
toggle. The ①+hook middle path is a possible optimization only, and only if 12.3 holds, and it does
**not** close the rubric-leak boundary.
