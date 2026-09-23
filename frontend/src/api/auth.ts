/**
 * Auth API client (Phase 1 — user/admin JWT). Login exchanges username+password for a JWT, stored
 * in sessionStorage under the same key the admin client reads, so the existing bearer-attach path
 * (api/admin.ts) works unchanged — the difference is the token is now a real JWT, not a pasted
 * shared secret. Fetch-based + Fluent-friendly, matching this repo's conventions (no axios).
 *
 * Candidate login (#102): candidates authenticate with the SAME /auth/login endpoint as admins,
 * but their JWT is kept under a separate sessionStorage key so an admin and a candidate session
 * never collide (and so a candidate sign-out never touches the admin token).
 */
import { tokenStore } from "./tokenStore";

const BASE = "/api";
const TOKEN_KEY = "admin_api_token"; // reused by api/admin.ts adminRequest()
const CANDIDATE_TOKEN_KEY = "candidate_access_token";

const adminTokenStore = tokenStore("session", TOKEN_KEY);
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

export function getToken(): string {
  return adminTokenStore.get() ?? "";
}

export function setToken(token: string): void {
  adminTokenStore.set(token);
}

export function clearToken(): void {
  adminTokenStore.clear();
}

/** Log in; on success stores the JWT and returns it. Throws AuthError on bad credentials. */
export async function login(username: string, password: string): Promise<string> {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) {
    throw new AuthError(resp.status === 401 ? "用户名或密码错误" : `登录失败 (${resp.status})`, resp.status);
  }
  const token = (await resp.json()).access_token as string;
  setToken(token);
  return token;
}

/** Return the current user, or null if the stored token is missing/invalid. */
export async function me(): Promise<CurrentUser | null> {
  const token = getToken();
  if (!token) return null;
  const resp = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    if (resp.status === 401) clearToken();
    return null;
  }
  return (await resp.json()) as CurrentUser;
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
  const resp = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) {
    throw new AuthError(resp.status === 401 ? "用户名或密码错误" : `登录失败 (${resp.status})`, resp.status);
  }
  const token = (await resp.json()).access_token as string;
  setCandidateToken(token);
  return token;
}
