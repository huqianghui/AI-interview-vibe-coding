/**
 * Per-persona Foundry IQ knowledge-base admin API client (SPEC F5).
 *
 * Backs the Agent editor's Knowledge section: discover the project's Azure AI Search connections
 * and their Foundry IQ knowledge bases (live Azure dropdowns), then attach/detach KBs on a persona.
 * Each attach/detach re-syncs the persona's Foundry prompt agent server-side (an MCPTool per KB).
 * Reuses `admin.ts`'s `adminRequest` so these authenticate like every other admin surface.
 */
import { adminRequest } from "./admin";

/** A dropdown option from the knowledge-bases discovery endpoint ({value,label}, backend Option). */
export interface KbOption {
  value: string;
  label: string;
}

/** An Azure AI Search connection (matches backend KbConnectionOut). `target` is persisted as the
 * config's `connection_target`. */
export interface KbConnection {
  name: string;
  target: string;
  is_default: boolean;
}

/** A knowledge base attached to a persona (matches PersonaKnowledgeOut). */
export interface PersonaKnowledgeConfig {
  id: string;
  persona_id: string;
  connection_name: string;
  connection_target: string;
  index_name: string;
  server_label: string;
  is_enabled: boolean;
}

/** Body for attaching a KB (matches PersonaKnowledgeCreate). */
export interface PersonaKnowledgeCreate {
  connection_name: string;
  connection_target: string;
  index_name: string;
}

/** List the project's Azure AI Search connections (for the connect dialog's first dropdown). */
export const listKbConnections = () =>
  adminRequest<KbConnection[]>("/admin/personas/knowledge/connections");

/** List the Foundry IQ knowledge bases behind a connection (second, cascading dropdown). */
export const listKnowledgeBases = (connectionName: string) =>
  adminRequest<KbOption[]>(
    `/admin/personas/knowledge/knowledge-bases?connection_name=${encodeURIComponent(connectionName)}`,
  );

/** List a persona's attached knowledge bases. */
export const listPersonaKnowledge = (personaId: string) =>
  adminRequest<PersonaKnowledgeConfig[]>(`/admin/personas/${personaId}/knowledge`);

/** Attach a KB to a persona (returns the updated list); the persona re-syncs server-side. */
export const addPersonaKnowledge = (personaId: string, body: PersonaKnowledgeCreate) =>
  adminRequest<PersonaKnowledgeConfig[]>(`/admin/personas/${personaId}/knowledge`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** Detach a KB by config id; the owning persona re-syncs server-side. */
export const removePersonaKnowledge = (configId: string) =>
  adminRequest<unknown>(`/admin/personas/knowledge/${configId}`, { method: "DELETE" });
