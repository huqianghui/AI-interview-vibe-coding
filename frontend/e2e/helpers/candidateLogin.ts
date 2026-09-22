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

/** An API context + the seeded admin's bearer headers (JSON content type included). */
export async function adminApi(): Promise<{
  api: Awaited<ReturnType<typeof pwRequest.newContext>>;
  headers: Record<string, string>;
}> {
  const api = await pwRequest.newContext({ baseURL: API });
  const login = await api.post("/auth/login", {
    headers: { "Content-Type": "application/json" },
    data: { username: ADMIN_USER, password: ADMIN_PW },
  });
  if (!login.ok()) throw new Error(`admin login failed: ${login.status()} ${await login.text()}`);
  const token = (await login.json()).access_token as string;
  return { api, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

/** Log in as the admin and return the derived password of a seeded candidate account. */
export async function candidatePassword(username = "user1"): Promise<string> {
  const { api, headers } = await adminApi();
  try {
    const users = await api.get("/admin/users", { headers });
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

/**
 * Finish any in-progress interview of this candidate so the spec starts from a clean "Start
 * interview" screen. Session creation is idempotent per account (#102, decision 1A), so without this
 * a spec would RESUME whatever the previous spec left behind on the shared user1 account — the old
 * anonymous world minted a fresh session per spec, and these specs are written for that.
 */
export async function finishOpenInterview(token: string): Promise<void> {
  const api = await pwRequest.newContext({ baseURL: API });
  try {
    const sess = await api.post("/public/candidate/session", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!sess.ok()) throw new Error(`session mint failed: ${sess.status()} ${await sess.text()}`);
    const anon = { "X-Anon-Session": (await sess.json()).token as string };
    // start() resumes an in-progress interview (or creates one); end it so the next start is fresh.
    const started = await api.post("/candidate/interview/start", { headers: anon });
    if (!started.ok()) return; // e.g. no default bank yet — nothing to clean
    let iv = (await started.json()) as {
      interview_session_id: string;
      status: string;
      external_phase?: string | null;
    };
    if (iv.status !== "in_progress") return;
    const id = iv.interview_session_id;
    if (iv.external_phase != null) {
      // External brain: the end turn finalizes it.
      await api.post(`/candidate/interview/${id}/end`, { headers: anon });
      return;
    }
    // Bank interview: /end is a no-op for it (it completes when its questions run out), so walk it
    // to completion with placeholder answers. Nothing is scored until a report is requested.
    for (let i = 0; i < 30 && iv.status === "in_progress"; i++) {
      const r = await api.post(`/candidate/interview/${id}/answer`, {
        headers: anon,
        data: { text: "(e2e cleanup) skipped", source: "text" },
      });
      if (!r.ok()) break; // no current question left (review stage) → finalize below
      iv = (await r.json()) as typeof iv;
    }
    if (iv.status === "in_progress") {
      // All questions answered but not yet submitted: requesting the report scores + closes it
      // (mock scorer locally), so the next start is a fresh interview.
      await api.post(`/candidate/interview/${id}/report`, { headers: anon });
    }
  } finally {
    await api.dispose();
  }
}

/**
 * Make every document on `page` start with a valid candidate JWT in sessionStorage, on a clean
 * slate (any open interview of that account is ended first; pass `fresh: false` to keep it).
 */
export async function primeCandidateLogin(
  page: Page,
  username = "user1",
  opts: { fresh?: boolean } = {},
): Promise<string> {
  const token = await candidateToken(username);
  if (opts.fresh !== false) await finishOpenInterview(token);
  await page.addInitScript(
    ([key, value]: readonly [string, string]) => {
      sessionStorage.setItem(key, value);
    },
    [CANDIDATE_TOKEN_KEY, token] as const,
  );
  return token;
}

/** Resolves once the interviewing screen is up (bank or external brain, text or voice channel). */
export async function waitForInterviewStage(page: Page): Promise<void> {
  // The top bar (progress + channel switch) always has content; the avatar stage itself can collapse
  // to zero height while no video is attached, which Playwright counts as not visible.
  await page.getByTestId("interview-topbar").waitFor({ state: "visible", timeout: 60_000 });
}

/**
 * Put the page in the voice channel. Since v0.37.4.0 a voice-configured persona opens the interview
 * in voice mode by itself (`voice_default`), so the "Answer by voice" click is only needed when the
 * page landed in the text channel (mock persona / no voice configured).
 */
export async function enterVoiceChannel(page: Page): Promise<void> {
  await waitForInterviewStage(page);
  if (await page.getByRole("textbox").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();
  }
}

/** Put the page in the text channel (the auto-voice persona opens in voice mode). */
export async function enterTextChannel(page: Page): Promise<void> {
  await waitForInterviewStage(page);
  const textbox = page.getByRole("textbox");
  if (!(await textbox.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /文字作答|answer by text/i }).click();
  }
  await textbox.waitFor({ state: "visible", timeout: 15_000 });
}
