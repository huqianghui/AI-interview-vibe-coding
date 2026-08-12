/** agentTools pure helpers: tolerant parse, round-trip stringify, label lookup fallback. */
import { describe, expect, it } from "vitest";
import { parseToolsConfig, stringifyToolsConfig, toolLabel } from "./agentTools";

describe("parseToolsConfig", () => {
  it("returns [] for null/undefined/empty input", () => {
    expect(parseToolsConfig(null)).toEqual([]);
    expect(parseToolsConfig(undefined)).toEqual([]);
    expect(parseToolsConfig("")).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseToolsConfig("not json")).toEqual([]);
    expect(parseToolsConfig("{oops")).toEqual([]);
  });

  it("returns [] when the top level isn't an array", () => {
    expect(parseToolsConfig('{"type":"mcp"}')).toEqual([]);
  });

  it("filters out non-object entries and entries missing a string type", () => {
    const got = parseToolsConfig('["x", 3, null, {"no":"type"}, {"type":1}, {"type":"web_search"}]');
    expect(got).toEqual([{ type: "web_search" }]);
  });

  it("parses a well-formed list of tool configs", () => {
    const got = parseToolsConfig('[{"type":"code_interpreter"},{"type":"mcp","server_url":"https://x"}]');
    expect(got).toEqual([
      { type: "code_interpreter" },
      { type: "mcp", server_url: "https://x" },
    ]);
  });
});

describe("stringifyToolsConfig", () => {
  it("round-trips with parseToolsConfig", () => {
    const tools = [{ type: "web_search" }, { type: "mcp", server_url: "https://x", server_label: "s" }];
    expect(parseToolsConfig(stringifyToolsConfig(tools))).toEqual(tools);
  });

  it("serializes an empty list to '[]'", () => {
    expect(stringifyToolsConfig([])).toBe("[]");
  });
});

describe("toolLabel", () => {
  it("resolves a known tool type to its catalog label", () => {
    expect(toolLabel("code_interpreter")).toBe("Code interpreter");
    expect(toolLabel("mcp")).toBe("Model Context Protocol (MCP)");
  });

  it("falls back to the raw type string for an unknown id", () => {
    expect(toolLabel("some_future_tool")).toBe("some_future_tool");
  });
});
