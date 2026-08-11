"""Persona agent-tools parsing + support gating (pure, no Azure)."""

from app.services.agents.persona_tools import (
    build_persona_tools,
    gate_supported_tools,
    parse_persona_tools,
)


class TestParse:
    def test_empty_or_none_yields_empty(self):
        assert parse_persona_tools(None) == []
        assert parse_persona_tools("") == []
        assert parse_persona_tools("[]") == []

    def test_malformed_json_yields_empty(self):
        assert parse_persona_tools("not json") == []
        assert parse_persona_tools("{oops") == []

    def test_non_list_top_level_yields_empty(self):
        assert parse_persona_tools('{"type": "mcp"}') == []

    def test_skips_non_dict_and_typeless_entries(self):
        got = parse_persona_tools('["x", 3, {"no": "type"}, {"type": "web_search"}]')
        assert got == [{"type": "web_search"}]


class TestGate:
    def test_keeps_code_interpreter_and_web_search_minimal(self):
        got = gate_supported_tools(
            [{"type": "code_interpreter", "extra": 1}, {"type": "web_search"}]
        )
        assert got == [{"type": "code_interpreter"}, {"type": "web_search"}]

    def test_drops_unsupported_types(self):
        got = gate_supported_tools(
            [
                {"type": "openapi"},
                {"type": "a2a"},
                {"type": "bing_grounding"},
                {"type": "sharepoint"},
            ]
        )
        assert got == []

    def test_mcp_requires_server_url(self):
        assert gate_supported_tools([{"type": "mcp"}]) == []
        assert gate_supported_tools([{"type": "mcp", "server_url": "   "}]) == []

    def test_mcp_normalized_with_defaults(self):
        got = gate_supported_tools([{"type": "mcp", "server_url": "https://mcp.example.com"}])
        assert got == [
            {
                "type": "mcp",
                "server_label": "custom-mcp",
                "server_url": "https://mcp.example.com",
                "require_approval": "never",
            }
        ]

    def test_mcp_keeps_label_and_allowed_tools(self):
        got = gate_supported_tools(
            [
                {
                    "type": "mcp",
                    "server_label": "my-server",
                    "server_url": "https://x/mcp",
                    "allowed_tools": ["search", "fetch"],
                }
            ]
        )
        assert got[0]["server_label"] == "my-server"
        assert got[0]["allowed_tools"] == {"tool_names": ["search", "fetch"]}

    def test_mcp_ignores_project_connection_id_from_input(self):
        # Public-server only path: an injected connection id is not carried through the gate.
        got = gate_supported_tools(
            [{"type": "mcp", "server_url": "https://x/mcp", "project_connection_id": "conn-1"}]
        )
        assert "project_connection_id" not in got[0]


class TestBuildPersonaTools:
    def test_parse_plus_gate_end_to_end(self):
        cfg = (
            '[{"type":"code_interpreter"},{"type":"openapi"},'
            '{"type":"mcp","server_url":"https://x/mcp"}]'
        )
        got = build_persona_tools(cfg)
        assert [t["type"] for t in got] == ["code_interpreter", "mcp"]
