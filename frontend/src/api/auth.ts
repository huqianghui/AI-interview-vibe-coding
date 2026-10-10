/**
 * Auth API client (user/admin JWT). Login exchanges username+password for a JWT kept in
 * sessionStorage; `api/admin.ts` attaches the admin one as a bearer to every admin call.
 *
 * Candidate login (#102): candidates authenticate with the SAME /auth/login endpoint as admins,
 * but their JWT is kept under a separate sessionStorage key so an admin and a candidate session
 * never collide (and so a candidate sign-out never touches the admin token).
 */
import i18n from "../i18n";
import { apiFetch, HttpError, requestJson } from "./http";
import { tokenStore } from "./tokenStore";
import { startTelemetry } from "../telemetry/appInsights";

export const ADMIN_TOKEN_KEY = "admin_access_token";
const CANDIDATE_TOKEN_KEY = "candidate_access_token";

const adminTokenStore = tokenStore("session", ADMIN_TOKEN_KEY);
const candidateTokenStore = tokenStore("session", CANDIDATE_TOKEN_KEY);

export interface CurrentUser {
  id: string;
  username: string;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  preferred_language: string;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function getAdminToken(): string {
  return adminTokenStore.get() ?? "";
}

export function setAdminToken(token: string): void {
  adminTokenStore.set(token);
}

export function clearAdminToken(): void {
  adminTokenStore.clear();
}

/** POST /auth/login and return the access token. Throws AuthError on bad credentials. */
async function exchangePassword(username: string, password: string): Promise<string> {
  try {
    const body = await requestJson<{ access_token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return body.access_token;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    throw new AuthError(loginErrorMessage(e), e.status);
  }
}

/** The sign-in error in the UI language, carrying the server's reason when it sent a readable one
 * (a JSON `detail` or a short plain-text body — not an HTML error page from the ingress). */
function loginErrorMessage(e: HttpError): string {
  if (e.status === 401) return i18n.t("auth.wrongCredentials");
  const detail = e.detail.trim();
  if (!detail || detail.startsWith("<")) return i18n.t("auth.loginFailedNoDetail", { status: e.status });
  return i18n.t("auth.loginFailed", { status: e.status, detail: detail.slice(0, 200) });
}

/** Log in; on success stores the JWT and returns it. Throws AuthError on bad credentials. */
export async function login(username: string, password: string): Promise<string> {
  const token = await exchangePassword(username, password);
  setAdminToken(token);
  void startTelemetry(token);
  return token;
}

/** Return the current user, or null if the stored token is missing/invalid. */
export async function me(): Promise<CurrentUser | null> {
  const token = getAdminToken();
  if (!token) return null;
  try {
    const resp = await apiFetch("/auth/me", {}, { bearer: token }, { json: false });
    return (await resp.json()) as CurrentUser;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    if (e.status === 401) clearAdminToken();
    return null;
  }
}

// ── Candidate login (#102) ──────────────────────────────────────────────

export function getCandidateToken(): string {
  return candidateTokenStore.get() ?? "";
}

export function setCandidateToken(token: string): void {
  candidateTokenStore.set(token);
}

export function clearCandidateToken(): void {
  candidateTokenStore.clear();
}

/** Log in a candidate against the shared /auth/login endpoint; on success stores the JWT under the
 * candidate's own key and returns it. Throws AuthError on bad credentials (same semantics as
 * {@link login}). */
export async function loginCandidate(username: string, password: string): Promise<string> {
  const token = await exchangePassword(username, password);
  setCandidateToken(token);
  void startTelemetry(token);
  return token;
}
