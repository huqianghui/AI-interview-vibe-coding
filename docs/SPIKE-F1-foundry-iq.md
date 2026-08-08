# F1 Spike — Foundry IQ Citation Traceability

**Status: GO** — validated LIVE against a real Foundry IQ knowledge base (2026-08-08).
Code-contract + live-validation both DONE. **Fallback not triggered.**
**Date:** 2026-08-08 · **Branch:** `feat/f1-foundry-iq-spike`

This spike de-risks the highest-risk external dependency in the project (SPEC §6): the
Foundry IQ / Azure AI Search **`retrieve`** API that produces the citations the demo leads
with. Per SPEC P16 ("read the reference source + git history before porting"), the contracts
were first ported from the reference `AI-avatar-vibe-coding` repo's Avatar-platform layer,
then **corrected against a live KB** — which surfaced three contract bugs in the reference
(see "Live findings" below). The `retrieve` call now works end to end against a real index.

## Live findings (the reason this spike paid for itself)

Run against a live Foundry IQ KB (borrowed from the reference project's demo Azure env; auth
via Azure CLI Entra token / management-plane admin key). The reference's ported contract was
**wrong in three ways** that would each have silently broken every grounded turn:

1. **`knowledgeSourceName` ≠ index/KB name.** The reference passed `index_name` for both the
   URL path segment and the `knowledgeSourceParams.knowledgeSourceName`. The live KB rejects
   that with HTTP 400 — the body name must be the KB's *knowledge source* name (e.g.
   `…-index-ks`), which is distinct from the KB name in the URL. → added
   `azure_search_knowledge_source` config + adapter param.
2. **`sourceData` is `null` unless you ask for it.** Without
   `knowledgeSourceParams[].includeReferenceSourceData: true`, every reference returns
   `sourceData: null` (only a top-level `title` survives) → the gate would drop 100%. → adapter
   now always sends `includeReferenceSourceData: true`.
3. **`sourceData` fields are per-index — there is no universal `title`/`url`/`page`.** The live
   KB's `sourceData` schema is `{answer, question, product_model, product_series, source,
   region, country, version}`. The reference's hardcoded `title`/`url`/`page` gate would drop
   all references on this (valid, populated) KB → false refusal on every turn. → the gate is
   now **field-configurable** (`required_fields` + `field_map`) while keeping the strict
   all-fields-or-drop invariant.

**Live smoke result** (`backend/scripts/smoke_retrieve.py`): a matching query returned 17
references → gated to 3 citations via a `field_map` (canonical `title`/`url`/`page` → the index's
own `sourceData` field names);
a gibberish query returned 0 references (the no-match/refusal signal). Both paths behave exactly
as the demo needs.

## Why this is a spike, not a feature

We have **no live Azure creds** in this environment, and the `retrieve` API is a **PREVIEW**
contract (`api-version=2026-05-01-preview`). The spike has two halves:

- **Code-contract half (done, CI-green):** the request/response shape, the strict field gate,
  the extraction+chunking pipeline, and adapter wiring — all exercised by unit tests with zero
  Azure calls.
- **Live-validation half (DONE for retrieval):** the actual `retrieve` call was validated
  against a live KB (see "Live findings"). Foundry-*agent* knowledge-source binding and the
  Portal "Voice mode ON" check (F9-adjacent) still need the client's own agent + demo env
  (SPEC §9) — remaining items flagged in the checklist below.

## What was built

| Artifact | Path | Covered in CI |
|---|---|---|
| Strict citation gate (pure, field-configurable) | `app/services/agents/citations.py` | ✅ 100% |
| Azure retrieve adapter (live call) | `app/services/agents/adapters/azure_retrieval.py` | ⬜ coverage-omitted (needs live env) |
| SOP text extraction dispatch + chunking | `app/sop/extraction.py` | ✅ 100% |
| Binary parsers (pdf/docx/pptx) | `app/sop/binary_extractors.py` | ⬜ coverage-omitted (optional deps) |
| SOP models | `app/models/sop.py` (+ migration `da25e7365d9a`) | ✅ |
| Registry wiring (mock default, azure conditional) | `app/services/agents/registry.py` | ✅ |
| Live smoke test (standalone) | `backend/scripts/smoke_retrieve.py` | n/a (not in CI) |

## Corrected contract (validated live — supersedes the reference)

**`retrieve` call** — `POST {endpoint}/knowledgebases/{KB_NAME}/retrieve?api-version=2026-05-01-preview`

```json
{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "<query>"}]}],
  "knowledgeSourceParams": [{
    "knowledgeSourceName": "<KNOWLEDGE_SOURCE_NAME>",
    "kind": "searchIndex",
    "includeReferenceSourceData": true
  }]
}
```

- `KB_NAME` (URL) and `KNOWLEDGE_SOURCE_NAME` (body) are **different values** — a KB references
  one or more knowledge sources by their own names. Passing the KB name in the body → HTTP 400.
- `includeReferenceSourceData: true` is **required** or every `references[].sourceData` is `null`.

**Response → citation gate:** each `references[].sourceData` carries a **per-index** field set
(the KB we tested exposed `answer / question / product_model / product_series / source / region
/ country / version` — no `title`/`url`/`page`). The gate maps the index's fields to canonical
citation fields (`field_map`) and keeps a citation **only if every required field is present
(truthy)**; anything partial is **silently dropped**. A zero-length result is the **"no match"
signal** (drives an interviewer refusal upstream), never a fabricated answer. Cap = 3, source
order preserved.

> Truthy semantics (`if value`) match the reference: a falsy field (`0`, `""`) drops the ref.
> When we build our own SOP index we control its `sourceData` schema, so we'll map real
> `page_label` / `section_path` chunk fields to canonical `page` / `url`.

## Divergences from the reference (deliberate)

1. **4-state scoring judgment (SPEC F4: `met/partially_met/not_met/violated`) is NOT ported** —
   the reference has no such enum. Its scoring uses a 2-state `delivered` boolean + a 2-rule
   score-capping anti-hallucination net; the nearest multi-state thing is a **3-state**
   SOP-coverage judgment in `dry_run_engine.py`. Our 4-state model is **spec-driven**, built
   fresh in `app/interview/scoring.py`. We keep the reference's *spirit* (programmatic
   post-validation guardrails on top of LLM judgment) without porting a state machine that
   isn't there.
2. **Field gate extracted to a pure module** — the reference inlines the gate inside the live
   call. We split it out so the invariant is CI-tested without a live endpoint. The live adapter
   calls the shared `shape_citations`, so there's exactly one gate implementation.
3. **`default_retrieval_provider` added** — the pre-spike registry selected the retrieval
   adapter on `default_voice_provider` (wrong capability). Fixed to a dedicated setting.

## Go / No-Go — GO, with standing FALLBACK TRIGGERS (SPEC P15)

**Verdict: GO.** The `retrieve` contract works end to end against a live KB. The spike also
produces **standing trigger conditions** — if any fires in the client env, flip to the fallback.

**Trigger A — citation-retrieve shape instability.** ✅ *Validated (not triggered).* The PREVIEW
`retrieve` returns references with per-index `sourceData` (once `includeReferenceSourceData` is
set); our gate maps + strictly gates them. Re-fires if a future api-version changes the
`references[].sourceData` shape or the `knowledgeSourceParams` contract. Detection: the smoke
test returns 0 citations for a query that clearly matches indexed content.

**Trigger B — Foundry-*agent* knowledge-source connection instability.** ⏳ *Not yet validated
(needs the client's interviewer agent).* The agent can't be bound to the KB as a knowledge
source (RemoteTool connection fails, or the KB silently drops from a "synced" agent). Detection:
portal shows the KB unattached, or `retrieve` 401/403s under the project managed identity.
(Note: our app calls `retrieve` directly with its own creds — this trigger only matters if we
route through a hosted Foundry agent rather than the direct adapter.)

**Trigger C — Voice mode won't stay ON.** ⏳ *F9-adjacent, not yet validated.* Agent metadata
must use **snake_case** Voice Live schema with `.1/.2` 512-char chunking — the **camelCase
format is a trap**: the current Portal shows Voice mode OFF even with
`microsoft.voice-live.enabled: "true"`. Detection: Portal Voice toggle reads OFF after sync.

**Fallback if any trigger fires:** swap the `azure` retrieval adapter for a direct Azure AI
Search **`/docs/search`** query (stable GA API) over the same indexed SOP chunks, shaping the
same canonical citations from chunk `page_label`/`section_path` via the same `field_map` gate.
The gate, models, extraction pipeline, and entire upstream flow are **unchanged** — only the
adapter body swaps. This is why the gate lives in a provider-agnostic module. No demo-spine
rework required.

## Validation status

**Done (live, this spike):**
- [x] `retrieve` smoke test: matching query → gated citations (17 refs → 3 via `field_map`).
- [x] No-match query → 0 references → refusal signal (no fabrication).
- [x] Corrected the 3 reference contract bugs (KS name, `includeReferenceSourceData`, field map).

**Remaining (needs client SOP index + agent + demo env — SPEC §9):**
- [ ] Index 1–2 real SOP docs; confirm chunks carry usable `page_label` / `section_path`.
- [ ] Map our SOP index `sourceData` fields → canonical `title`/`url`/`page` (own the schema).
- [ ] If routing through a hosted Foundry agent: bind KB + confirm attached (Trigger B).
- [ ] Portal shows **Voice mode ON** after agent sync with snake_case metadata (Trigger C, P16).
- [ ] Confirm no SOP verbatim / checklist text leaks into any `X-Anon-Session` response (P3/P4).

## Reproducing the live smoke test

`backend/scripts/smoke_retrieve.py` (standalone, NOT in CI). Reads `AZURE_SEARCH_*` from a
gitignored `.env`; auths via `AZURE_SEARCH_API_KEY` or an Azure CLI Entra token. Never hardcode
endpoints/index names — this repo is PUBLIC.

```
cd backend
set -a && source .env && set +a
python scripts/smoke_retrieve.py "your query here"
```

## CI status at spike close

`57 passed`, backend coverage **94%** (gate 85%). Gate + extraction modules at 100%.
Lint + format clean.
