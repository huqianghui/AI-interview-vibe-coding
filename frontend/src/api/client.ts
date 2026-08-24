/**
 * Typed API client for the interview thin slice.
 *
 * The anonymous session token is created once and held in memory + localStorage, then sent as
 * X-Anon-Session on every candidate call (mirrors the backend auth contract). No secrets here —
 * the token is a signed pointer whose authority is the server-side DB row.
 */

const BASE = "/api";
const TOKEN_KEY = "anon_session_token";

export interface Question {
  question_id: string;
  prompt: string;
  index: number;
  total: number;
}

export interface Interview {
  interview_session_id: string;
  status: string;
  current_question: Question | null;
}

/** One rubric item's graded result (F4). Present on scored (non-stub) question entries. */
export interface ScoredItem {
  kind: string; // required | recommended | forbidden
  judgment: string; // met | partially_met | not_met | violated
  weight: number;
  // Advisory forbidden gate (known unvalidated source conflict): when violated it is DISCLOSED but does not cap
  // the outcome. The UI renders such a hit as a neutral disclosure note, not a red failure.
  advisory?: boolean;
  rationale: string;
  answer_quote: string;
  source_quote: string;
  source_page: string | null;
  // The SOP document this item cites, for the report's clickable citation link. When present, the
  // report renders the source label as a link that opens the document via fetchSopDocument; when
  // null/absent it shows plain source text. source_document_name is a display label for the link.
  source_document_id?: string | null;
  source_document_name?: string | null;
}

/**
 * Classification rating. The report headline is one of these three tiers; a confirmed
 * critical error caps a would-be higher outcome down to "Needs Improvement".
 */
export type Outcome = "Meets Expectations" | "Needs Improvement" | "Does Not Meet";

/**
 * One question's result. A scored entry (is_stub false) carries score/grade/items; a stub entry
 * (no checklist authored) carries just judgment/rationale. Both shapes share question_id.
 */
export interface QuestionScore {
  question_id: string;
  is_stub?: boolean;
  // Scored fields:
  score?: number;
  coverage_pct?: number;
  grade?: string;
  // Per-question classification + whether a critical error capped it, and the question's
  // aggregate weight in the interview-level mean.
  outcome?: Outcome;
  capped?: boolean;
  weight?: number;
  items?: ScoredItem[];
  // Stub fields:
  judgment?: string;
  rationale?: string;
}

export interface Report {
  interview_session_id: string;
  status: string;
  coverage_pct: number;
  per_question: QuestionScore[];
  is_stub: boolean;
  // F4/F8 scored-report fields (null/empty for the stub path).
  total_score?: number | null;
  grade?: string | null;
  // Interview-level classification rating + whether a confirmed critical error capped it to
  // "Needs Improvement". null for the stub path.
  outcome?: Outcome | null;
  capped?: boolean;
  narrative?: string;
  warnings?: string[];
}

/** One question + the candidate's finalized answer, for the pre-scoring review screen. Mirrors
 * `AnsweredQuestionOut`. No rubric/score — review happens before scoring (P3). */
export interface AnsweredQuestion {
  question_id: string;
  prompt: string;
  index: number;
  answer_text: string;
}

/** Every answered question in bank order, for the review-before-submit screen. Mirrors `ReviewOut`. */
export interface Review {
  interview_session_id: string;
  status: string;
  answers: AnsweredQuestion[];
}

export type AnswerSource = "text" | "voice" | "verbal_cue";

/** WebRTC connection info brokered by the backend (SPEC F9). Mirrors `VoiceSessionOut`. */
export interface VoiceSession {
  // Present for a candidate interview session; absent for the admin editor Playground (which
  // brokers a persona-scoped session with no interview). The voice hook doesn't read it.
  interview_session_id?: string;
  signaling_url: string;
  auth_token: string;
  auth_type: string;
  mode: "agent" | "model";
  model: string;
  session_config: Record<string, unknown>;
  persona_id: string;
  character: string;
  style: string;
  greeting: string | null;
  avatar_enabled: boolean;
}

/**
 * Thrown by the voice-session fetch on a non-2xx response, preserving the HTTP status so callers
 * can distinguish P5's 409 (agent not synced → offer text fallback) from a 503 (voice off).
 */
export class VoiceSessionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "VoiceSessionError";
    this.status = status;
  }
}

function getToken(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
}

function setToken(token: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}, _retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("X-Anon-Session", token);

  const resp = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!resp.ok) {
    // Self-heal a stale/invalid anon token: a cached token that no longer decodes (backend secret
    // rotated, or its session row is gone) 401s forever otherwise. Drop it, mint a fresh session,
    // and retry the call ONCE. Guard against loops (only retry when we actually had a token, and
    // never on the session-mint endpoint itself).
    if (
      resp.status === 401 &&
      !_retried &&
      token &&
      !path.includes("/public/candidate/session")
    ) {
      clearToken();
      await ensureSession();
      return request<T>(path, init, true);
    }
    const detail = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${detail}`);
  }
  return (await resp.json()) as T;
}

/** Ensure an anonymous candidate session exists; returns the token. */
export async function ensureSession(): Promise<string> {
  const existing = getToken();
  if (existing) return existing;
  const body = await request<{ session_id: string; token: string; expires_at: string }>(
    "/public/candidate/session",
    { method: "POST" },
  );
  setToken(body.token);
  return body.token;
}

const INTERVIEW_KEY = "interview_session_id";

function getSavedInterviewId(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(INTERVIEW_KEY) : null;
}

function saveInterviewId(id: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(INTERVIEW_KEY, id);
}

function clearSavedInterviewId(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(INTERVIEW_KEY);
}

/** Start an interview — or resume the candidate's in-progress one (the backend reuses it), and
 * persist the id so a page reload can resume via {@link resumeInterview}. */
export async function startInterview(): Promise<Interview> {
  await ensureSession();
  const iv = await request<Interview>("/candidate/interview/start", { method: "POST" });
  saveInterviewId(iv.interview_session_id);
  return iv;
}

/** Resume a persisted in-progress interview on reload, or null if none/over (SPEC F6 edge b).
 * Reads the saved id and GETs its current state; a completed/missing/not-owned interview clears
 * the saved id and returns null so the page falls back to the idle start screen. */
export async function resumeInterview(): Promise<Interview | null> {
  const id = getSavedInterviewId();
  if (!id) return null;
  const token = getToken();
  if (!token) return null;
  try {
    const iv = await request<Interview>(`/candidate/interview/${id}`);
    if (iv.status !== "in_progress" || !iv.current_question) {
      clearSavedInterviewId();
      return null;
    }
    return iv;
  } catch {
    clearSavedInterviewId(); // 404 (not found / not owned) → nothing to resume
    return null;
  }
}

export async function submitAnswer(
  interviewId: string,
  text: string,
  source: AnswerSource = "text",
): Promise<Interview> {
  return request<Interview>(`/candidate/interview/${interviewId}/answer`, {
    method: "POST",
    body: JSON.stringify({ text, source }),
  });
}

export async function getReport(interviewId: string): Promise<Report> {
  return request<Report>(`/candidate/interview/${interviewId}/report`, { method: "POST" });
}

/** Fetch every answered question + answer in bank order for the pre-scoring review screen
 * (requirement 4). Backend-sourced so it survives a reload and matches what gets scored. Only
 * valid once the interview is completed/scored (409 otherwise). */
export async function getReview(interviewId: string): Promise<Review> {
  return request<Review>(`/candidate/interview/${interviewId}/review`);
}

/**
 * Fetch a cited SOP source document and return a blob object URL the caller can open in a new tab
 * (the report's clickable citations). We fetch bytes with the X-Anon-Session header rather than
 * linking the endpoint directly, because the anon session is a header — not a cookie — so a naked
 * `<a href>` navigation would be unauthenticated (401). The blob URL also keeps the session token
 * out of the address bar and lets the browser preview a PDF/text inline. Callers should
 * URL.revokeObjectURL the returned url when done. Throws on a non-2xx (e.g. 404 for an uncited id).
 */
export async function fetchSopDocument(
  interviewId: string,
  documentId: string,
): Promise<string> {
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set("X-Anon-Session", token);
  const resp = await fetch(
    `${BASE}/candidate/interview/${interviewId}/sop/${encodeURIComponent(documentId)}`,
    { headers },
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${detail}`);
  }
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

/**
 * Broker a WebRTC voice session for an in-progress interview (SPEC F9). Throws
 * {@link VoiceSessionError} (with the HTTP status) on failure so the caller can react to P5's
 * 409 (agent not synced) vs. a 503 (voice unavailable) — both fall back to the text channel.
 */
export async function fetchVoiceSession(
  interviewId: string,
  locale: string,
): Promise<VoiceSession> {
  const token = getToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("X-Anon-Session", token);
  const resp = await fetch(`${BASE}/candidate/interview/${interviewId}/voice/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ locale }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new VoiceSessionError(`${resp.status} ${resp.statusText}: ${detail}`, resp.status);
  }
  return (await resp.json()) as VoiceSession;
}

export const _internal = { TOKEN_KEY, getToken, setToken };
