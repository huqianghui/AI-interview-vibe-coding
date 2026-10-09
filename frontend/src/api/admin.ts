/**
 * Admin API client (SPEC F2b/F3b). Admin routes authenticate with the admin's login JWT
 * (`api/auth.ts`), never the anonymous candidate session, so this module attaches only that bearer.
 */
import { getAdminToken } from "./auth";
import type { HistoryStatus, InterviewDetail, InterviewHistoryItem } from "./client";
import { apiFetch, HttpError, readJson, requestJson } from "./http";

/** A failed admin call: the shared {@link HttpError} (status + the server's detail). */
export const AdminApiError = HttpError;
export type AdminApiError = HttpError;

export function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestJson<T>(path, init, { bearer: getAdminToken() });
}

// ── Question banks (F2b) ───────────────────────────────────────────────

export interface Bank {
  bank_id: string;
  name: string;
  description: string;
  language: string;
  enabled: boolean;
  is_default: boolean;
  // Publish state: interviews use the latest PUBLISHED version; edits stay a draft until then.
  latest_version_no?: number | null;
  has_unpublished_changes?: boolean;
  // The SOP library the bank draws on (spec-sop-libraries); null = no SOP, general evaluation.
  sop_library_id?: string | null;
}

/** Bind a bank to an SOP library, or to none. Draft citations outside it are cleared. */
export const setBankLibrary = (bankId: string, libraryId: string | null) =>
  adminRequest<{ bank: Bank; cleared: number }>(`/admin/question-banks/${bankId}/sop-library`, {
    method: "PUT",
    body: JSON.stringify({ library_id: libraryId }),
  });

/** Why a draft cannot be published. `question_no` is 1-based in ask order. */
export interface PublishProblem {
  code: "no_questions" | "no_rubric" | "weights" | string;
  question_no: number | null;
  question_text: string;
  weights_sum: number | null;
}

export interface PublishResult {
  published: boolean;
  created: boolean;
  version_no: number | null;
  problems: PublishProblem[];
}

export const publishBank = (bankId: string) =>
  adminRequest<PublishResult>(`/admin/question-banks/${bankId}/publish`, { method: "POST" });

export interface AdminQuestion {
  question_id: string;
  text: string;
  language: string;
  order_index: number;
  enabled: boolean;
  expected_points: string[];
  max_follow_ups: number;
  // Items in this question's default checklist (0 = rubric not configured). Drives the status marker.
  checklist_item_count: number;
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

// One SOP section a rubric item cites (spec-sop-section-grounding §3). Bound to the section NUMBER;
// scoring reads the section's full text. `found` is false when the document or section is gone.
export interface SourceRef {
  document_id: string;
  section: string;
  // A run of sections, "section" through "through" (one merged unit); or a section's own text.
  through?: string;
  part?: "own";
  document_name?: string;
  title?: string;
  page_start?: number | null;
  found?: boolean;
}

export interface ChecklistItem {
  kind: string;
  text: string;
  weight: number;
  source_quote: string;
  source_page: string | null;
  order_index: number;
  // The SOP document behind the report's "SOP source" link, and a forbidden item that is disclosed
  // but never deducts. Both MUST be sent back on save: dropping them unlinked the SOP and turned a
  // disclosure into a deduction.
  source_document_id?: string | null;
  source_document_name?: string | null;
  advisory?: boolean;
  // The SOP sections cited, primary first.
  source_refs?: SourceRef[];
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
  items: Array<Omit<ChecklistItem, "order_index" | "source_document_name">>,
) =>
  adminRequest<Checklist>(`/admin/checklists/${checklistId}/items`, {
    method: "PUT",
    body: JSON.stringify({ items }),
  });

// ── Azure AI Foundry config (runtime source of truth) ──────────────────
// The saved master config is what the backend reads at runtime (DB > .env > code default). The
// API key is write-only: responses only carry a masked form, never the stored secret.

// Two models, not one. `model_or_deployment` is the INFERENCE model (judge, scoring, and the
// Foundry agent) and must be a deployment in the resource. `voice_model` is the Voice Live SESSION
// model and must be a name Voice Live hosts natively in the region — unless `voice_model_mode` is
// "byom", which points the voice session at your own deployment via `voice_byom_profile`. They were
// one field, and that is exactly what produced "Model X is not supported in this region" whenever
// an operator saved their own deployment (docs/voice-live-model-support.md §3.6).
export interface AiFoundryConfig {
  endpoint: string;
  masked_key: string;
  default_project: string;
  model_or_deployment: string;
  voice_model?: string;
  voice_model_mode?: string; // "native" | "byom"
  voice_byom_profile?: string;
  knowledge_base: string;
  knowledge_source: string;
  is_active: boolean;
  voice_model_check?: string; // what the save-time live check concluded
}

export interface AiFoundryConfigInput {
  endpoint: string;
  api_key: string; // empty preserves the existing stored key
  clear_api_key?: boolean; // true deletes the stored key (Entra ID / Managed Identity auth only)
  default_project: string;
  model_or_deployment: string;
  voice_model?: string;
  voice_model_mode?: string;
  voice_byom_profile?: string;
  knowledge_base: string;
  knowledge_source: string;
}

// The three BYOM integration modes — the upstream protocol Voice Live drives your deployment with.
// Not inferable from the deployment name, which is why the operator picks one.
export const BYOM_PROFILES = [
  { value: "byom-azure-openai-chat-completion", label: "Chat completion (cascaded) — most models" },
  { value: "byom-azure-openai-realtime", label: "Realtime (speech-native passthrough)" },
  { value: "byom-foundry-anthropic-messages", label: "Anthropic Messages (Claude, preview)" },
] as const;
export const DEFAULT_BYOM_PROFILE = "byom-azure-openai-chat-completion";

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
// `kind` says which deployments are legal for the consumer asking. Default "chat" (judge, scoring,
// the Foundry agent, and the chat-completion BYOM profile). "realtime" is required for
// `byom-azure-openai-realtime`: realtime deployments are NOT chat-capable, so the default list
// excludes them and that profile would have no selectable value at all. "all" is used for the
// Anthropic profile, where no filter can be verified on a tenant that cannot deploy Claude.
export const listModelDeployments = (kind: "chat" | "realtime" | "all" = "chat") =>
  adminRequest<ConfigOption[]>(
    `/admin/config/ai-foundry/model-deployments?kind=${encodeURIComponent(kind)}`,
  );

/** Which deployments a BYOM profile can legally point at. */
export const deploymentKindForProfile = (profile: string): "chat" | "realtime" | "all" =>
  profile === "byom-azure-openai-realtime"
    ? "realtime"
    : profile === "byom-azure-openai-chat-completion"
      ? "chat"
      : "all";

export const listKnowledgeBases = () =>
  adminRequest<ConfigOption[]>("/admin/config/ai-foundry/knowledge-bases");

// The NATIVE Voice Live models this resource's REGION actually accepts, measured by real
// connections (no API lists them, and the docs table runs ahead of rollout). Cached server-side;
// `refresh` re-probes.
export const listVoiceLiveModels = (refresh = false) =>
  adminRequest<ConfigOption[]>(
    `/admin/config/ai-foundry/voice-live-models${refresh ? "?refresh=true" : ""}`,
  );

// ── External interview API/server config (Phase 2, vendor-neutral) ─────
// Connection to the client's external interview brain. Resolved live from the DB on every turn
// (DB > .env), so a save takes effect on the next interview with no restart. The API key is
// write-only on the main GET (masked only); a SEPARATE reveal call returns the plaintext for a
// deliberate click-to-reveal. Nothing here names a product — only "external interview API".

export interface ExternalConfig {
  endpoint: string;
  masked_key: string;
  user_tag: string;
  is_active: boolean;
}

export interface ExternalConfigInput {
  endpoint: string;
  api_key: string; // empty preserves the existing stored key
  user_tag: string;
}

export const getExternalConfig = () =>
  adminRequest<ExternalConfig>("/admin/external-interviewer");

export const updateExternalConfig = (input: ExternalConfigInput) =>
  adminRequest<ExternalConfig>("/admin/external-interviewer", {
    method: "PUT",
    body: JSON.stringify(input),
  });

export const testExternalConfig = () =>
  adminRequest<ConnectionTestResult>("/admin/external-interviewer/test", { method: "POST" });

/** Return the PLAINTEXT external API key for a deliberate admin click-to-reveal. Never cached. */
export const revealExternalKey = () =>
  adminRequest<{ api_key: string }>("/admin/external-interviewer/reveal");

// ── Users (#102, read-only per the eng review — no create/reset-password endpoints yet) ────────
// One shared account per candidate seat (user1/user2/user3…): the Users tab exists so an admin can
// hand out the seeded credentials, not to manage accounts. `generated_password` is the plaintext
// the backend generated at seed/creation time — it's only ever returned while that password is
// still current; once the signing SECRET_KEY rotates, existing generated passwords go stale
// (`password_stale`) and the admin must re-seed/reset out of band (not exposed here yet).

export interface AdminUser {
  id: string;
  username: string;
  role: string;
  is_active: boolean;
  // The plaintext password generated for this account, or null once it's no longer viewable
  // (rotated out-of-band, or never had one on record).
  generated_password: string | null;
  // True when the backend's signing key has rotated since this password was generated — the
  // account needs a fresh password before it can be handed out again.
  password_stale: boolean;
  // #187: the interviewer + bank this user's next interview starts with; null = the default.
  assigned_persona_id: string | null;
  assigned_bank_id: string | null;
  // The published version of that bank (questions + rubric) this user's interviews use.
  assigned_bank_version_id?: string | null;
  assigned_bank_version_no?: number | null;
}

export const listUsers = () => adminRequest<AdminUser[]>("/admin/users");

// ── Assignment + interview history (#187) ──────────────────────────────

export interface Assignment {
  persona_id: string | null;
  bank_id: string | null;
  // A published version of `bank_id`; null with a bank = its latest (the backend picks it).
  bank_version_id?: string | null;
}

/** One published version of a bank (questions + rubric). Mirrors `BankVersionOut`. */
export interface BankVersion {
  id: string;
  version_no: number;
  created_at: string | null;
  reason: string;
  question_count: number;
  is_latest: boolean;
}

export const listBankVersions = (bankId: string) =>
  adminRequest<BankVersion[]>(`/admin/question-banks/${bankId}/versions`);

export const setUserAssignment = (userId: string, assignment: Assignment) =>
  adminRequest<AdminUser>(`/admin/users/${userId}/assignment`, {
    method: "PATCH",
    body: JSON.stringify(assignment),
  });

/** One row of the admin "Interview results" table. Mirrors `InterviewResultItem`. */
export interface InterviewResultItem extends InterviewHistoryItem {
  user_id: string | null; // null = an anonymous (not signed-in) candidate
  username: string | null;
  persona_id: string | null;
  bank_id: string | null;
  bank_version_no?: number | null;
}

/** One page of results. `total` counts every match, for the pager. Mirrors `InterviewResultsPage`. */
export interface InterviewResultsPage {
  items: InterviewResultItem[];
  total: number;
  limit: number;
  offset: number;
}

/** Every filter the results table offers; an empty value means "any". */
export interface InterviewResultFilters {
  user_id?: string;
  status?: HistoryStatus[];
  persona_id?: string;
  bank_id?: string;
  started_from?: string; // YYYY-MM-DD, inclusive
  started_to?: string; // YYYY-MM-DD, inclusive
  outcome?: string;
  score_min?: number;
  score_max?: number;
}

export interface InterviewResultsQuery extends InterviewResultFilters {
  sort?: "started_at" | "total_score";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** Every candidate's interviews, filtered, sorted and paged server-side. */
export function listInterviewResults(query: InterviewResultsQuery = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.set(key, String(value));
  }
  // Always "?…" (an empty query is just "/admin/interviews?"): one literal path keeps the static
  // route check (backend tests/test_frontend_api_contract.py) able to read it.
  return adminRequest<InterviewResultsPage>(`/admin/interviews?${params.toString()}`);
}

export const getInterview = (interviewId: string) =>
  adminRequest<InterviewDetail>(`/admin/interviews/${interviewId}`);

/** Start scoring a finished interview the candidate never submitted. Scoring runs in the
 * background (it outlasts one request); poll {@link getInterview} until the report is saved. */
export const generateInterviewReport = (interviewId: string) =>
  adminRequest<{ status: string }>(`/admin/interviews/${interviewId}/report`, { method: "POST" });

/** A SOP document cited by an interview's report, as a blob URL (the caller revokes it). */
export async function fetchInterviewSopDocument(
  interviewId: string,
  documentId: string,
): Promise<string> {
  const resp = await apiFetch(
    `/admin/interviews/${interviewId}/sop/${encodeURIComponent(documentId)}`,
    {},
    { bearer: getAdminToken() },
    { json: false },
  );
  return URL.createObjectURL(await resp.blob());
}

// ── SOP documents and their sections (spec-sop-section-grounding) ──────
// A document is converted to Markdown in the background and split into sections. All or
// nothing: a failed conversion has no sections and says why (`markdown_error`).

// ── SOP libraries (spec-sop-libraries) ──────────────────────────────────
// Every document belongs to one library, chosen before it is uploaded.

export interface SopLibrary {
  library_id: string;
  name: string;
  description: string;
  document_count: number;
}

export const listSopLibraries = () => adminRequest<SopLibrary[]>("/admin/sop/libraries");

export const createSopLibrary = (name: string, description = "") =>
  adminRequest<SopLibrary>("/admin/sop/libraries", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });

export const updateSopLibrary = (libraryId: string, change: { name?: string; description?: string }) =>
  adminRequest<SopLibrary>(`/admin/sop/libraries/${libraryId}`, {
    method: "PATCH",
    body: JSON.stringify(change),
  });

export const deleteSopLibrary = (libraryId: string) =>
  adminRequest<void>(`/admin/sop/libraries/${libraryId}`, { method: "DELETE" });

/** Upload one SOP file into a library. Multipart, so the browser sets the content type. */
export async function uploadSopDocument(libraryId: string, file: File): Promise<SopDocument> {
  const form = new FormData();
  form.append("file", file);
  form.append("library_id", libraryId);
  const resp = await apiFetch(
    "/admin/sop/documents",
    { method: "POST", body: form },
    { bearer: getAdminToken() },
    { json: false },
  );
  return readJson<SopDocument>(resp);
}

export interface SopDocument {
  document_id: string;
  name: string;
  library_id: string;
  // The key-points summary text, and where the document is cited (a cited SOP is never deleted).
  summary?: string;
  cited_in?: string[];
  status: string;
  size: number;
  chunk_count: number;
  // document_intelligence | pdf_text | docx | text | failed; "" = not converted yet.
  markdown_source: string;
  section_count: number;
  // The units it reads as (sections merged or opened to 500-4000 characters): what the tab lists.
  unit_count: number;
  // Why the conversion failed, or why converting again failed while the previous one was kept.
  markdown_error: string;
  // Queued for or in conversion right now.
  converting: boolean;
  // The key-points summary: "" none | draft | reviewed (the only state scoring uses) | failed.
  summary_status: string;
  summary_error: string;
  summarizing: boolean;
}

export interface SopSummary {
  summary: string;
  status: string;
  error: string;
  reviewed_at: string | null;
  summarizing: boolean;
}

export interface SopSection {
  order_index: number;
  number: string; // "4.2.3"; "§n" for an unnumbered heading, "§0" for text before the first
  title: string;
  level: number;
  parent_index: number | null;
  page_start: number;
  page_end: number;
  // Characters of the FULL section: its own text plus every subsection.
  full_length: number;
}

export interface SopSectionText {
  number: string;
  title: string;
  page_start: number;
  page_end: number;
  full_text: string;
}

/** A unit: sections merged or opened to 500-4000 characters. What the SOP tab lists, what search
 * proposes and what a rubric item cites, as one run (section … through) or one section's own text. */
export interface SopUnit {
  index: number;
  label: string; // "4.2 Title", or "1–3 PURPOSE / SCOPE / DEFINITIONS"
  page_start: number;
  page_end: number;
  length: number;
  section: string;
  through: string;
  own: boolean;
  members: string[];
}

export interface SopUnitText extends SopUnit {
  text: string; // Markdown: every member's heading and text
}

export const listSopUnits = (documentId: string) =>
  adminRequest<SopUnit[]>(`/admin/sop/documents/${documentId}/units`);

export const getSopUnit = (documentId: string, index: number) =>
  adminRequest<SopUnitText>(`/admin/sop/documents/${documentId}/units/${index}`);

/** How a rubric item cites a unit. */
export const unitRef = (documentId: string, u: SopUnit): SourceRef => ({
  document_id: documentId,
  section: u.section,
  ...(u.through ? { through: u.through } : {}),
  ...(u.own ? { part: "own" as const } : {}),
});

export const listSopDocuments = () => adminRequest<SopDocument[]>("/admin/sop/documents");

/** Delete an SOP nothing cites; a cited one is a 409 naming where it is cited. */
export const deleteSopDocument = (documentId: string) =>
  adminRequest<void>(`/admin/sop/documents/${documentId}`, { method: "DELETE" });

export const listSopSections = (documentId: string) =>
  adminRequest<SopSection[]>(`/admin/sop/documents/${documentId}/sections`);

export const getSopSection = (documentId: string, orderIndex: number) =>
  adminRequest<SopSectionText>(`/admin/sop/documents/${documentId}/sections/${orderIndex}`);

export const rebuildSopDocument = (documentId: string) =>
  adminRequest<SopDocument>(`/admin/sop/documents/${documentId}/rebuild`, { method: "POST" });

export const getSopSummary = (documentId: string) =>
  adminRequest<SopSummary>(`/admin/sop/documents/${documentId}/summary`);

// approve = true: used in scoring; false: saved as a draft, not used.
export const saveSopSummary = (documentId: string, summary: string, approve: boolean) =>
  adminRequest<SopSummary>(`/admin/sop/documents/${documentId}/summary`, {
    method: "PUT",
    body: JSON.stringify({ summary, approve }),
  });

export const redraftSopSummary = (documentId: string) =>
  adminRequest<SopSummary>(`/admin/sop/documents/${documentId}/summary/draft`, { method: "POST" });

// ── Relocating a bank's SOP citations (spec-sop-section-grounding §4) ──────
// Runs in the background over the bank's DRAFT; each row is one rubric item, old → new.

export interface CitationRunRow {
  item_id?: string;
  question_no: number;
  question: string;
  item: string;
  old: { document_name: string; quote: string };
  new: { sections: { document_name: string; section: string; title: string }[]; quote: string };
  // edited = the rubric was saved during the run, so this item's result was not written.
  // off_topic = the question names no SOP and the library does not cover its subject.
  how: "label" | "search" | "none" | "off_topic" | "error" | "edited";
}

export interface CitationRun {
  run_id: string;
  status: "running" | "done" | "failed";
  done: number;
  total: number;
  error: string;
  created_at: string | null;
  // A version was published after the run finished: the summary is no longer shown.
  published?: boolean;
  rows: CitationRunRow[];
}

// fresh = start every item again from its original label, discarding earlier relocations.
export const relocateCitations = (bankId: string, fresh = false) =>
  adminRequest<CitationRun>(
    `/admin/question-banks/${bankId}/relocate-citations${fresh ? "?fresh=true" : ""}`,
    { method: "POST" },
  );

export const getCitationRun = (bankId: string) =>
  adminRequest<CitationRun | null>(`/admin/question-banks/${bankId}/relocate-citations`);

// ── Candidate voice recordings (admin only; the microphone, one per question) ──────
export interface InterviewRecording {
  recording_id: string;
  question_index: number;
  duration_ms: number;
  size_bytes: number;
  created_at: string | null;
}

export const listInterviewRecordings = (interviewId: string) =>
  adminRequest<InterviewRecording[]>(`/admin/interviews/${interviewId}/recordings`);

/** The recording as an object URL for an <audio> element (the container is private, so the bytes
 *  come through the backend with the admin token). Rejects with status 410 once it has expired. */
export async function fetchInterviewRecording(
  interviewId: string,
  recordingId: string,
): Promise<string> {
  const resp = await apiFetch(
    `/admin/interviews/${interviewId}/recordings/${encodeURIComponent(recordingId)}`,
    {},
    { bearer: getAdminToken() },
    { json: false },
  );
  return URL.createObjectURL(await resp.blob());
}
