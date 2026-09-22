# TODOS

## Interview (voice)

### Bank-mode "silent advance" switch (answer → next question, digital human never interjects)

**What:** Two admin-configurable persona fields, edited in the `/admin/agent` digital-human editor and returned to the frontend in the interview start/resume response:
- `linear_turns` (bool, default **off**; external mode forces it on): when on, bank-mode sessions run the silent turn contract external mode already uses — server VAD `create_response=False`, `commitAnswer` skips its bare `response.create`, and the interview advances on silence.
- `silence_autocommit_seconds` (int, default **3**, allowed 1–15): how long the candidate must stay silent after speaking before the answer is auto-submitted (the "I'm done" button stays as an immediate override). Replaces the hardcoded `EXTERNAL_SILENCE_AUTOCOMMIT_MS = 3_000`.

**Why:** The no-follow-up interviewer prompt (v0.37.4.7) only *tells* the model not to talk between questions. This removes the model's turn entirely, so a follow-up is impossible by construction instead of by instruction — the client's "one question, one answer, straight to the next" requirement stops depending on model compliance.

**Context:** Three code points currently key off the brain type instead of a dedicated flag: `backend/app/services/voice_live_proxy.py` (`create_response=not is_external`), `frontend/src/hooks/useInterviewVoice.ts` (the two `externalMode` guards around the bare `response.create`, and `EXTERNAL_SILENCE_AUTOCOMMIT_MS` being external-only), and the `externalMode` prop wired in `frontend/src/pages/InterviewPage.tsx`. Change all three to read the new persona fields (external mode sets `linear_turns` implicitly). Owner decision 2026-09-22: this must be admin-configurable, not a code constant — both the on/off and the seconds. Trade-offs already discussed with the owner (2026-09-22): zero reaction between questions feels abrupt (mitigate with a verbatim "Thank you. Next question:" lead-in injected by the backend), and a >3 s mid-answer pause counts as done (threshold is tunable; external mode ships with 3 s). Start from `docs/planning/spec-candidate-login.md`'s "Out of Scope" note and the v0.37.4.7 CHANGELOG entry.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Completed
