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
  rationale: string;
  answer_quote: string;
  source_quote: string;
  source_page: string | null;
}

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
  narrative?: string;
  warnings?: string[];
}

export type AnswerSource = "text" | "voice" | "verbal_cue";

/** WebRTC connection info brokered by the backend (SPEC F9). Mirrors `VoiceSessionOut`. */
export interface VoiceSession {
  interview_session_id: string;
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
