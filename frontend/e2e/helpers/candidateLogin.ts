/**
 * #102 — the /interview page is behind a candidate login. Specs that used to land anonymously
 * call `primeCandidateLogin(page)` (once per page, before the first goto) so the page starts
 * authenticated as a seeded candidate, exactly like a human who just signed in:
 *
 *   admin login -> GET /admin/users -> read user1's derived password -> POST /auth/login as user1
 *   -> seed sessionStorage.candidate_access_token via addInitScript.
 *
 * The password is never hardcoded: it derives from the backend's SECRET_KEY, so this helper stays
 * valid for any deployment as long as the admin credentials are right.
 */
import { request as pwRequest, type Page } from "@playwright/test";

const BASE = process.env.BASE || "";
// Direct backend URL for the local webServer stack; live runs go through the frontend proxy.
const API = process.env.E2E_API || (BASE ? `${BASE}/api` : "http://127.0.0.1:8100");
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || "admin";
const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD || "e2e-admin-pw";

export const CANDIDATE_TOKEN_KEY = "candidate_access_token";

type AdminUserRow = { username: string; generated_password: string | null };

/** Log in as the admin and return the derived password of a seeded candidate account. */
export async function candidatePassword(username = "user1"): Promise<string> {
  const api = await pwRequest.newContext({ baseURL: API });
  try {
    const admin = await api.post("/auth/login", {
      headers: { "Content-Type": "application/json" },
      data: { username: ADMIN_USER, password: ADMIN_PW },
    });
    if (!admin.ok()) throw new Error(`admin login failed: ${admin.status()} ${await admin.text()}`);
    const adminToken = (await admin.json()).access_token as string;
    const users = await api.get("/admin/users", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!users.ok()) throw new Error(`GET /admin/users failed: ${users.status()}`);
    const row = ((await users.json()) as AdminUserRow[]).find((u) => u.username === username);
    if (!row?.generated_password) {
      throw new Error(`no viewable derived password for ${username} - is the candidate seed on?`);
    }
    return row.generated_password;
  } finally {
    await api.dispose();
  }
}

/** Log in as a seeded candidate and return the candidate JWT. */
export async function candidateToken(username = "user1"): Promise<string> {
  const password = await candidatePassword(username);
  const api = await pwRequest.newContext({ baseURL: API });
  try {
    const login = await api.post("/auth/login", {
      headers: { "Content-Type": "application/json" },
      data: { username, password },
    });
    if (!login.ok()) {
      throw new Error(`candidate login failed: ${login.status()} ${await login.text()}`);
    }
    return (await login.json()).access_token as string;
  } finally {
    await api.dispose();
  }
}

/** Make every document on `page` start with a valid candidate JWT in sessionStorage. */
export async function primeCandidateLogin(page: Page, username = "user1"): Promise<string> {
  const token = await candidateToken(username);
  await page.addInitScript(
    ([key, value]: readonly [string, string]) => {
      sessionStorage.setItem(key, value);
    },
    [CANDIDATE_TOKEN_KEY, token] as const,
  );
  return token;
}
