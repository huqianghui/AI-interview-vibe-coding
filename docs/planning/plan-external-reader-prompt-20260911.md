# Implementation Plan — Two independent interviewer prompts (Approach A)

**Date**: 2026-09-11
**Status**: LOCKED — `/plan-eng-review` complete (decisions resolved in §5); ready to implement.
**Scope**: Give the interviewer persona **two independent, separately-stored, separately-editable**
prompt config items, and make the editor active-mode-aware.

---

## 1. Problem & intent

Today a persona has ONE prompt field, `prompt_fragment`, which is the **bank-mode** interviewer
prompt (it becomes the Foundry agent's `instructions` via the sync adapter). In **external mode**
(`interview_brain == "external"`) the session runs as a pure MODEL-mode "mouth" (v0.37.1.9): there
is **no Foundry agent**, so `prompt_fragment` is never used — it is dead config in that mode. The
mouth simply reads each turn's `speech_text` verbatim (assistant conversation item + bare
`response.create`, `useInterviewVoice.emitSpeak`). Nothing shapes *how* it reads.

We want a second prompt, `external_reader_prompt`, that shapes the external-mode reader's behavior
(tone, pacing, "read exactly — never add, summarize, translate, or improvise", persona framing).

**Owner's refinement (决定性约束)**: once it exists, these are **two independent config items**, not
one field whose value swaps on the toggle. The `interview_brain` toggle decides which one is
**active** (used at connect) and which the editor **shows/edits** — but **both persist
independently**, so switching brain back and forth never destroys the other's content.

---

## 2. Architecture: where each prompt lives and flows

| Prompt | Mode | Delivery to Azure | Persisted in |
|---|---|---|---|
| `prompt_fragment` (existing) | bank | Foundry agent `instructions` via sync adapter (or `default_instructions(name)` when empty) | `interviewer_personas.prompt_fragment` |
| `external_reader_prompt` (NEW) | external | **connect-time system conversation item** (parallel to `build_language_pin_item`), MODEL mode | `interviewer_personas.external_reader_prompt` |

Key invariant preserved: external mode has **no agent** → `external_reader_prompt` **cannot** be
synced to an agent and is **never reconciled** from the Portal (there's nothing to reconcile
against). It is a pure connect-time injection.

---

## 3. Changes by thread

### Thread 1 — Model + migration

`backend/app/models/persona.py`
- Add `external_reader_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)`.
  Nullable (NOT `default=""`, NOT `nullable=False`) — it is independent of `prompt_fragment` and
  must never be coerced/overwritten when the other is edited. `NULL` = "unset, use the generated
  default".
- Add a module-level `default_external_reader_prompt(name: str) -> str` (parallel to the existing
  `default_instructions(name)`) — the fallback reader prompt used when the column is `NULL`/blank.
- Add a read-only `default_external_reader_prompt` **property** (parallel to the existing
  `default_instructions` property) so the API can surface the effective default as a placeholder.

`backend/alembic/versions/f6a7b8c9d0e1_external_reader_prompt.py` (NEW)
- `down_revision = "e5f6a7b8c9d0"` (confirmed current head).
- `op.add_column("interviewer_personas", sa.Column("external_reader_prompt", sa.Text(), nullable=True))`
- `downgrade`: `op.drop_column(...)`.
- **No backfill** — `NULL` is the intended "use default" sentinel (unlike the en-US language
  backfill, which changed existing behavior; this adds a purely additive, dormant column).

### Thread 2 — Service CRUD + reconcile

`backend/app/services/persona_service.py`
- `create_persona(...)`: add `external_reader_prompt: str | None = None` param; persist as-is
  (do not coerce `None`→`""`; `None` means "use default").
- `update_persona(**changes)`: **no change** — it's a generic `for field, value in changes.items():
  setattr(persona, field, value)` loop (persona_service.py:122), so `external_reader_prompt` threads
  through as soon as the model has the column. (Confirmed in review; no allow-list exists.)
- `reconcile_persona(...)`: **explicitly does NOT touch `external_reader_prompt`.** Reconcile pulls
  Portal-edited agent `instructions` back into `prompt_fragment`; external mode has no agent, so
  there is nothing to reconcile. Add a one-line comment stating this so a future reader doesn't
  "fix" the omission.

### Thread 3 — Connect-time injection (the delivery mechanism)

`backend/app/services/voice_live_proxy.py`
- Add a pure builder `build_reader_prompt_item(text: str) -> dict[str, Any]` — same shape as
  `build_language_pin_item`: a `conversation.item.create` with a `role: "system"` message. No
  network, unit-testable in zero-Azure CI.
- In `run_proxy`, when `is_external`, after the language pin send, send the reader-prompt item:
  ```python
  await conn.send(build_language_pin_item(locale))
  if is_external:
      reader_prompt = (persona.external_reader_prompt or "").strip() \
          or default_external_reader_prompt(persona.name)
      await conn.send(build_reader_prompt_item(reader_prompt))
  ```
  Ordering: language pin first (session-wide), reader prompt second (behavioral). Both BEFORE any
  response can be generated. Bank mode injects neither reader prompt (its agent carries
  instructions) — unchanged.

`backend/app/services/voice_broker.py` (WebRTC broker path)
- **LOCKED (Decision 3 — proxy-only, broker deferred)**: the live candidate interview path is the
  WS proxy (`useInterviewVoice.ts` → `/api/voice-live/ws` → `run_proxy`), which is where external
  personas actually run (they carry avatars → proxy). The WebRTC broker is the **admin Playground**
  path only, and it does **not** inject the language-pin system item today either — so the
  reader-prompt injection matches existing parity by living only in the proxy. **No `voice_broker.py`
  / `VoiceSession` change in this PR.** If admin-Playground preview of an external persona later
  needs shaping, that is a separate follow-up that also closes the pre-existing language-pin gap.

### Thread 4 — Frontend editor (active-mode-aware)

`frontend/src/api/personas.ts`
- Add `external_reader_prompt` to `PersonaCreate`, `PersonaUpdate` (optional), `PersonaOut`.
- Add `default_external_reader_prompt: string` to `PersonaOut` (the effective default, for the
  placeholder — mirrors the existing `default_instructions` surfacing).

`frontend/src/pages/agentEditorForm.ts`
- `PersonaFormState`: add `externalReaderPrompt: string`.
- `emptyPersonaForm()`: `externalReaderPrompt: ""`.
- `personaToForm(p)`: `externalReaderPrompt: p.external_reader_prompt ?? ""`.
- `formToPayload(form)`: `external_reader_prompt: form.externalReaderPrompt`.

`frontend/src/components/agent-editor/AgentDefinitionPanel.tsx`
- The **Instructions** section becomes active-mode-aware:
  - `interviewBrain === "bank"` → existing `prompt_fragment` textarea (+ `defaultInstructions`
    placeholder), unchanged.
  - `interviewBrain === "external"` → an **External reader prompt** textarea bound to
    `externalReaderPrompt`, with `defaultExternalReaderPrompt` as placeholder + the same
    "using the auto-generated default" hint pattern.
  - Only the ACTIVE mode's field is shown/edited; the other's value stays in form state untouched
    (independent persistence — round-trips through save).
- Section title/help copy switches with the mode ("Instructions (Foundry agent)" vs "Reader prompt
  (external mode)").

### Thread 5 — Tests (CI guard)

Backend (`backend/tests/`):
- Migration up/down roundtrip (column added/dropped).
- `create_persona` + `update_persona` persist `prompt_fragment` and `external_reader_prompt`
  **independently** — editing one never mutates the other; toggling `interview_brain` never clears
  either.
- `reconcile_persona` leaves `external_reader_prompt` untouched.
- `build_reader_prompt_item` shape (system role, input_text).
- `default_external_reader_prompt(name)` non-empty and name-aware.
- (Pure builder) external persona → reader-prompt item constructed; bank persona → none.

Frontend:
- `agentEditorForm` mappers roundtrip both prompt fields independently.
- `AgentDefinitionPanel` renders the reader-prompt textarea in external mode, the instructions
  textarea in bank mode.

---

## 4. Non-goals / preserved invariants

- Does **not** change the v0.37.1.9 invariant (external = model mode, no agent, P5 gate skipped).
- Does **not** make `prompt_fragment` active in external mode or `external_reader_prompt` active in
  bank mode.
- Vendor-neutral: no product/domain names; token stays "external".
- en-US default unaffected; `build_language_pin_item` behavior unchanged (reader prompt is additive
  and injected AFTER it).

---

## 5. Engineering decisions (LOCKED — `/plan-eng-review` 2026-09-11)

1. **Delivery mechanism → connect-time system conversation item.** `build_reader_prompt_item(text)`
   (system role, `input_text`), sent via `conn.send(...)` in `run_proxy` right after the language
   pin, only when `is_external`. Chosen because external = MODEL mode with no Foundry agent
   (v0.37.1.9), and Azure rejects overriding `instructions` in `response.create` (live-verified) —
   a session-scoped system item is the one channel that works. (Per-turn prepend and
   `response.create` override both rejected.)
2. **Empty/NULL fallback → generate a default, always inject.** Add
   `default_external_reader_prompt(name)` (parallel to `default_instructions`); when the column is
   `NULL`/blank, inject the generated default (verbatim-read framing: "read exactly — never add,
   summarize, translate, or improvise"). `NULL` = "use default", surfaced as the editor placeholder.
   Guarantees every external session has consistent, shaped read behavior.
3. **Transport coverage → proxy-only; broker/Playground deferred.** The live external-interview path
   is the WS proxy (server-side injection covers it fully). The WebRTC broker is admin-Playground
   only and doesn't inject the language pin today either — no `voice_broker.py`/`VoiceSession`
   change here; a future follow-up can add both together. (See Thread 3.)
4. **`reconcile_persona` → never touches `external_reader_prompt`.** External mode has no agent to
   reconcile against; reconcile pulls Portal `instructions` into `prompt_fragment` only. This is
   already how the code behaves (persona_service.py:213-231) — add a one-line comment so no future
   reader "fixes" the omission. No behavioral change.
5. **Scope → additive, dormant (confirmed).** New nullable column, no backfill; `prompt_fragment`
   stays stored-but-dormant in external mode and `external_reader_prompt` stays dormant in bank
   mode; both persist independently across `interview_brain` toggles (owner's decisive constraint).
   The v0.37.1.9 invariant (external = model mode, no agent, P5 skipped) is untouched.
6. **Editor UX → show only the active mode's field.** In external mode the editor shows the External
   reader prompt textarea; in bank mode the Instructions textarea. The inactive field's value stays
   in form state and round-trips through save untouched (independent persistence). Least clutter,
   honors the two-independent-columns model. *(Recommended option locked at review; owner may veto
   toward "always show both" at implementation.)*

### Code-grounding confirmations (from this review)

- `update_persona(**changes)` is a generic `setattr` loop (persona_service.py:122) → the new field
  threads through **with no allow-list edit**. `create_persona` gains an explicit
  `external_reader_prompt: str | None = None` param for clarity (it could ride the existing
  `**voice_knobs` catch-all, but explicit is preferred).
- `reconcile_persona` already writes only `prompt_fragment` (Decision 4).
- Live external interview runs over `useInterviewVoice.ts` → `voice_live_proxy.run_proxy`, not the
  broker (Decision 3).
