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

export interface QuestionScore {
  question_id: string;
  judgment: string;
  rationale: string;
}

export interface Report {
  interview_session_id: string;
  status: string;
  coverage_pct: number;
  per_question: QuestionScore[];
  is_stub: boolean;
}

export type AnswerSource = "text" | "voice" | "verbal_cue";

function getToken(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
}

function setToken(token: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, token);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("X-Anon-Session", token);

  const resp = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!resp.ok) {
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

export async function startInterview(): Promise<Interview> {
  await ensureSession();
  return request<Interview>("/candidate/interview/start", { method: "POST" });
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

export const _internal = { TOKEN_KEY, getToken, setToken };
