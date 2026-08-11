/**
 * Agent tool catalog for the /admin/agent editor — mirrors the Azure AI Foundry portal's
 * "Select a tool" dialog (Configured / Catalog / Custom tabs).
 *
 * Execution happens in the Foundry runtime; this app only carries the tool config and syncs it into
 * the persona's Foundry prompt agent. Tools split into two tiers:
 *   - **supported** (tier A): this app can actually emit them to Foundry today (no connection auth):
 *     code_interpreter, web_search, and a public MCP server. Selecting them really syncs.
 *   - **preview** (tier B): shown as cards for portal parity, but not yet wired to sync (they need
 *     connection auth / spec parsing / a Microsoft-hosted backend). Selecting is disabled.
 *
 * The persona's tools are stored as a JSON array in `tools_config`; each entry is a `ToolConfig`.
 */

/** One configured tool on a persona (serialized into persona.tools_config). */
export interface ToolConfig {
  type: string;
  // MCP-only fields (public server): label + URL + optional allow-list.
  server_label?: string;
  server_url?: string;
  allowed_tools?: string[];
}

export type ToolTab = "configured" | "catalog" | "custom";

/** A catalog entry rendered as a card in the picker. */
export interface ToolCatalogEntry {
  /** Tool `type` written into ToolConfig when selected. */
  id: string;
  label: string;
  description: string;
  tab: ToolTab;
  /** True → really syncs to Foundry today; false → shown for parity but selection disabled. */
  supported: boolean;
  /** True → carries the "Preview" badge (portal parity + our not-yet-wired tools). */
  preview: boolean;
  /** MCP/OpenAPI/A2A need a small config form before they can be added. */
  needsConfig?: boolean;
}

// Tier-A ids this app really syncs (must match backend persona_tools.SUPPORTED_TOOL_TYPES).
export const SUPPORTED_TOOL_IDS = new Set(["code_interpreter", "web_search", "mcp"]);

/**
 * The full portal card set. `supported` entries sync for real; the rest are parity placeholders
 * carrying a Preview badge and a disabled selection.
 */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  // --- Configured tab (the portal's ready-to-use tools) ---
  {
    id: "code_interpreter",
    label: "Code interpreter",
    description: "Enable agents to write and run Python code in a sandboxed execution environment.",
    tab: "configured",
    supported: true,
    preview: false,
  },
  {
    id: "web_search",
    label: "Web search",
    description: "Search the Internet for sources related to the prompt.",
    tab: "configured",
    supported: true,
    preview: false,
  },
  {
    id: "file_search",
    label: "File search",
    description: "Augment agents with knowledge from outside its model, such as proprietary data.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "azure_ai_search",
    label: "Azure AI Search",
    description: "Use an existing Azure AI Search index to ground agents with data in the index.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "bing_grounding",
    label: "Grounding with Bing Search",
    description: "Enable your agent to use Grounding with Bing Search to access and return web data.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "bing_custom_search",
    label: "Grounding with Bing Custom Search",
    description: "Enhance model output with data from selected web domains.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "computer_use",
    label: "Computer Use",
    description: "Enables performing tasks by interacting with computer systems and applications.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "work_iq",
    label: "Work IQ",
    description: "Connect to your Microsoft 365 Copilot data to query emails, meetings, and more.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "fabric_iq",
    label: "Fabric IQ (OneLake Catalog)",
    description: "Select OneLake items to ground your agent in the state of your business.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "fabric_data_agent",
    label: "Fabric Data Agent",
    description: "Integrate your agent with the Fabric Data Agent to unlock powerful data analysis.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  {
    id: "sharepoint",
    label: "SharePoint",
    description: "Securely integrate and manage internal data.",
    tab: "configured",
    supported: false,
    preview: true,
  },
  // --- Custom tab (bring-your-own endpoints) ---
  {
    id: "openapi",
    label: "OpenAPI tool",
    description: "Connect your Azure AI Agent to external APIs using functions with an OpenAPI spec.",
    tab: "custom",
    supported: false,
    preview: true,
    needsConfig: true,
  },
  {
    id: "mcp",
    label: "Model Context Protocol (MCP)",
    description: "Give the agent access to tools hosted on an existing MCP endpoint.",
    tab: "custom",
    supported: true,
    preview: false,
    needsConfig: true,
  },
  {
    id: "a2a",
    label: "Agent2agent (A2A)",
    description: "Connect another agent to call as a tool (agent-to-agent).",
    tab: "custom",
    supported: false,
    preview: true,
    needsConfig: true,
  },
];

export const TOOL_CATALOG_BY_ID: ReadonlyMap<string, ToolCatalogEntry> = new Map(
  TOOL_CATALOG.map((t) => [t.id, t]),
);

/** Human label for a configured tool (falls back to its raw type). */
export function toolLabel(type: string): string {
  return TOOL_CATALOG_BY_ID.get(type)?.label ?? type;
}

/** Parse persona.tools_config JSON into a ToolConfig[] (tolerant: bad JSON → []). */
export function parseToolsConfig(json: string | null | undefined): ToolConfig[] {
  if (!json) return [];
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    return data.filter((t): t is ToolConfig => t && typeof t === "object" && typeof t.type === "string");
  } catch {
    return [];
  }
}

/** Serialize ToolConfig[] back to a JSON string for persona.tools_config. */
export function stringifyToolsConfig(tools: ToolConfig[]): string {
  return JSON.stringify(tools);
}
