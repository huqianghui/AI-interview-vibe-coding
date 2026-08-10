"""Foundry IQ connection discovery + RemoteTool connection creation (SPEC F1/P15/P16, Phase 2.2).

This is the piece that lets the interviewer agent actually **obtain a usable
``project_connection_id``** for its knowledge-base MCPTool. Without it, ``knowledge_tool`` can
only take a connection id as an opaque string it has no way to produce — so a KB either arrives
pre-wired in the Portal or the MCPTool fails auth at runtime (403). Ported from the reference
``knowledge_base_service``, decoupled from that project's per-HCP config CRUD and right-sized to
this project's single SOP knowledge base.

Two capabilities:

1. **Discovery (read):** list the project's AI Search connections and the Foundry IQ knowledge
   bases behind them. **Wired:** the admin config KB dropdown (``admin_config.list_knowledge_bases``)
   calls :func:`list_knowledge_bases` to populate from the real resource.
2. **RemoteTool find-or-create (write):** resolve the KB's MCPTool auth. MCPTool auth requires a
   **RemoteTool** project connection, NOT a CognitiveSearch/ApiKey connection (which 403s). The
   Portal does not always pre-create that RemoteTool connection for a KB, so we find an existing
   one (by metadata or normalized MCP target) and, failing that, create one via the ARM control
   plane (the data-plane connections API has no create — PUT/POST return 405). **Deferred to
   Phase 3 (#29):** wiring :func:`resolve_remote_tool_connection` into ``azure_agent_sync`` so a
   persona sync auto-resolves/creates the connection id — that path performs an ARM *write* per
   sync, so it lands with the editor UI that actually triggers a persona sync, not before. Until
   then the adapter takes the connection id from the ``foundry_kb_mcp_connection`` setting.

Auth: discovery uses the project client (Entra-first via :mod:`foundry_client`); Search
data-plane and ARM calls use Entra bearers from :mod:`azure_auth` (never a stored secret). All
live SDK/HTTP paths are coverage-omitted; the pure helpers below are unit-tested.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import Any

from app.services.agents.knowledge_tool import SEARCH_API_VERSION, build_kb_mcp_url
from app.services.azure_auth import ARM_SCOPE, SEARCH_SCOPE, get_bearer_token

logger = logging.getLogger(__name__)

# ARM control-plane API version for Microsoft.CognitiveServices/accounts/projects/connections.
CONNECTIONS_ARM_API_VERSION = "2026-03-01"


# --- pure helpers (unit-tested, no Azure) ------------------------------------


def _get_field(obj: Any, *names: str, default: Any = "") -> Any:
    """Read a field from an SDK model or dict response, trying several possible names."""
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj[name]
        if hasattr(obj, name):
            value = getattr(obj, name)
            if value is not None:
                return value
    return default


def _extract_api_key(credentials: Any) -> str:
    """Extract an API key from the possible Foundry connection credential shapes."""
    if not credentials:
        return ""
    for name in ("api_key", "apiKey", "key"):
        value = _get_field(credentials, name)
        if value:
            return str(value)
    keys = _get_field(credentials, "keys", default=None)
    if isinstance(keys, dict):
        for value in keys.values():
            if value:
                return str(value)
    if isinstance(keys, list):
        for item in keys:
            value = _get_field(item, "value", "key", "apiKey")
            if value:
                return str(value)
    return ""


def _normalize_mcp_endpoint(url: str) -> str:
    """Normalize an MCP endpoint URL for equality comparison.

    Strips the query string (``api-version`` may legitimately differ between an older
    Portal-created connection and our current one), trailing slash, and case, so target-based
    matching isn't fooled by cosmetic differences.
    """
    if not url:
        return ""
    return url.split("?", 1)[0].rstrip("/").lower()


def _kb_name_from_target(target: str) -> str:
    """Best-effort extraction of the KB index name from a connection target URL."""
    match = re.search(r"/knowledgebases/([^/?]+)", target, flags=re.IGNORECASE)
    return match.group(1) if match else ""


def remote_tool_connection_name(index_name: str) -> str:
    """Build a stable, ARM-legal RemoteTool connection name for a KB index.

    Deterministic: the same ``index_name`` always yields the same name, so a repeated ARM PUT is an
    idempotent update, not a duplicate connection. A short content-hash suffix guards against two
    different KB names sanitizing to the same prefix.
    """
    sanitized = re.sub(r"[^a-zA-Z0-9-]", "-", index_name.strip().lower())
    sanitized = re.sub(r"-+", "-", sanitized).strip("-")
    suffix = hashlib.sha1(index_name.encode("utf-8")).hexdigest()[:6]
    base = f"kb-{sanitized}" if sanitized else "kb"
    max_base_len = 63 - len(suffix) - 1
    return f"{base[:max_base_len]}-{suffix}"


def parse_arm_components(connection_id: str) -> dict[str, str]:
    """Parse subscription/resource-group/account/project from a connection's ARM resource id.

    ARM id shape:
    ``/subscriptions/{sub}/resourceGroups/{rg}/providers/.../accounts/{name}/projects/{proj}/...``
    Returns an empty dict when the id doesn't match (e.g. a data-plane-only connection).
    """
    match = re.search(
        r"/subscriptions/([^/]+)/resourceGroups/([^/]+)"
        r"/providers/[^/]+/[^/]+/([^/]+)/projects/([^/]+)",
        connection_id or "",
    )
    if not match:
        return {}
    sub_id, rg, resource_name, project_name = match.groups()
    return {
        "subscription_id": sub_id,
        "resource_group": rg,
        "resource_name": resource_name,
        "project_name": project_name,
    }


def build_remote_tool_arm_request(
    components: dict[str, str],
    *,
    connection_name: str,
    mcp_url: str,
    index_name: str,
) -> tuple[str, dict[str, Any]]:
    """Build the (ARM URL, request body) for creating a KB RemoteTool connection.

    Pure so the ARM contract (``category=RemoteTool``, ``authType=ProjectManagedIdentity`` — no
    stored secret; the project's managed identity authenticates to the KB MCP endpoint) is
    verifiable without a live call. ``audience`` is the Search resource. Raises ``ValueError`` when
    a required ARM component is missing.
    """
    required = ("subscription_id", "resource_group", "resource_name", "project_name")
    if not all(components.get(k) for k in required):
        raise ValueError(
            f"Cannot build RemoteTool connection for KB {index_name!r}: incomplete ARM components "
            f"{sorted(k for k in required if not components.get(k))}."
        )
    resource_id = (
        f"/subscriptions/{components['subscription_id']}"
        f"/resourceGroups/{components['resource_group']}"
        f"/providers/Microsoft.CognitiveServices/accounts/{components['resource_name']}"
        f"/projects/{components['project_name']}"
        f"/connections/{connection_name}"
    )
    url = f"https://management.azure.com{resource_id}?api-version={CONNECTIONS_ARM_API_VERSION}"
    body: dict[str, Any] = {
        "name": connection_name,
        "type": "Microsoft.CognitiveServices/accounts/projects/connections",
        "properties": {
            "category": "RemoteTool",
            "target": mcp_url,
            "authType": "ProjectManagedIdentity",
            "isSharedToAll": True,
            "audience": "https://search.azure.com/",
            "metadata": {"type": "knowledgeBase_MCP", "knowledgeBaseName": index_name},
        },
    }
    return url, body


# --- live discovery (coverage-omitted) ---------------------------------------


async def _search_auth_headers(search_key: str) -> dict[str, str]:  # pragma: no cover
    """Search data-plane auth headers — API key when present, else an Entra bearer."""
    if search_key:
        return {"api-key": search_key}
    token = await get_bearer_token(SEARCH_SCOPE)
    if not token:
        raise RuntimeError(
            "Azure AI Search uses Entra ID but no Search token could be acquired "
            "(run 'az login' or grant the identity Search access)."
        )
    return {"Authorization": f"Bearer {token}"}


async def _get_knowledgebases(  # pragma: no cover
    search_endpoint: str, search_key: str
) -> list[dict]:
    """List Foundry IQ knowledge bases from an AI Search endpoint (Entra ID or API key)."""
    import httpx

    endpoint = search_endpoint.rstrip("/")
    headers = await _search_auth_headers(search_key)
    async with httpx.AsyncClient(timeout=15) as http:
        resp = await http.get(
            f"{endpoint}/knowledgebases",
            params={"api-version": SEARCH_API_VERSION},
            headers=headers,
        )
        if resp.status_code in (401, 403) and search_key:
            logger.info(
                "Search KB API rejected key auth (%d); retrying with Entra", resp.status_code
            )
            resp = await http.get(
                f"{endpoint}/knowledgebases",
                params={"api-version": SEARCH_API_VERSION},
                headers=await _search_auth_headers(""),
            )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Foundry IQ knowledgebases API returned {resp.status_code}: {resp.text[:300]}"
        )
    value = resp.json().get("value", [])
    return value if isinstance(value, list) else []


async def list_search_connections(  # pragma: no cover
    *, endpoint: str, project: str, api_key: str = ""
) -> list[dict]:
    """List the project's Azure AI Search connections (name, target, is_default).

    Returns an empty list if the SDK is not installed or discovery fails (discovery is best-effort
    — the admin UI degrades to a text input, it does not error).
    """
    try:
        import asyncio

        from azure.ai.projects.models import ConnectionType

        from app.services.agents.foundry_client import build_project_client, project_endpoint

        # build_project_client does a synchronous Entra probe (get_token — a network round-trip,
        # or an az-CLI subprocess on local dev), so it must run off the event loop like the SDK
        # calls below it.
        client = await asyncio.to_thread(
            build_project_client, project_endpoint(endpoint, project), api_key
        )
        connections = await asyncio.to_thread(
            client.connections.list, connection_type=ConnectionType.AZURE_AI_SEARCH
        )
        return [
            {
                "name": _get_field(c, "name"),
                "target": _get_field(c, "target"),
                "is_default": bool(_get_field(c, "is_default", "isDefault", default=False)),
            }
            for c in connections
        ]
    except ImportError:
        logger.info("azure-ai-projects not installed; no search connections")
        return []
    except Exception as exc:  # noqa: BLE001 — discovery is best-effort
        logger.warning("Failed to list search connections: %s", exc)
        return []


async def list_knowledge_bases(  # pragma: no cover
    *, endpoint: str, project: str, api_key: str = "", connection_name: str = ""
) -> list[dict]:
    """List Foundry IQ knowledge bases behind an AI Search connection (name, description, …).

    Resolves the connection's Search endpoint + key via ``connections.get`` (with credentials)
    then calls the Search data-plane REST API directly (the Portal path; ``indexes.list`` needs
    workspace perms and 403s). Uses the default AI Search connection when ``connection_name`` is
    empty. Best-effort: returns an empty list on any failure.
    """
    try:
        import asyncio

        from azure.ai.projects.models import ConnectionType

        from app.services.agents.foundry_client import build_project_client, project_endpoint

        # Off the event loop: build_project_client's Entra probe is a blocking network/az-CLI call.
        client = await asyncio.to_thread(
            build_project_client, project_endpoint(endpoint, project), api_key
        )
        if connection_name:
            conn = await asyncio.to_thread(
                client.connections.get, name=connection_name, include_credentials=True
            )
        else:
            conns = list(
                await asyncio.to_thread(
                    client.connections.list, connection_type=ConnectionType.AZURE_AI_SEARCH
                )
            )
            if not conns:
                return []
            chosen = next((c for c in conns if getattr(c, "is_default", False)), conns[0])
            conn = await asyncio.to_thread(
                client.connections.get, name=_get_field(chosen, "name"), include_credentials=True
            )

        search_endpoint = str(_get_field(conn, "target")).rstrip("/")
        if not search_endpoint:
            logger.warning("AI Search connection missing endpoint")
            return []
        search_key = _extract_api_key(_get_field(conn, "credentials", default=None))
        kbs = await _get_knowledgebases(search_endpoint, search_key)
        return [
            {
                "name": kb.get("name", ""),
                "version": kb.get("version"),
                "type": kb.get("type"),
                "description": kb.get("description", kb.get("name", "")),
            }
            for kb in kbs
        ]
    except ImportError:
        logger.info("azure-ai-projects not installed; no knowledge bases")
        return []
    except Exception as exc:  # noqa: BLE001 — discovery is best-effort
        logger.warning("Failed to list knowledge bases: %s", exc)
        return []


async def resolve_remote_tool_connection(  # pragma: no cover
    *,
    endpoint: str,
    project: str,
    api_key: str = "",
    search_target: str,
    index_name: str,
    create_if_missing: bool = True,
) -> str | None:
    """Find (or create) the RemoteTool connection that authenticates a KB's MCPTool.

    Returns the RemoteTool connection **name** to pass as ``project_connection_id``, or ``None``
    when no connection exists and ``create_if_missing`` is False (or the SDK is unavailable).

    Matching order: (1) an existing RemoteTool connection whose ``metadata.knowledgeBaseName`` is
    this KB; (2) one whose normalized MCP target equals this KB's MCP endpoint (handles Portal-made
    connections without our metadata). Only when neither matches and ``create_if_missing`` do we
    create one via ARM. A creation failure **raises** — a KB that can't bind to an authenticated
    connection must never be reported as a successfully grounded agent.
    """
    if not (search_target and index_name):
        return None
    try:
        import asyncio

        from app.services.agents.foundry_client import build_project_client, project_endpoint

        # Off the event loop: build_project_client's Entra probe is a blocking network/az-CLI call.
        client = await asyncio.to_thread(
            build_project_client, project_endpoint(endpoint, project), api_key
        )
        connections = list(await asyncio.to_thread(client.connections.list))
    except ImportError:
        logger.info("azure-ai-projects not installed; cannot resolve RemoteTool connection")
        return None

    expected = _normalize_mcp_endpoint(build_kb_mcp_url(search_target, index_name))
    by_target: dict[str, str] = {}
    for conn in connections:
        if _get_field(conn, "type") != "RemoteTool":
            continue
        conn_name = _get_field(conn, "name")
        metadata = _get_field(conn, "metadata", default={})
        kb_name = _get_field(metadata, "knowledgeBaseName") or _kb_name_from_target(
            str(_get_field(conn, "target"))
        )
        if kb_name == index_name and conn_name:
            logger.info("Matched RemoteTool '%s' for KB '%s' by metadata", conn_name, index_name)
            return conn_name
        norm = _normalize_mcp_endpoint(str(_get_field(conn, "target")))
        if norm and conn_name:
            by_target[norm] = conn_name

    if expected and expected in by_target:
        logger.info(
            "Matched RemoteTool '%s' for KB '%s' by target URL", by_target[expected], index_name
        )
        return by_target[expected]

    if not create_if_missing:
        return None

    # No match — create via ARM. Derive ARM components from any connection's resource id.
    components: dict[str, str] = {}
    for conn in connections:
        components = parse_arm_components(str(_get_field(conn, "id")))
        if components:
            break
    if not components:
        raise RuntimeError(
            f"Cannot create RemoteTool connection for KB {index_name!r}: no connection carried an "
            "ARM resource id to derive subscription/resource-group/account/project."
        )
    return await _create_remote_tool_connection(
        components=components, search_target=search_target, index_name=index_name
    )


async def _create_remote_tool_connection(  # pragma: no cover
    *, components: dict[str, str], search_target: str, index_name: str
) -> str:
    """Create a KB RemoteTool connection via the ARM control plane, authenticated with Entra.

    ``authType=ProjectManagedIdentity`` stores no secret — the Foundry project's managed identity
    authenticates to the KB MCP endpoint at request time. Raises on any non-2xx / missing token.
    """
    import httpx

    token = await get_bearer_token(ARM_SCOPE)
    if not token:
        raise RuntimeError(
            f"Cannot create RemoteTool connection for KB {index_name!r}: no Entra token for ARM "
            "(configure Managed Identity or run 'az login', with Contributor on the project)."
        )
    connection_name = remote_tool_connection_name(index_name)
    mcp_url = build_kb_mcp_url(search_target, index_name)
    url, body = build_remote_tool_arm_request(
        components, connection_name=connection_name, mcp_url=mcp_url, index_name=index_name
    )
    async with httpx.AsyncClient(timeout=30) as http:
        resp = await http.put(url, json=body, headers={"Authorization": f"Bearer {token}"})
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"Failed to create RemoteTool connection '{connection_name}' for KB {index_name!r} "
            f"via ARM: {resp.status_code} {resp.text[:300]}"
        )
    logger.info(
        "Created RemoteTool connection '%s' for KB '%s' via ARM", connection_name, index_name
    )
    return connection_name
