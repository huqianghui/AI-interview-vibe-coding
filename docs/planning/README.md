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

- [`design-B-checklist-mandatory-20260818.md`](design-B-checklist-mandatory-20260818.md) — every
  question always has a non-empty, human-editable **scoring checklist** (F3b). Root fix for reports
  showing "占位评分 / coverage 0%": checklist is auto AI-generated **from the question text itself**
  (SOP-optional) at question-create time, with a system-level non-empty fallback; the already-built
  `editChecklistItems` PUT is wired into AdminPage as an editable form (kind/text/weight/add/delete/
  save, re-normalized to 100); empty → one-click regenerate; entry-point discoverability fixed. Zero
  Azure (mock provider testable), P3 candidate boundary untouched. Out of scope (separate backlog):
  admin three-tab layout, SOP-upload frontend UI (backend `POST /admin/sop/documents` exists but has
  no frontend). Approved 2026-08-18 via `/office-hours`.

- [`spec-voice-transcript-race-explicit-submit.md`](spec-voice-transcript-race-explicit-submit.md) —
  fixes the on-device report defects ("未作答" blank + off-by-one order) rooted in one frontend race:
  a voice answer was submitted before its async STT transcript landed. `commitAnswer()` now returns a
  `Promise` resolving this turn's transcript (fail-closed on timeout/teardown). Adds a pre-scoring
  **review** phase (`GET /{id}/review` + `ReviewView`) so the last answer no longer auto-scores —
  scoring starts only on an explicit **提交并评测** click — plus three-layer empty-answer rejection
  (also fixes a verbal-cue-strips-to-empty bug). Backend unchanged in shape (pairs by `question_id`).
  Approved via plan mode; shipped v0.30.0.0.

- [`spec-mece-classification-scoring.md`](spec-mece-classification-scoring.md) — extends F4/F8 from
  an A–F letter grade to a client-facing **classification rating** (*Meets Expectations / Needs
  Improvement / Does Not Meet*) driven by six weighted MECE dimensions, with **critical-error
  capping** and a **pending-conflict disclosure exemption**; adds per-question weighting (weighted
  interview mean, fixing the prior simple-average gap) and a **deploy-time importer** that F1-ingests
  a real inspection-interview document set and authors each rubric programmatically with true SOP
  source binding — all into the gitignored DB, with no client content in any committed file.
  Approved via plan mode; shipped v0.31.0.0.

- [`spec-external-mcp-interviewer-integration.md`](spec-external-mcp-interviewer-integration.md) —
  **analysis / NOT approved, blocked on client answers.** A client-provided MCP result sample
  (`final_session_state_json` / `public_response_json` / `speech_word_count`) turns out to be a
  **parallel implementation of the same rf-CSM interview** our F4/F6 already ship — so integrating
  it is a "who owns the brain" decision, not an "add a tool" task. Documents the field-level
  correspondence to our engine, the data problems (double-JSON encoding, `RFCMS-Q0x` id leak in
  `display_text`, results≠covered mismatch, missing answer-submission contract + session id,
  file-name-not-document-id citations that break clickable SOP links), and why attaching it as a
  Foundry-agent tool (Path 1) is a trap vs. backend-as-MCP-client (Path 2). Ends with the blocking
  questions to bring back to the client. Pre-implementation gate. Chinese counterpart:
  [`spec-external-mcp-interviewer-integration.zh-CN.md`](spec-external-mcp-interviewer-integration.zh-CN.md)
  (content-aligned, plus a client-ready 10-question confirmation checklist in §附).

- [`design-external-interview-brain-integration.md`](design-external-interview-brain-integration.md) —
  **APPROVED 2026-09-04 (Phase 2), realizes + amends the analysis spec above.** The client shipped
  their own interview brain behind a public gateway (`.../difyAgent/runWorkflow/streaming`,
  SSE + hex-encoded `inputs`), live-tested E2E on 2026-09-04. This `/office-hours` design integrates
  it as a **second, per-persona interview mode** beside the untouched built-in bank (Approach B: a
  parallel `external_runner` + `external_interview_client`, never a Foundry-agent tool). Key
  amendment to §14.4: the delivered API is **stateless** (proven by a reset control experiment), so
  we persist and round-trip the opaque `session_state_json` blob ourselves — backend-only, never to
  the browser (rubric-leak boundary). Carries the Codex hardening list: commit-before-speech, a
  submit-time CAS turn reservation (409s a second distinct answer before it can call the brain),
  pending-answer dedup, silent replay-on-resume, `external_phase` recovery sub-state (stays
  `in_progress` so existing resume works), and a fake-server chaos suite. **Vendor-neutral by owner
  directive** — code/config/UI say "external interview API/server", never the product name. v1 does
  no local scoring (results stay client-side); ships the connection config as the seeded default
  with a masked/click-to-reveal key. Converged after 2 adversarial review rounds (8/10). Four open
  questions to the client (key rotation, idempotency, real-workflow p95 latency, event enumeration)
  gate the latency/retry hardening slice but not the build start. Next gate: `/plan-eng-review`.

- [`spec-azure-cicd-deploy.md`](spec-azure-cicd-deploy.md) — the CI/CD + Azure deployment plan
  (Container Apps, **Sweden Central**, co-located with the reused Foundry resource). Mirrors the
  sibling AI-Coach infra but simpler: **managed-identity** auth throughout, **ephemeral SQLite**
  reseeded every boot (no DB PaaS), and **boot-time self-seeding** in `backend/entrypoint.sh`
  (`alembic upgrade head` → optional private-blob client-bundle fetch+import → `uvicorn`) — which
  replaces the reference's separate bootstrap Job (a Job's disk can't seed the app replica's
  per-replica SQLite). The gitignored client importer + source docs never enter the public repo or
  the CI image; they arrive through a private `client-bundle` blob pulled at boot. Bicep drops all
  AI-resource creation (Foundry reused, granted to the backend MI by
  `infra/azure/scripts/grant-foundry-rbac.sh`). Single `public` env. Approved via plan mode;
  shipped v0.33.0.0.

- [`spec-default-persona-boot-seed.md`](spec-default-persona-boot-seed.md) — boot-time seed of the
  enabled default interviewer persona so the digital human works out of the box on the **ephemeral
  SQLite** public demo (reseeded every boot, so an editor-created persona would vanish → voice
  `VoiceUnavailable` + empty editor). Seeds with a **fixed persona id** = the operator's local id so
  the boot sync is a create-or-update against the *same* `interviewer-<id>` Foundry agent (no orphan
  per reboot); `model=None` defers to the deployment's `FOUNDRY_AGENT_MODEL`. Best-effort lifespan
  seed (never blocks boot) + background Foundry sync (voice P5 gate needs `synced`; failure → text
  degrade); the editor auto-selects the default on entry. Generic contract only — no client content.
  Approved by the owner; shipped v0.34.0.0.

- [`plan-client-delivery-package.md`](plan-client-delivery-package.md) — the **client hand-off**
  plan + as-built record (2026-09-01). Packages the tested build (`v0.36.0.4`) so a client deploys
  it in **their own Azure tenant with their own AAD**, no source code and no GitHub: trimmed bicep
  (`delivery/infra/`, GitHub OIDC gated off by a new `enableGithubOidc` param that defaults **true**
  in the main repo so the live CI path is unchanged), prebuilt linux/amd64 image tars exported via
  **skopeo** (no docker), a one-click `deploy-client.sh` (login → infra → skopeo push → deploy →
  Foundry RBAC → health), and a Chinese `.docx` operator manual. Reproduces **all 5 question banks**
  (3 generic baked into the image; 2 rf-CSM shipped out-of-band as **plain JSON** uploaded to a
  public **Azure Files share** — RBAC + account-key, **no VNet** — mounted read-only and auto-imported
  on boot by `seed_client_banks()`; never committed). *(Simplified 2026-09-01 from the earlier
  VNet + private-blob bundle channel per owner request.)* Security boundary enforced by
  `delivery/.gitignore` + a `git add -n` dry-run. Delivered as a standalone zip, **not committed**;
  not deployed to a client tenant as of promotion.

## What was intentionally NOT promoted

The gstack project dir also holds machine-local, per-developer working state that does **not**
belong in the repo: review logs (`*-reviews.jsonl`), the session `timeline.jsonl`, `brain-cache/`,
and OS cruft (`.DS_Store`). Those stay in `~/.gstack/` by design.

## Implementation status

For "what's actually built vs. the spec", see [`../IMPLEMENTATION-STATUS.md`](../IMPLEMENTATION-STATUS.md)
and `CHANGELOG.md`.
