# Planning trail

The planning documents behind this project, promoted from local gstack artifacts
(`~/.gstack/projects/…`) into the repo so the full trail travels with the project and is
reviewable in version control.

These are **historical planning artifacts**, captured in build order. The authoritative,
living specification is [`../../SPEC.md`](../../SPEC.md) at the repo root — start there.

## The trail (chronological, 2026-08-07)

1. **[design-office-hours.md](design-office-hours.md)** — the initial design / brainstorm doc
   (from a `/office-hours` session). Product framing, the winning-demo definition, who's in the
   room, early scoping. This is the "why" before the "what".

2. **[spec-draft-preautoplan.md](spec-draft-preautoplan.md)** — the first technical spec draft
   (from `/spec`). Features F1-F9, quality bar, tech stack, dependency graph. Ends at
   "§10 Open items for /autoplan review" — i.e. **before** the review gate.

3. **[autoplan-review.md](autoplan-review.md)** — the `/autoplan` review restore point: the
   CEO / engineering / design review findings and owner decisions that ran against the draft.

4. **[`SPEC.md`](../../SPEC.md) (repo root, authoritative)** — the finalized spec. It is the
   superset of the draft above: it folds the autoplan output into **§11 Review patches (P1-P16)**
   and **§12 Owner decisions**. When the draft and this disagree, `SPEC.md` wins.

## Spec lineage in one line

`design-office-hours` → `spec-draft-preautoplan` → (`/autoplan` review) → **`SPEC.md`** (committed, authoritative).

## Post-spec feature specs

- [`spec-real-azure-integration.md`](spec-real-azure-integration.md) — Phase 1 real-Azure integration
  via the `/admin` DB config page (model + Foundry IQ knowledge-base dropdowns from the Foundry API,
  real agent + LLM + retrieval, P1 security fix). Filed as epic #18 with children #19 / #20 / #21.

- [`spec-voice-live-agent-contract.md`](spec-voice-live-agent-contract.md) — the exact, live-verified
  Azure Voice Live **agent-mode** contract that makes `/interview` "语音作答" connect the interviewer's
  Foundry prompt agent over WebRTC (Lisa digital-human appears + the agent speaks). Captures the
  signaling URL shape (hyphenated `agent-name`/`agent-project-name` keys — the core fix), Entra auth
  scope, agent metadata single-key rule, runtime `session.update` trimming, plus an error→cause table
  and a copy-paste regression checklist. Shipped v0.23.1.0. **Read this first if voice regresses.**

- [`spec-per-persona-knowledge.md`](spec-per-persona-knowledge.md) — per-persona Foundry IQ knowledge:
  configure each interviewer persona's own knowledge bases in the `/admin/agent` Knowledge section
  (connection → KB connect dialog), bound to that persona's Foundry agent as authenticated MCPTools
  on sync. Retires the single global KB → agent binding (F1 SOP scoring retrieval unchanged). Ported
  in shape from AI-Coach's per-HCP KB feature. Shipped v0.24.0.0.

## What was intentionally NOT promoted

The gstack project dir also holds machine-local, per-developer working state that does **not**
belong in the repo: review logs (`*-reviews.jsonl`), the session `timeline.jsonl`, `brain-cache/`,
and OS cruft (`.DS_Store`). Those stay in `~/.gstack/` by design.

## Implementation status

For "what's actually built vs. the spec", see [`../IMPLEMENTATION-STATUS.md`](../IMPLEMENTATION-STATUS.md)
and `CHANGELOG.md`.
