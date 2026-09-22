# TODOS

## Interview (voice)

### Bank-mode "silent advance" switch (answer → next question, digital human never interjects)

**What:** Add a persona switch so bank-mode sessions can run the same silent turn contract external mode already uses: server VAD `create_response=False`, `commitAnswer` skips its bare `response.create`, and the 3-second silence auto-commit advances the interview.

**Why:** The no-follow-up interviewer prompt (v0.37.4.7) only *tells* the model not to talk between questions. This removes the model's turn entirely, so a follow-up is impossible by construction instead of by instruction — the client's "one question, one answer, straight to the next" requirement stops depending on model compliance.

**Context:** Three code points currently key off the brain type instead of a dedicated flag: `backend/app/services/voice_live_proxy.py` (`create_response=not is_external`), `frontend/src/hooks/useInterviewVoice.ts` (the two `externalMode` guards around the bare `response.create`, and `EXTERNAL_SILENCE_AUTOCOMMIT_MS` being external-only), and the `externalMode` prop wired in `frontend/src/pages/InterviewPage.tsx`. Change all three to read a new persona flag (e.g. `linear_turns`) that external mode sets implicitly. Trade-offs already discussed with the owner (2026-09-22): zero reaction between questions feels abrupt (mitigate with a verbatim "Thank you. Next question:" lead-in injected by the backend), and a >3 s mid-answer pause counts as done (threshold is tunable; external mode ships with 3 s). Start from `docs/planning/spec-candidate-login.md`'s "Out of Scope" note and the v0.37.4.7 CHANGELOG entry.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Completed
