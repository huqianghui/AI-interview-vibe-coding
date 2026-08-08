# F1 Spike — Foundry IQ Citation Traceability

**Status:** code-contract half DONE (CI-green). Live-validation half DEFERRED to client Azure env.
**Date:** 2026-08-08 · **Branch:** `feat/f1-foundry-iq-spike`

This spike de-risks the highest-risk external dependency in the project (SPEC §6): the
Foundry IQ / Azure AI Search **`retrieve`** API that produces the citations the demo leads
with. Per SPEC P16 ("read the reference source + git history before porting"), the contracts
below are ported from the reference `AI-avatar-vibe-coding` repo's Avatar-platform layer, not
guessed.

## Why this is a spike, not a feature

We have **no live Azure creds** in this environment, and the `retrieve` API is a **PREVIEW**
contract (`api-version=2026-05-01-preview`). So the spike is split:

- **Code-contract half (done, CI-green):** the request/response shape, the strict field gate,
  the extraction+chunking pipeline, and adapter wiring — all exercised by unit tests with zero
  Azure calls.
- **Live-validation half (deferred):** the actual `retrieve` call, Foundry-agent knowledge-source
  binding, and the Portal "Voice mode ON" check — can only run in the client's demo Azure env
  (SPEC §9 pre-work). Checklist below.

## What was built

| Artifact | Path | Covered in CI |
|---|---|---|
| Strict citation field gate (pure) | `app/services/agents/citations.py` | ✅ 100% |
| Azure retrieve adapter (live call) | `app/services/agents/adapters/azure_retrieval.py` | ⬜ coverage-omitted (needs live env) |
| SOP text extraction dispatch + chunking | `app/sop/extraction.py` | ✅ 100% |
| Binary parsers (pdf/docx/pptx) | `app/sop/binary_extractors.py` | ⬜ coverage-omitted (optional deps) |
| SOP models | `app/models/sop.py` (+ migration `da25e7365d9a`) | ✅ |
| Registry wiring (mock default, azure conditional) | `app/services/agents/registry.py` | ✅ |

## Ported contract (the invariant the demo depends on)

**`retrieve` call** — `POST {endpoint}/knowledgebases/{index}/retrieve?api-version=2026-05-01-preview`

```json
{
  "messages": [{"role": "user", "content": [{"type": "text", "text": "<query>"}]}],
  "knowledgeSourceParams": [{"knowledgeSourceName": "<index>", "kind": "searchIndex"}]
}
```

**Response → citation gate:** each `references[].sourceData` may carry `title` / `url` / `page`.
The gate keeps a citation **only if all three are present (truthy)**; anything partial is
**silently dropped**. A zero-length result is the **"no match" signal** (drives an interviewer
refusal upstream), never a fabricated answer. Cap = 3, source order preserved.

> Note the truthy semantics: a `page: 0` is dropped by design (matches the reference's
> `if title and url and page`). If the live KB ever returns a legitimately zero page index,
> that's a fallback trigger (see below), not a silent bug.

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

## Go / No-Go — decision is a set of FALLBACK TRIGGERS, not a one-time verdict (SPEC P15)

The spike does **not** produce a permanent "go". It produces **trigger conditions** that, if
observed in the client env, flip us to the fallback. Ship on Foundry IQ **unless** any trigger
fires:

**Trigger A — citation-retrieve shape instability.** The PREVIEW `retrieve` response stops
returning `references[].sourceData.{title,url,page}` in the ported shape (field renamed/moved,
api-version bumped incompatibly, `page` becomes a non-label type). Detection: the deferred live
smoke test below returns 0 citations for a query that clearly matches SOP content.

**Trigger B — Foundry-agent knowledge-source connection instability.** The agent can't be bound
to the KB as a knowledge source (RemoteTool connection fails, or the KB silently drops from a
"synced" agent). Detection: portal shows the KB unattached, or `retrieve` 401/403s under the
project managed identity.

**Trigger C — Voice mode won't stay ON.** (F9-adjacent, captured here because it's the same
Foundry surface.) Agent metadata must use **snake_case** Voice Live schema with `.1/.2` 512-char
chunking — the **camelCase format is a trap**: the current Portal shows Voice mode OFF even with
`microsoft.voice-live.enabled: "true"`. Detection: Portal Voice toggle reads OFF after sync.

**Fallback if any trigger fires:** swap the `azure` retrieval adapter for a direct Azure AI
Search **`/docs/search`** query (stable GA API) over the same indexed SOP chunks, shaping the
same `{title, url, page}` citations from chunk `page_label`/`section_path`. The gate, models,
extraction pipeline, and entire upstream flow are **unchanged** — only the adapter body swaps.
This is why the gate lives in a provider-agnostic module. No demo-spine rework required.

## Deferred live-validation checklist (run in client demo Azure env — SPEC §9)

- [ ] Index 1–2 real SOP docs; confirm chunks carry usable `page_label`.
- [ ] `retrieve` smoke test: known-answerable query → ≥1 full-field citation (Trigger A).
- [ ] Known-unanswerable query → 0 citations → interviewer refusal (no fabrication).
- [ ] Bind KB to the interviewer agent as a knowledge source; confirm attached (Trigger B).
- [ ] Portal shows **Voice mode ON** after agent sync with snake_case metadata (Trigger C, P16).
- [ ] Confirm no SOP verbatim / checklist text leaks into any `X-Anon-Session` response (P3/P4).

## CI status at spike close

`54 passed`, backend coverage **94%** (gate 85%). Gate + extraction modules at 100%.
Lint + format clean.
