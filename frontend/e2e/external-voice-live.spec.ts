import { test, expect, request as pwRequest } from "@playwright/test";
import { primeCandidateLogin } from "./helpers/candidateLogin";

/**
 * Opt-in LIVE voice + external-brain interview E2E — the exact demo combination: the default VOICE
 * persona (digital human) driven by the REAL external interview server, on the real running dev
 * servers, with real Azure voice. Chromium's fake mic plays a spoken answer WAV
 * (--use-file-for-fake-audio-capture via FAKE_AUDIO), server-VAD transcribes it, and the spec
 * commits each answer with the real "I'm done answering" flow.
 *
 * Requires: both dev servers running (:5173 / :8000 with real Foundry + external config saved),
 * a WAV for the fake mic, and:
 *
 *   LIVE_VOICE_EXTERNAL=1 LIVE_ADMIN_PW=<seed admin password> FAKE_AUDIO=/tmp/answer-raw.wav \
 *     npx playwright test --config=e2e/live.config.ts external-voice-live
 *
 * The spec temporarily points the CURRENT DEFAULT persona (which must be a voice persona) at the
 * external brain and restores its original brain in afterAll — so it exercises the persona the
 * demo will actually use. Key assertions:
 *  - the external question's speech_text is SPOKEN (a real voice response completes, not just
 *    text in the transcript);
 *  - voice answers round-trip: fake-mic speech → VAD transcript → commit → next external turn;
 *  - the interview reaches the external completion acknowledgement — no local report (P12);
 *  - no question count and no rubric/score internals leak (P3).
 */

const API_BASE = process.env.API_BASE || "http://localhost:8000";
const ADMIN_USER = process.env.LIVE_ADMIN_USER || "admin";
const ADMIN_PW = process.env.LIVE_ADMIN_PW || "";
const LIVE = process.env.LIVE_VOICE_EXTERNAL === "1";

let personaId: string | null = null;
let originalBrain: string | null = null;

test.skip(!LIVE, "live spec — set LIVE_VOICE_EXTERNAL=1, LIVE_ADMIN_PW and FAKE_AUDIO to run");

async function adminApi() {
  const api = await pwRequest.newContext({ baseURL: API_BASE });
  const login = await api.post("/auth/login", {
    headers: { "Content-Type": "application/json" },
    data: { username: ADMIN_USER, password: ADMIN_PW },
  });
  expect(login.ok(), "admin login (check LIVE_ADMIN_PW)").toBeTruthy();
  const token = (await login.json()).access_token;
  return { api, auth: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

test.beforeAll(async () => {
  if (!LIVE) return;
  expect(ADMIN_PW, "LIVE_ADMIN_PW must be set").toBeTruthy();
  expect(process.env.FAKE_AUDIO, "FAKE_AUDIO must point at a spoken-answer WAV").toBeTruthy();
  const { api, auth } = await adminApi();

  // Real saved external connection must probe OK through the running backend.
  const probe = await (
    await api.post("/admin/external-interviewer/test", { headers: auth })
  ).json();
  expect(probe.success, `live connection probe failed: ${probe.message}`).toBeTruthy();

  // The default persona must be a VOICE persona (character set) — that's the demo setup. Point it
  // at the external brain for the run; afterAll restores the original brain.
  const personas: Array<{ id: string; is_default: boolean; character: string; interview_brain: string }> =
    await (await api.get("/admin/personas", { headers: auth })).json();
  const def = personas.find((p) => p.is_default);
  expect(def, "no default persona").toBeTruthy();
  expect(def!.character, "default persona is not a voice persona (no character)").toBeTruthy();
  personaId = def!.id;
  originalBrain = def!.interview_brain;
  if (originalBrain !== "external") {
    await api.put(`/admin/personas/${personaId}`, {
      headers: auth,
      data: { interview_brain: "external" },
    });
  }
  await api.dispose();
});

test.afterAll(async () => {
  if (!LIVE || !ADMIN_PW || !personaId || originalBrain === null) return;
  if (originalBrain !== "external") {
    const { api, auth } = await adminApi();
    await api.put(`/admin/personas/${personaId}`, {
      headers: auth,
      data: { interview_brain: originalBrain },
    });
    await api.dispose();
  }
});

test("voice persona + external brain: spoken questions, spoken answers, real completion", async ({
  page,
}) => {
  // ~10 real turns × (TTS question + VAD answer + gateway round-trip) — budget generously.
  test.setTimeout(600_000);

  let spokenResponses = 0; // completed voice responses (questions read aloud)
  let transcribed = 0; // completed user-utterance transcriptions
  page.on("websocket", (ws) => {
    if (!/voice-live\/ws/.test(ws.url())) return;
    ws.on("framereceived", (f) => {
      const data = typeof f.payload === "string" ? f.payload : "";
      if (!data) return;
      try {
        const msg = JSON.parse(data) as { type?: string };
        if (msg.type === "response.done") spokenResponses++;
        if (msg.type === "conversation.item.input_audio_transcription.completed") transcribed++;
      } catch {
        /* non-JSON frame */
      }
    });
  });

  await primeCandidateLogin(page); // #102: /interview is login-gated

  await page.goto("/interview");
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();

  // External brain exposes no question count.
  await expect(page.getByTestId("question-progress")).toHaveCount(0);

  // Enter the voice channel — the fake mic starts feeding the answer WAV.
  await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

  // The FIRST external question must be SPOKEN (speech_text → real TTS), not just rendered.
  await expect.poll(() => spokenResponses, { timeout: 90_000 }).toBeGreaterThan(0);

  // Turn loop: whenever a fresh utterance has been transcribed and the commit button is up, commit
  // the answer; the external turn advances and the next question is spoken. Until completion.
  let committed = 0;
  let commits = 0;
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    if (await page.getByTestId("external-complete").isVisible().catch(() => false)) break;
    const doneBtn = page.getByRole("button", { name: /我答完了|i'm done/i });
    if (transcribed > committed && (await doneBtn.isVisible().catch(() => false))) {
      committed = transcribed;
      await doneBtn.click();
      commits++;
    }
    await page.waitForTimeout(1_000);
  }

  // Completion acknowledgement — decided by the real external server.
  await expect(page.getByTestId("external-complete")).toBeVisible({ timeout: 60_000 });
  expect(commits, "should have committed several spoken answers").toBeGreaterThanOrEqual(3);
  expect(spokenResponses, "questions should have been read aloud").toBeGreaterThanOrEqual(3);

  // P12: no local report/score for an external session.
  await expect(page.getByTestId("report-exec")).toHaveCount(0);
  await expect(page.getByTestId("score-gauge")).toHaveCount(0);
  await expect(page.getByTestId("submit-and-evaluate")).toHaveCount(0);

  // P3: no rubric/scoring internals anywhere on the candidate page.
  const body = (await page.locator("body").textContent()) ?? "";
  for (const leaked of ["expected_points", "checklist", "rubric", "source_quote"]) {
    expect(body.toLowerCase()).not.toContain(leaked);
  }
});
