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
                # A persona MCP requires approval by default — untrusted candidate conversation.
                "require_approval": "always",
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

    def test_mcp_rejects_non_http_schemes(self):
        # Only http(s) URLs sync; file:/gopher:/etc. are dropped (SSRF foot-gun guard).
        assert gate_supported_tools([{"type": "mcp", "server_url": "file:///etc/passwd"}]) == []
        assert gate_supported_tools([{"type": "mcp", "server_url": "ftp://x/mcp"}]) == []
        assert gate_supported_tools([{"type": "mcp", "server_url": "javascript:alert(1)"}]) == []

    def test_mcp_accepts_http_and_https(self):
        got = gate_supported_tools(
            [
                {"type": "mcp", "server_url": "http://a/mcp"},
                {"type": "mcp", "server_url": "https://b/mcp"},
            ]
        )
        assert [t["server_url"] for t in got] == ["http://a/mcp", "https://b/mcp"]

    def test_non_string_fields_do_not_raise(self):
        # Tolerant by design: non-string server_url/label/allowed_tools are treated as absent.
        assert gate_supported_tools([{"type": "mcp", "server_url": ["x"]}]) == []
        assert gate_supported_tools([{"type": "mcp", "server_url": 123}]) == []
        got = gate_supported_tools(
            [{"type": "mcp", "server_url": "https://x/mcp", "server_label": 42}]
        )
        assert got[0]["server_label"] == "custom-mcp"  # non-string label → default
        got2 = gate_supported_tools(
            [{"type": "mcp", "server_url": "https://x/mcp", "allowed_tools": "not-a-list"}]
        )
        assert "allowed_tools" not in got2[0]

    def test_dedupes_simple_and_mcp_tools(self):
        got = gate_supported_tools(
            [
                {"type": "code_interpreter"},
                {"type": "code_interpreter"},
                {"type": "web_search"},
                {"type": "mcp", "server_url": "https://x/mcp"},
                {"type": "mcp", "server_url": "https://x/mcp"},  # dup URL
            ]
        )
        assert [t["type"] for t in got] == ["code_interpreter", "web_search", "mcp"]

    def test_require_approval_clamped_to_known_mode(self):
        got = gate_supported_tools(
            [{"type": "mcp", "server_url": "https://x/mcp", "require_approval": "sometimes"}]
        )
        assert got[0]["require_approval"] == "always"  # unknown mode → safe default (always)
        ok = gate_supported_tools(
            [{"type": "mcp", "server_url": "https://y/mcp", "require_approval": "never"}]
        )
        assert ok[0]["require_approval"] == "never"  # explicit override respected


class TestBuildPersonaTools:
    def test_parse_plus_gate_end_to_end(self):
        cfg = (
            '[{"type":"code_interpreter"},{"type":"openapi"},'
            '{"type":"mcp","server_url":"https://x/mcp"}]'
        )
        got = build_persona_tools(cfg)
        assert [t["type"] for t in got] == ["code_interpreter", "mcp"]
