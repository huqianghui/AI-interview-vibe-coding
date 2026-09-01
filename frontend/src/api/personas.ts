/**
 * Interviewer-persona admin API client (SPEC F5, Phase 3). Backs the Foundry-style Agent editor.
 *
 * Reuses `admin.ts`'s `adminRequest` (shared admin bearer + error handling) so the persona routes
 * authenticate exactly like the other admin surfaces. The backend stores `voice_map`/`greeting_map`
 * as JSON **strings** (per-locale maps); this module keeps them as strings on the wire — the editor
 * parses/stringifies at its own edges (a persona has one string per map, parsed into a
 * `Record<locale, string>` for editing and stringified again on save).
 */
import { adminRequest } from "./admin";

/** Agent-sync lifecycle for a persona's Foundry prompt agent (mirrors backend AGENT_SYNC_STATUSES). */
export type AgentSyncStatus = "none" | "pending" | "synced" | "failed";

/** A persona as returned by the backend (matches PersonaOut in app/api/admin_personas.py). */
export interface PersonaOut {
  id: string;
  name: string;
  character: string;
  style: string;
  prompt_fragment: string;
  voice_map: string; // JSON string: {"zh-CN": "voiceName", ...}
  greeting_map: string; // JSON string: {"zh-CN": "greeting", ...}
  default_locale: string; // editor's remembered "Language" selector locale (view state, persisted)
  enabled: boolean;
  is_default: boolean;
  tools_config: string; // JSON string: array of tool config dicts synced to the Foundry agent
  turn_detection: string;
  eou_detection: boolean;
  noise_suppression: boolean;
  echo_cancellation: boolean;
  interim_response: boolean;
  proactive_engagement: boolean;
  voice_temperature: number;
  playback_speed: number;
  model: string | null; // per-persona Foundry model deployment ("" / null → global default)
  agent_id: string | null;
  agent_version: string | null;
  agent_sync_status: AgentSyncStatus;
  agent_sync_error: string | null;
  // Auto-generated instructions the backend pushes to Foundry when prompt_fragment is empty —
  // shown in the editor as the effective default so it matches what the Foundry Portal displays.
  default_instructions: string;
}

/** Fields accepted on create (server owns id + agent-sync bookkeeping). */
export type PersonaCreate = Omit<
  PersonaOut,
  "id" | "agent_id" | "agent_version" | "agent_sync_status" | "agent_sync_error" | "default_instructions"
>;

/** All fields optional on update (backend PersonaUpdate). */
export type PersonaUpdate = Partial<PersonaCreate>;

export const listPersonas = () => adminRequest<PersonaOut[]>("/admin/personas");

export const getPersona = (id: string) =>
  adminRequest<PersonaOut>(`/admin/personas/${id}`);

export const createPersona = (body: PersonaCreate) =>
  adminRequest<PersonaOut>("/admin/personas", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updatePersona = (id: string, changes: PersonaUpdate) =>
  adminRequest<PersonaOut>(`/admin/personas/${id}`, {
    method: "PUT",
    body: JSON.stringify(changes),
  });

export const setDefaultPersona = (id: string) =>
  adminRequest<PersonaOut>(`/admin/personas/${id}/set-default`, { method: "POST" });

export const retrySyncPersona = (id: string) =>
  adminRequest<PersonaOut>(`/admin/personas/${id}/retry-sync`, { method: "POST" });

/**
 * Pull the live Foundry agent's version + model into the persona when it has drifted (an operator
 * edited the agent in the Portal). Fired on editor open; fail-soft on the backend (an unavailable
 * agent leaves the persona untouched and still returns 200).
 */
export const reconcilePersona = (id: string) =>
  adminRequest<PersonaOut>(`/admin/personas/${id}/reconcile`, { method: "POST" });

// ── Local-map helpers (JSON string ⇄ Record) ──────────────────────────────

/** Parse a `voice_map`/`greeting_map` JSON string into a locale→value record; {} on bad input. */
export function parseLocaleMap(json: string): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Serialize a locale→value record back to the JSON string the backend stores. */
export function stringifyLocaleMap(map: Record<string, string>): string {
  return JSON.stringify(map ?? {});
}
