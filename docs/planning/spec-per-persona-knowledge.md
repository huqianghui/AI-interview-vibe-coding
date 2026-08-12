# Spec: Per-persona Foundry IQ knowledge (configure KBs in the Agent editor)

**Status:** Shipped v0.24.0.0 (2026-08-12)
**Spec of record:** [`../../SPEC.md`](../../SPEC.md) — F5 (interviewer digital human) · this doc
scopes the per-persona knowledge feature only
**Reference:** ported in shape from `AI-Coach-vibe-coding`'s per-HCP knowledge-base feature
(`hcp_knowledge_configs` + connect dialog + `resolve_kb_remote_tool_connections`).

---

## Context

The `/admin/agent` editor's **Knowledge** section was read-only: it showed the ONE global knowledge
base set under Admin → AI Foundry config and stated "bound automatically on sync from the global
config." Every interviewer persona's Foundry prompt agent was grounded on that same single KB (via
`settings.foundry_kb_mcp_connection`), and there was no way to give different personas different
knowledge.

The sibling AI-Coach project already solved the same shape per-agent: an admin attaches one or more
Foundry IQ knowledge bases to an agent through a connect dialog, and each attachment becomes an
`MCPTool` on that agent. The user asked for the same here, with three explicit decisions:

- **Per-persona** knowledge config, editable inside the Agent editor (full AI-Coach parity).
- **Multiple** knowledge bases per persona (list + add + remove).
- **No global-KB concept** for agent grounding — "each agent binds its own." The global KB → agent
  binding is retired.

The separate **F1 SOP text-retrieval** path (used to fetch SOP citations for answer *scoring*) is a
different consumer of the Admin AI Foundry config and is intentionally left unchanged.

## What already existed here (reused, not rebuilt)

`backend/app/services/agents/foundry_connections.py` already carried the hard Azure plumbing,
ported earlier from AI-Coach and unit-tested, but not yet wired into sync ("deferred #29"):
`list_search_connections`, `list_knowledge_bases`, `resolve_remote_tool_connection`
(find-or-create the RemoteTool project connection via the ARM control plane),
`remote_tool_connection_name`, `build_remote_tool_arm_request`. `knowledge_tool.build_knowledge_mcp_tool`
already built a single-KB MCPTool dict, and the azure adapter's `_to_mcp_tool`/`_to_sdk_tool` already
converted tool dicts into SDK objects. So this feature was mostly **wiring + a per-persona table +
a connect dialog**, not new Azure integration.

## Design

### Data
- **`persona_knowledge_configs`** (`PersonaKnowledgeConfig`): one row per attached KB.
  `persona_id` (FK → `interviewer_personas.id`, `ondelete=CASCADE`, indexed), `connection_name`,
  `connection_target` (Search endpoint URL), `index_name` (Foundry IQ KB name), `server_label`
  (defaulted `knowledge-base-{index_name}`), `is_enabled`. Migration `e3c4d5f6a7b8`.
- **`persona_knowledge_service`** (DB-only, 100% covered): `list_configs`, `add_config`,
  `get_config`, `remove_config`, and the pure `configs_as_dicts` shape the adapter consumes (so no
  ORM object crosses into the coverage-omitted adapter).

### Sync (the binding)
- `AzureAgentSyncAdapter.sync_persona(persona, *, locale=None, knowledge_configs=None)`:
  `_resolve_kb_tools` resolves each enabled config to an authenticated RemoteTool connection
  (`foundry_connections.resolve_remote_tool_connection`) and builds one MCPTool per KB.
  **Invariant:** built-tool count must equal enabled-config count — a KB that can't authenticate
  raises, so a persona is never reported "synced" while a KB silently failed to bind.
- `knowledge_tool.build_agent_tools(*, knowledge_tools, persona_tools)` — pure concat, KB tools
  first, then per-persona tools (code_interpreter / web_search / public MCP).
- The adapter registry no longer passes the global `search_endpoint`/`search_index`/
  `mcp_connection_id`. `_register_azure_retrieval` (F1 SOP scoring retrieval) is untouched.

### API (all admin-only, on the personas router; static `/knowledge/...` routes declared before
`/{persona_id}` so they aren't shadowed)
- `GET /admin/personas/knowledge/connections` → Azure AI Search connections (name/target/is_default).
- `GET /admin/personas/knowledge/knowledge-bases?connection_name=` → Foundry IQ KBs behind it.
  Both resolve endpoint/project/key from the saved master AI Foundry config and are fail-soft → `[]`.
- `GET /admin/personas/{id}/knowledge` · `POST /admin/personas/{id}/knowledge` (attach + re-sync) ·
  `DELETE /admin/personas/knowledge/{config_id}` (detach + re-sync). Attach/detach reuse the router's
  existing `_sync` helper, which now loads the persona's KB configs and passes them to the adapter.

### Frontend
- `api/personaKnowledge.ts` — discovery + CRUD client.
- `components/agent-editor/ConnectKbDialog.tsx` — Fluent v9 dialog, two cascading `Dropdown`s
  (connection → knowledge base; KB disabled until a connection is picked).
- `KnowledgeStatus.tsx` → `KnowledgeSection.tsx` — per-persona list (badge + Remove per KB) +
  "Connect knowledge base"; a not-yet-saved persona prompts to save first (no id to attach against).
  `AgentEditorPage` passes `personaId={isNew ? null : current?.id}`.
- KB configs are a **separate sub-resource** (own endpoints + immediate re-sync); they do NOT ride
  the persona Save payload.

## Behavior change

Existing personas start with **zero** attached KBs — the global KB no longer auto-grounds every
agent. An admin re-attaches KBs per persona via the dialog. F1 SOP scoring retrieval is unaffected.

## Verification

1. Backend gate: `cd backend && ruff check app tests && ruff format --check app tests &&
   alembic upgrade head && pytest -q` (≥85%). New service + model at 100%; mock-only sync still
   works with no azure extra.
2. Frontend gate: `cd frontend && npx tsc --noEmit && npm run test && npm run lint`.
3. UI: `/admin/agent` (admin) → persona → Knowledge → Connect knowledge base → connection + KB
   dropdowns populate from live Azure → add → KB listed, persona re-syncs → remove works.
4. **Live Azure** (real resources): after attaching a KB, the persona's Foundry agent version
   carries an MCPTool for that KB (via `agents.get` / the Portal Knowledge section) and a
   RemoteTool connection `kb-…` exists; a persona with no KB syncs ungrounded.
