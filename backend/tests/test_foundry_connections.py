"""Unit tests for the pure helpers in foundry_connections (Phase 2.2) — zero Azure.

The live discovery/ARM paths are coverage-omitted (need the SDK + a live endpoint); these tests
pin the contract-critical pure logic: RemoteTool naming stability, ARM-id parsing, MCP-endpoint
normalization, and the ARM request shape (category/authType/audience/metadata) that decides
whether the KB's MCPTool authenticates at all.
"""

import pytest

from app.services.agents.foundry_connections import (
    CONNECTIONS_ARM_API_VERSION,
    _extract_api_key,
    _get_field,
    _kb_name_from_target,
    _normalize_mcp_endpoint,
    build_remote_tool_arm_request,
    parse_arm_components,
    remote_tool_connection_name,
)


class TestGetField:
    def test_reads_dict_then_attr_with_name_fallbacks(self):
        assert _get_field({"is_default": True}, "is_default", "isDefault") is True

        class Obj:
            isDefault = True

        assert _get_field(Obj(), "is_default", "isDefault") is True

    def test_default_when_absent(self):
        assert _get_field({}, "name", default="x") == "x"


class TestExtractApiKey:
    def test_flat_key_names(self):
        assert _extract_api_key({"apiKey": "k1"}) == "k1"
        assert _extract_api_key({"key": "k2"}) == "k2"

    def test_keys_dict_and_list(self):
        assert _extract_api_key({"keys": {"key1": "v"}}) == "v"
        assert _extract_api_key({"keys": [{"value": "lv"}]}) == "lv"

    def test_empty(self):
        assert _extract_api_key(None) == ""
        assert _extract_api_key({}) == ""


class TestNormalizeMcpEndpoint:
    def test_strips_query_slash_and_case(self):
        a = _normalize_mcp_endpoint(
            "https://S.search.windows.net/knowledgebases/KB/mcp?api-version=1"
        )
        b = _normalize_mcp_endpoint("https://s.search.windows.net/knowledgebases/KB/mcp/")
        # api-version differences and trailing slash must not defeat matching; case is lowered.
        assert a == b == "https://s.search.windows.net/knowledgebases/kb/mcp"

    def test_empty(self):
        assert _normalize_mcp_endpoint("") == ""


class TestKbNameFromTarget:
    def test_extracts_index(self):
        assert _kb_name_from_target("https://x/knowledgebases/my-kb/mcp?api-version=1") == "my-kb"

    def test_no_match(self):
        assert _kb_name_from_target("https://x/indexes/foo") == ""


class TestRemoteToolConnectionName:
    def test_deterministic_and_arm_legal(self):
        n1 = remote_tool_connection_name("Omada Product Params")
        n2 = remote_tool_connection_name("Omada Product Params")
        assert n1 == n2  # deterministic → idempotent ARM PUT
        assert len(n1) <= 63
        assert all(c.isalnum() or c == "-" for c in n1)
        assert n1.startswith("kb-")

    def test_distinct_inputs_distinct_names(self):
        assert remote_tool_connection_name("kb-a") != remote_tool_connection_name("kb-b")

    def test_empty_index_still_legal(self):
        n = remote_tool_connection_name("")
        assert n.startswith("kb-") and len(n) <= 63


class TestParseArmComponents:
    def test_parses_full_id(self):
        conn_id = (
            "/subscriptions/sub-123/resourceGroups/rg1/providers/Microsoft.CognitiveServices"
            "/accounts/acct/projects/proj/connections/c1"
        )
        assert parse_arm_components(conn_id) == {
            "subscription_id": "sub-123",
            "resource_group": "rg1",
            "resource_name": "acct",
            "project_name": "proj",
        }

    def test_returns_empty_on_no_match(self):
        assert parse_arm_components("") == {}
        assert parse_arm_components("/data-plane/only") == {}


class TestBuildRemoteToolArmRequest:
    COMPONENTS = {
        "subscription_id": "sub-1",
        "resource_group": "rg",
        "resource_name": "acct",
        "project_name": "proj",
    }

    def test_url_and_contract_shape(self):
        url, body = build_remote_tool_arm_request(
            self.COMPONENTS,
            connection_name="kb-x-abc123",
            mcp_url="https://s/knowledgebases/x/mcp?api-version=1",
            index_name="x",
        )
        assert url == (
            "https://management.azure.com/subscriptions/sub-1/resourceGroups/rg"
            "/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj"
            f"/connections/kb-x-abc123?api-version={CONNECTIONS_ARM_API_VERSION}"
        )
        props = body["properties"]
        # These four values are what make the MCPTool authenticate (vs a 403 ApiKey connection).
        assert props["category"] == "RemoteTool"
        assert props["authType"] == "ProjectManagedIdentity"
        assert props["audience"] == "https://search.azure.com/"
        assert props["metadata"] == {"type": "knowledgeBase_MCP", "knowledgeBaseName": "x"}
        assert props["target"] == "https://s/knowledgebases/x/mcp?api-version=1"

    def test_raises_on_incomplete_components(self):
        with pytest.raises(ValueError, match="incomplete ARM components"):
            build_remote_tool_arm_request(
                {"subscription_id": "sub-1"},
                connection_name="kb-x",
                mcp_url="https://s/knowledgebases/x/mcp",
                index_name="x",
            )
