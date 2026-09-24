/**
 * LIVE bank-mode linear turns + "Start over" round-trip (opt-in, real Azure — NOT part of CI).
 *
 * Validates v0.38.2.0 + v0.38.3.0 against the REAL running dev servers (frontend :5173 → backend
 * :8000 with real Foundry credentials) and a fake mic that PLAYS A SPOKEN ANSWER (`FAKE_AUDIO`, a
 * WAV with ~45s of leading silence so the question read finishes first):
 *
 *  1. The candidate start response reports `voice_linear_turns: true` for the default bank persona,
 *     the proxy bootstrap frame reports `linear_turns: true`, and Azure's `session.updated` echoes
 *     `turn_detection.create_response: false` — the backend half of linear turns is live.
 *  2. Question 1 is read (exactly ONE `response.created`), the candidate's spoken answer is
 *     transcribed, and 15s later there is STILL exactly one model response: no "Thank you." per
 *     pause any more (the bug this release fixes).
 *  3. "I'm done" submits the transcribed answer and the next question is read (response #2). No
 *     transcript anywhere is an acknowledgment.
 *  4. "Start over" → confirm → the backend returns a fresh session (index 0, new id), the old one is
 *     `abandoned` with no current question, `/start` now returns the fresh id, the page re-enters
 *     orientation, voice re-arms for the new session (a second proxy.connected), and question 1 is
 *     read again (response #3).
 *
 * Run:
 *   LIVE_VOICE=1 FAKE_AUDIO=/path/answer_padded.wav%noloop E2E_API=http://localhost:8000 \
 *   E2E_ADMIN_USERNAME=... E2E_ADMIN_PASSWORD=... \
 *   npx playwright test bank-linear-restart-live --config=e2e/live.config.ts
 */
import { test, expect, request as pwRequest } from "@playwright/test";
import {
  enterVoiceChannel,
  finishOpenInterview,
  primeCandidateLogin,
  waitForInterviewStage,
} from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
const API = process.env.E2E_API || `${BASE}/api`;
const ACK = /\b(thank|thanks|got it|understood|okay|ok)\b|谢谢|好的|明白|收到/i;

test.describe("Bank linear turns + Start over (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1 to run against real Azure");
  test.skip(!process.env.FAKE_AUDIO, "needs FAKE_AUDIO=<spoken answer wav>%noloop for the fake mic");

  test("bank session is silent between questions, and Start over lands on a fresh session", async ({
    page,
  }) => {
    test.setTimeout(480_000);

    const proxyConnected: Record<string, unknown>[] = [];
    const createResponseFlags: unknown[] = [];
    const created: string[] = [];
    const transcripts: { ws: number; text: string }[] = [];
    const userTranscripts: string[] = [];
    const errors: string[] = [];
    let wsCount = 0;
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      const idx = ++wsCount;
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          const type = msg.type as string | undefined;
          if (!type) return;
          if (type === "proxy.connected") proxyConnected.push(msg);
          if (type === "session.updated") {
            const td = (msg.session as Record<string, unknown> | undefined)?.turn_detection as
              | Record<string, unknown>
              | undefined;
            createResponseFlags.push(td?.create_response);
          }
          if (type === "response.created") {
            created.push(String((msg.response as Record<string, unknown> | undefined)?.id ?? "?"));
          }
          if (type === "response.audio_transcript.done") {
            transcripts.push({ ws: idx, text: String(msg.transcript ?? "") });
          }
          if (type === "conversation.item.input_audio_transcription.completed") {
            userTranscripts.push(String(msg.transcript ?? ""));
          }
          if (type === "error" || type.endsWith(".error")) errors.push(data.slice(0, 300));
        } catch {
          /* binary / non-JSON */
        }
      });
    });

    const token = await primeCandidateLogin(page); // fresh: any open interview of user1 is closed
    try {
      await page.goto(`${BASE}/interview`);

      // ---- 1. start → linear turns reported, Azure accepts create_response=false -------------
      const startResp = page.waitForResponse(
        (r) => r.url().includes("/candidate/interview/start") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: /开始面试|start interview/i }).click();
      const start = (await (await startResp).json()) as {
        interview_session_id: string;
        voice_linear_turns: boolean | null;
        voice_default?: boolean;
        external_phase?: string | null;
        current_question: { prompt: string; index: number } | null;
      };
      expect(start.external_phase ?? null).toBeNull(); // a BANK session
      expect(start.voice_linear_turns).toBe(true);
      const iv1 = start.interview_session_id;
      const q1 = start.current_question?.prompt ?? "";
      expect(q1).not.toBe("");
      console.log(`[live] iv1=${iv1} voice_default=${start.voice_default} Q1="${q1.slice(0, 80)}…"`);

      // The voice-configured persona prewarms voice on the orientation screen.
      await expect
        .poll(() => proxyConnected.length, { timeout: 60_000, message: "no proxy.connected" })
        .toBeGreaterThan(0);
      expect(proxyConnected[0].linear_turns).toBe(true);
      await expect
        .poll(() => createResponseFlags.length, { timeout: 30_000, message: "no session.updated" })
        .toBeGreaterThan(0);
      expect(createResponseFlags[0], "Azure must echo create_response=false").toBe(false);

      // ---- 2. Q1 read once; the spoken answer produces NO model turn ------------------------
      await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
      await waitForInterviewStage(page);
      await enterVoiceChannel(page);
      await expect
        .poll(() => transcripts.length, { timeout: 90_000, message: "question 1 was never read" })
        .toBeGreaterThanOrEqual(1);
      console.log(`[live] read #1: "${transcripts[0].text.slice(0, 80)}…"`);
      expect(created.length).toBe(1);

      // The fake mic speaks at ~45s after getUserMedia; wait for Azure's transcription of it.
      await expect
        .poll(() => userTranscripts.join(" "), {
          timeout: 150_000,
          message: "the spoken answer was never transcribed",
        })
        .toMatch(/runbook|inspection|deployment/i);
      console.log(`[live] candidate transcript: "${userTranscripts.join(" | ")}"`);
      // Under the OLD contract this is exactly where "Thank you." arrived. Give Azure 15s.
      await page.waitForTimeout(15_000);
      expect(
        created.length,
        `extra model turn(s) after the candidate spoke: ${JSON.stringify(transcripts)}`,
      ).toBe(1);

      // ---- 3. I'm done → answer submitted → next question read (response #2) ----------------
      const answerResp = page.waitForResponse((r) =>
        r.url().includes(`/candidate/interview/${iv1}/answer`),
      );
      await page.getByRole("button", { name: /我答完了|i'm done answering/i }).click();
      const answered = (await (await answerResp).json()) as {
        current_question: { prompt: string; is_follow_up?: boolean } | null;
        status: string;
      };
      expect(answered.status).toBe("in_progress");
      const q2 = answered.current_question?.prompt ?? "";
      console.log(
        `[live] next: follow_up=${answered.current_question?.is_follow_up ?? false} "${q2.slice(0, 80)}…"`,
      );
      await expect
        .poll(() => transcripts.length, { timeout: 90_000, message: "question 2 was never read" })
        .toBeGreaterThanOrEqual(2);
      expect(created.length).toBe(2);
      for (const t of transcripts) expect(t.text, "no acknowledgment ever").not.toMatch(ACK);

      // ---- 4. Start over -----------------------------------------------------------------
      const restartResp = page.waitForResponse((r) => r.url().includes("/restart"));
      await page.getByTestId("candidate-restart").click();
      await page.getByTestId("candidate-restart-confirm").click();
      const fresh = (await (await restartResp).json()) as {
        interview_session_id: string;
        status: string;
        current_question: { prompt: string; index: number } | null;
        voice_linear_turns: boolean | null;
      };
      expect(fresh.interview_session_id).not.toBe(iv1);
      expect(fresh.status).toBe("in_progress");
      expect(fresh.current_question?.index).toBe(0);
      expect(fresh.voice_linear_turns).toBe(true);
      const iv2 = fresh.interview_session_id;
      console.log(`[live] restarted: iv2=${iv2}`);
      await expect(page.getByRole("button", { name: /我准备好了|i'm ready/i })).toBeVisible({
        timeout: 15_000,
      });

      // Backend truth: the old session is abandoned with no question; /start hands back iv2.
      const api = await pwRequest.newContext({ baseURL: API });
      try {
        const sess = await api.post("/public/candidate/session", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const anon = { "X-Anon-Session": (await sess.json()).token as string };
        const old = (await (await api.get(`/candidate/interview/${iv1}`, { headers: anon })).json()) as {
          status: string;
          current_question: unknown;
        };
        expect(old.status).toBe("abandoned");
        expect(old.current_question).toBeNull();
        const again = (await (
          await api.post("/candidate/interview/start", { headers: anon })
        ).json()) as { interview_session_id: string };
        expect(again.interview_session_id).toBe(iv2);
        expect((await api.get(`/candidate/interview/${iv1}/review`, { headers: anon })).status()).toBe(
          409,
        );
      } finally {
        await api.dispose();
      }

      // Voice re-arms for the NEW session and question 1 is read again (response #3).
      await expect
        .poll(() => proxyConnected.length, { timeout: 90_000, message: "voice did not reconnect" })
        .toBeGreaterThanOrEqual(2);
      expect(proxyConnected[1].linear_turns).toBe(true);
      await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
      await waitForInterviewStage(page);
      await expect
        .poll(() => transcripts.length, { timeout: 90_000, message: "question 1 not re-read" })
        .toBeGreaterThanOrEqual(3);
      console.log(`[live] read #3: "${transcripts[2].text.slice(0, 80)}…"`);
      expect(created.length).toBe(3);
      for (const t of transcripts) expect(t.text).not.toMatch(ACK);
      expect(errors, `Azure error frames: ${errors.join(" || ")}`).toEqual([]);
      await expect(page.getByText(/语音不可用|voice unavailable/i)).toHaveCount(0);
    } finally {
      await finishOpenInterview(token).catch(() => undefined);
    }
  });
});
