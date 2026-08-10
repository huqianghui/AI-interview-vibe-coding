/**
 * Auth API client (Phase 1 — user/admin JWT). Login exchanges username+password for a JWT, stored
 * in sessionStorage under the same key the admin client reads, so the existing bearer-attach path
 * (api/admin.ts) works unchanged — the difference is the token is now a real JWT, not a pasted
 * shared secret. Fetch-based + Fluent-friendly, matching this repo's conventions (no axios).
 */

const BASE = "/api";
const TOKEN_KEY = "admin_api_token"; // reused by api/admin.ts adminRequest()

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
  return typeof sessionStorage !== "undefined" ? (sessionStorage.getItem(TOKEN_KEY) ?? "") : "";
}

export function setToken(token: string): void {
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(TOKEN_KEY);
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
