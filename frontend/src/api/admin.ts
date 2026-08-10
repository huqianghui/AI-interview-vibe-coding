/**
 * Admin API client (SPEC F2b/F3b). Separate from the candidate `client.ts`: admin routes
 * authenticate with a shared bearer token (entered in the admin page, held in memory +
 * sessionStorage), NOT the anonymous candidate session. Keeping this a dedicated fetch client
 * makes the "admin token never leaks onto a candidate call" boundary structural.
 */

const BASE = "/api";
const ADMIN_TOKEN_KEY = "admin_api_token";

export function getAdminToken(): string {
  return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "" : "";
}

export function setAdminToken(token: string): void {
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export class AdminApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${getAdminToken()}`);
  const resp = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new AdminApiError(`${resp.status} ${resp.statusText}: ${detail}`, resp.status);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

// ── Question banks (F2b) ───────────────────────────────────────────────

export interface Bank {
  bank_id: string;
  name: string;
  description: string;
  language: string;
  enabled: boolean;
  is_default: boolean;
}

export interface AdminQuestion {
  question_id: string;
  text: string;
  language: string;
  order_index: number;
  enabled: boolean;
  expected_points: string[];
  max_follow_ups: number;
}

export const listBanks = () => adminRequest<Bank[]>("/admin/question-banks");

export const createBank = (name: string, isDefault: boolean) =>
  adminRequest<Bank>("/admin/question-banks", {
    method: "POST",
    body: JSON.stringify({ name, is_default: isDefault }),
  });

export const setDefaultBank = (bankId: string) =>
  adminRequest<Bank>(`/admin/question-banks/${bankId}/default`, { method: "POST" });

export const listBankQuestions = (bankId: string) =>
  adminRequest<AdminQuestion[]>(`/admin/question-banks/${bankId}/questions`);

export const addBankQuestion = (bankId: string, text: string, expectedPoints: string[]) =>
  adminRequest<AdminQuestion>(`/admin/question-banks/${bankId}/questions`, {
    method: "POST",
    body: JSON.stringify({ text, expected_points: expectedPoints }),
  });

export const editQuestion = (
  questionId: string,
  changes: Partial<{ text: string; enabled: boolean; max_follow_ups: number }>,
) =>
  adminRequest<AdminQuestion>(`/admin/question-banks/questions/${questionId}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });

export const deleteQuestion = (questionId: string) =>
  adminRequest<void>(`/admin/question-banks/questions/${questionId}`, { method: "DELETE" });

export const reorderQuestions = (bankId: string, orderedIds: string[]) =>
  adminRequest<void>(`/admin/question-banks/${bankId}/reorder`, {
    method: "POST",
    body: JSON.stringify({ ordered_ids: orderedIds }),
  });

// ── Checklists (F3b) ───────────────────────────────────────────────────

export interface ChecklistItem {
  kind: string;
  text: string;
  weight: number;
  source_quote: string;
  source_page: string | null;
  order_index: number;
}

export interface Checklist {
  checklist_id: string;
  question_id: string;
  prompt_version: string;
  weights_sum: number;
  items: ChecklistItem[];
}

export const draftChecklist = (questionId: string) =>
  adminRequest<Checklist>(`/admin/checklists/questions/${questionId}/draft`, { method: "POST" });

export const getChecklist = (questionId: string) =>
  adminRequest<Checklist>(`/admin/checklists/questions/${questionId}`);

export const editChecklistItems = (
  checklistId: string,
  items: Array<Omit<ChecklistItem, "order_index">>,
) =>
  adminRequest<Checklist>(`/admin/checklists/${checklistId}/items`, {
    method: "PUT",
    body: JSON.stringify({ items }),
  });

// ── Azure AI Foundry config (runtime source of truth) ──────────────────
// The saved master config is what the backend reads at runtime (DB > .env > code default). The
// API key is write-only: responses only carry a masked form, never the stored secret.

export interface AiFoundryConfig {
  endpoint: string;
  masked_key: string;
  default_project: string;
  model_or_deployment: string;
  knowledge_base: string;
  knowledge_source: string;
  is_active: boolean;
}

export interface AiFoundryConfigInput {
  endpoint: string;
  api_key: string; // empty preserves the existing stored key
  default_project: string;
  model_or_deployment: string;
  knowledge_base: string;
  knowledge_source: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
}

export interface ConfigOption {
  value: string;
  label: string;
}

export const getAiFoundryConfig = () =>
  adminRequest<AiFoundryConfig>("/admin/config/ai-foundry");

export const updateAiFoundryConfig = (input: AiFoundryConfigInput) =>
  adminRequest<AiFoundryConfig>("/admin/config/ai-foundry", {
    method: "PUT",
    body: JSON.stringify(input),
  });

export const testAiFoundryConfig = () =>
  adminRequest<ConnectionTestResult>("/admin/config/ai-foundry/test", { method: "POST" });

// Dropdown options pulled from the real Foundry resource (see backend #20 endpoints).
export const listModelDeployments = () =>
  adminRequest<ConfigOption[]>("/admin/config/ai-foundry/model-deployments");

export const listKnowledgeBases = () =>
  adminRequest<ConfigOption[]>("/admin/config/ai-foundry/knowledge-bases");
