# TODOS

## Interview (voice)

### Bank-mode "silent advance": suppress the model's own turn (`linear_turns`)

**What:** One admin-configurable persona field, edited in the `/admin/agent` digital-human editor:
`linear_turns` (bool, default **on**; external mode forces it on; admin can switch it off if the
client finds the silent flow unsuitable). When on, bank-mode sessions run the silent turn contract
external mode already uses — server VAD `create_response=False` and `commitAnswer` skipping its bare
`response.create` — so the digital human cannot interject between questions.

**Why:** The no-follow-up interviewer prompt (v0.37.4.7) only *tells* the model not to talk between
questions. This removes the model's turn entirely, so a follow-up is impossible by construction
instead of by instruction — the client's "one question, one answer, straight to the next" requirement
stops depending on model compliance.

**Context:** Two code points still key off the brain type instead of a dedicated flag:
`backend/app/services/voice_live_proxy.py` (`create_response=not is_external`) and
`frontend/src/hooks/useInterviewVoice.ts` (the two `externalMode` guards around the bare
`response.create`). Change both to read the new persona field (external mode sets `linear_turns`
implicitly). Trade-off already discussed with the owner (2026-09-22): zero reaction between questions
feels abrupt — mitigate with a verbatim "Thank you. Next question:" lead-in injected by the backend.

The **silence auto-submit half of this item shipped separately in v0.38.1.0** (see Completed below),
so only the turn-suppression flag remains.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Completed

### Admin-configurable voice silence auto-submit, per engine — v0.38.1.0

Shipped as two independent per-engine setting pairs (`{bank,external}_auto_submit_enabled` /
`{bank,external}_auto_submit_silence_seconds`, 1–60s) surfaced in the `/admin/agent` Configuration
rail's "Answer submission (voice)" block, replacing the hardcoded `EXTERNAL_SILENCE_AUTOCOMMIT_MS`
constant. Bank defaults off (a fixed 3s window fired while candidates were still thinking); external
defaults on at 3s. This was the `silence_autocommit_seconds` half of the bank-mode silent-advance
item above; the `linear_turns` half is still open. See `CHANGELOG.md` 0.38.1.0 and `SPEC.md`.
