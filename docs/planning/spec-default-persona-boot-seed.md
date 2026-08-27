# Boot-time default-persona seed (public-demo bootstrap for the digital human)

**Status:** shipped v0.34.0.0. Approved directly by the owner (two decisions locked via
AskUserQuestion — persona name + auto-sync-on-boot). Zero-Azure testable (mock adapter).

## Problem

The Azure public-demo deployment runs on **ephemeral SQLite that is reseeded on every boot** (no DB
PaaS — see [`spec-azure-cicd-deploy.md`](spec-azure-cicd-deploy.md)). A persona created online in the
`/admin/agent` editor therefore **vanishes on the next container restart**. With no enabled default
persona:

- the voice broker's resolution finds nothing and raises `VoiceUnavailable` — the digital human
  can't speak; and
- the agent editor opens on its empty "select a persona" state.

The operator's own local machine already has a fully-configured default interviewer. The ask: sync
**that** persona to the server as the default, and **auto-select it** when the editor loads.

## Why it isn't just "insert a row"

Two design tensions, both resolved in `backend/app/services/persona_seed.py`:

1. **Orphan Foundry agents.** The sync adapter derives the agent name deterministically from the
   persona id: `interviewer-<id>`. A random UUID (the model default) + an ephemeral DB + auto-sync
   would mint a **brand-new Foundry agent on every boot**, accumulating orphans indefinitely.
   → **Fix:** seed with a **fixed id** equal to the operator's own local default persona id. The
   boot sync is then a create-or-**update** against the *same* already-synced Foundry agent every
   time. `DEFAULT_PERSONA_ID` is a constant in the seed module; changing it requires re-syncing
   Foundry.

2. **Model that may not exist.** Hardcoding a model (e.g. `gpt-5.4-mini`) breaks on a Foundry
   resource that lacks it. → **Fix:** seed `model=None`; the sync adapter falls back to
   `settings.foundry_agent_model` (the deployment's `FOUNDRY_AGENT_MODEL` param), so the deployment
   governs the model.

## Design

- **`seed_default_persona(db)`** — idempotent. No-op when a row with `DEFAULT_PERSONA_ID` already
  exists, or when any other enabled default is already configured (respects the single-enabled-default
  invariant / partial-unique index — never fights a live operator edit). Otherwise constructs the
  `InterviewerPersona` directly (to pin the fixed id) with `enabled=True, is_default=True`, the
  generic multilingual `prompt_fragment`, neutral Azure built-in voices, and `model=None`. Does
  **not** sync — definition only.
- **`sync_default_persona(db)`** — best-effort Foundry sync so voice is usable out of the box (the
  voice P5 gate rejects any persona whose `agent_sync_status != "synced"`). No-op when there's no
  default or it's already synced; else delegates to the shared `admin_personas._sync` (mark pending →
  adapter → mark synced/failed, never raises). A failure leaves the persona `failed` → text-only
  degrade.
- **`main.py` lifespan** — seeds the persona in a best-effort try/except (never blocks startup),
  alongside the existing demo-bank + admin seeds; launches `sync_default_persona` as a **background
  asyncio task** (a slow/absent Foundry never delays boot), cancelled on shutdown.
- **`AgentEditorPage.tsx`** — a `useRef`-guarded **one-shot** effect auto-selects the enabled default
  (fallback: the first persona) once after the first list load. The guard means a later background
  `refreshList` (e.g. after Save) never yanks the operator off a persona they've switched to or a
  "New persona" draft.

## Public-repo safety

The seeded `prompt_fragment` is the operator's **generic** interviewer contract — poses the system's
questions to the candidate, never answers them, stays in persona, follows the candidate's language.
No client wording, role names, SOP sections, or KPI thresholds. Voices are neutral Azure built-ins.
Nothing client-specific enters the committed file.

## Tests

`backend/tests/test_persona_seed.py` (8 tests): fixed-id + enabled-default creation, idempotency,
no-op when another enabled default exists, mock-adapter sync → `synced`, no-op when no default,
adapter-failure → `failed` (swallowed), and already-synced → adapter not consulted again (patches
`app.api.admin_personas.get_agent_sync_adapter`, which `_sync` binds at import).
`frontend/src/pages/AgentEditorPage.test.tsx` (4 new/updated): auto-select the enabled default,
fall back to the first persona, empty-state when no personas, and the login-gate test asserts the
auto-select.

## See also

- [`spec-azure-cicd-deploy.md`](spec-azure-cicd-deploy.md) — the ephemeral-SQLite / boot-seeding
  deployment context this feature lives inside.
- [`spec-voice-live-agent-contract.md`](spec-voice-live-agent-contract.md) — the voice contract whose
  P5 gate requires a `synced` persona.
