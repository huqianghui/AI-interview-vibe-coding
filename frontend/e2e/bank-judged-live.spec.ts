/**
 * LIVE judged-turn-mode round-trip (issue #114, opt-in, real Azure + real judge model — NOT in CI).
 *
 * Builds its OWN default bank (Q1 with a 3-item rubric and max_follow_ups=1, Q2) and flips the
 * default persona to `judged` for the run, then drives one of three spoken-answer fixtures through
 * the real stack (frontend :5173 → backend :8000 → Azure Voice Live + the judge LLM):
 *
 *   JUDGED_CASE=incomplete  answer covers every required point but one → during the pause the judge
 *                           asks ONE guiding follow-up (header switches, it is read aloud); "I'm done"
 *                           then advances to Q2 with no further utterance.
 *   JUDGED_CASE=complete    answer covers everything → the judge stays silent (only `wait`), Q1 is
 *                           read exactly once, "I'm done" advances.
 *   JUDGED_CASE=pause       answer stops mid-thought for 12 s → exactly one spoken nudge, the
 *                           candidate continues, "I'm done" advances.
 *
 * Run (one case per run — the fake mic file is a browser launch flag):
 *   LIVE_VOICE=1 JUDGED_CASE=incomplete FAKE_AUDIO=/path/answer_incomplete.wav%noloop \
 *   E2E_API=http://localhost:8000 E2E_ADMIN_USERNAME=... E2E_ADMIN_PASSWORD=... \
 *   npx playwright test bank-judged-live --config=e2e/live.config.ts
 */
import { test, expect } from "@playwright/test";
import {
  adminApi,
  enterVoiceChannel,
  finishOpenInterview,
  primeCandidateLogin,
  waitForInterviewStage,
} from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const CASE = (process.env.JUDGED_CASE || "") as "incomplete" | "complete" | "pause" | "";
const BASE = process.env.BASE || "http://localhost:5173";
const ACK = /\b(thank|thanks|got it|understood)\b|谢谢|好的|明白|收到/i;

const Q1 = "Describe how you handle a protocol deviation discovered during monitoring.";
const Q2 = "How do you prepare a site for a close-out visit?";
const RUBRIC = [
  { kind: "required", text: "Documents the deviation in the site log the same day", weight: 50 },
  { kind: "required", text: "Notifies the sponsor or medical monitor", weight: 30 },
  { kind: "recommended", text: "Assesses impact on subject safety and data integrity", weight: 20 },
];

let personaId = "";
let originalPersona: Record<string, unknown> = {};
let originalDefaultBank: string | null = null;

test.describe("Judged turns (real Azure + real judge)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.skip(!CASE, "set JUDGED_CASE=incomplete|complete|pause (and FAKE_AUDIO to the matching wav)");

  test.beforeAll(async () => {
    if (!LIVE || !CASE) return;
    const { api, headers } = await adminApi();
    try {
      const personas = (await (await api.get("/admin/personas", { headers })).json()) as Array<
        Record<string, unknown> & { id: string; is_default: boolean }
      >;
      const def = personas.find((p) => p.is_default)!;
      personaId = def.id;
      originalPersona = {
        bank_turn_mode: def.bank_turn_mode,
        judge_silence_seconds: def.judge_silence_seconds,
        judge_max_calls_per_question: def.judge_max_calls_per_question,
      };
      const banks = (await (await api.get("/admin/question-banks", { headers })).json()) as Array<{
        bank_id: string;
        is_default: boolean;
      }>;
      originalDefaultBank = banks.find((b) => b.is_default)?.bank_id ?? null;
      const bank = (await (
        await api.post("/admin/question-banks", {
          headers,
          data: { name: `E2E Judged ${Date.now()}`, language: "en-US", is_default: false },
        })
      ).json()) as { bank_id: string };
      const q1 = (await (
        await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
          headers,
          data: { text: Q1, language: "en-US", expected_points: [], max_follow_ups: 1 },
        })
      ).json()) as { question_id: string };
      await api.post(`/admin/question-banks/${bank.bank_id}/questions`, {
        headers,
        data: { text: Q2, language: "en-US", expected_points: [], max_follow_ups: 0 },
      });
      // A checklist row must exist before items can be replaced: draft (real provider), then PUT.
      const draft = (await (
        await api.post(`/admin/checklists/questions/${q1.question_id}/draft`, { headers, data: {} })
      ).json()) as { checklist_id: string };
      const put = await api.put(`/admin/checklists/${draft.checklist_id}/items`, {
        headers,
        data: { items: RUBRIC },
      });
      expect(put.ok(), `rubric PUT failed: ${put.status()} ${await put.text()}`).toBeTruthy();
      expect((await api.post(`/admin/question-banks/${bank.bank_id}/default`, { headers })).ok()).toBeTruthy();
      const flip = await api.put(`/admin/personas/${personaId}`, {
        headers,
        data: { bank_turn_mode: "judged", judge_silence_seconds: 2, judge_max_calls_per_question: 2 },
      });
      expect(flip.ok(), `persona flip failed: ${flip.status()} ${await flip.text()}`).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test.afterAll(async () => {
    if (!LIVE || !CASE || !personaId) return;
    const { api, headers } = await adminApi();
    try {
      await api.put(`/admin/personas/${personaId}`, { headers, data: originalPersona });
      if (originalDefaultBank) {
        await api.post(`/admin/question-banks/${originalDefaultBank}/default`, { headers });
      }
    } finally {
      await api.dispose();
    }
  });

  test(`judged session — ${CASE} answer`, async ({ page }) => {
    test.setTimeout(480_000);
    const created: string[] = [];
    const transcripts: string[] = [];
    const userTranscripts: string[] = [];
    const judgeResults: { verdict: string; speech_text: string }[] = [];
    const errors: string[] = [];
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          const type = msg.type as string | undefined;
          if (type === "response.created") created.push("r");
          if (type === "response.audio_transcript.done") transcripts.push(String(msg.transcript ?? ""));
          if (type === "conversation.item.input_audio_transcription.completed") {
            userTranscripts.push(String(msg.transcript ?? ""));
          }
          if (type === "error" || type?.endsWith(".error")) errors.push(data.slice(0, 300));
        } catch {
          /* binary */
        }
      });
    });
    page.on("response", (r) => {
      if (/\/candidate\/interview\/[^/]+\/judge$/.test(r.url()) && r.ok()) {
        void r
          .json()
          .then((j: { verdict: string; speech_text: string }) => {
            judgeResults.push({ verdict: j.verdict, speech_text: j.speech_text });
            console.log(`[live] judge → ${j.verdict} ${JSON.stringify(j.speech_text)}`);
          })
          .catch(() => undefined);
      }
    });

    const token = await primeCandidateLogin(page);
    try {
      await page.goto(`${BASE}/interview`);
      const startResp = page.waitForResponse(
        (r) => r.url().includes("/candidate/interview/start") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: /开始面试|start interview/i }).click();
      const start = (await (await startResp).json()) as {
        interview_session_id: string;
        voice_judge_silence_seconds: number | null;
        voice_linear_turns: boolean | null;
        current_question: { prompt: string } | null;
      };
      expect(start.current_question?.prompt).toBe(Q1);
      expect(start.voice_linear_turns).toBe(true);
      expect(start.voice_judge_silence_seconds).toBe(2);
      const iv1 = start.interview_session_id;

      await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
      await waitForInterviewStage(page);
      await enterVoiceChannel(page);
      await expect.poll(() => transcripts.length, { timeout: 90_000, message: "Q1 never read" }).toBe(1);
      console.log(`[live] read #1: ${JSON.stringify(transcripts[0].slice(0, 80))}`);

      // The fake mic speaks at ~45 s; wait for Azure's transcription of the answer.
      await expect
        .poll(() => userTranscripts.join(" "), { timeout: 150_000, message: "answer never transcribed" })
        .toMatch(/deviation|site log/i);

      if (CASE === "incomplete") {
        // The pause after the answer → judge follow-up (the ONLY missing required point is the
        // sponsor notification) → header switches and the follow-up is read aloud.
        await expect
          .poll(() => judgeResults.some((j) => j.verdict === "follow_up"), {
            timeout: 40_000,
            message: `no follow_up verdict; got ${JSON.stringify(judgeResults)}`,
          })
          .toBe(true);
        const fu = judgeResults.find((j) => j.verdict === "follow_up")!;
        await expect(page.getByText(fu.speech_text)).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => transcripts.length, { timeout: 60_000 }).toBe(2);
        expect(transcripts[1].toLowerCase()).toContain(fu.speech_text.toLowerCase().slice(0, 20));
        for (const r of RUBRIC) expect(fu.speech_text.toLowerCase()).not.toContain(r.text.toLowerCase());
      } else if (CASE === "complete") {
        // Give the judge window + LLM time to run; it must stay silent.
        await page.waitForTimeout(20_000);
        expect(judgeResults.every((j) => j.verdict === "wait"), JSON.stringify(judgeResults)).toBe(true);
        expect(transcripts.length).toBe(1);
      } else {
        // pause: the mid-thought stop → exactly one spoken nudge; then the candidate continues.
        await expect
          .poll(() => judgeResults.some((j) => j.verdict === "nudge"), {
            timeout: 40_000,
            message: `no nudge verdict; got ${JSON.stringify(judgeResults)}`,
          })
          .toBe(true);
        await expect.poll(() => transcripts.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
        await expect
          .poll(() => userTranscripts.join(" "), { timeout: 60_000, message: "second half not transcribed" })
          .toMatch(/sponsor|medical monitor|data integrity/i);
        expect(judgeResults.filter((j) => j.verdict === "nudge").length).toBe(1);
      }

      // "I'm done" ALWAYS advances — no judge call at commit, Q2 is read next, no acknowledgment.
      const before = transcripts.length;
      const answerResp = page.waitForResponse((r) => r.url().includes(`/candidate/interview/${iv1}/answer`));
      await page.getByRole("button", { name: /我答完了|i'm done answering/i }).click();
      const answered = (await (await answerResp).json()) as { current_question: { prompt: string } | null };
      expect(answered.current_question?.prompt).toBe(Q2);
      await expect.poll(() => transcripts.length, { timeout: 60_000, message: "Q2 never read" }).toBe(before + 1);
      expect(transcripts[transcripts.length - 1].toLowerCase()).toContain("close-out");
      for (const t of transcripts) expect(t, "no acknowledgment ever").not.toMatch(ACK);
      expect(errors, errors.join(" || ")).toEqual([]);
      console.log(`[live] ${CASE}: judge=${JSON.stringify(judgeResults.map((j) => j.verdict))} reads=${transcripts.length}`);
    } finally {
      await finishOpenInterview(token).catch(() => undefined);
    }
  });
});
