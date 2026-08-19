/**
 * LIVE second-turn audio diagnostic (opt-in, real Azure — NOT part of CI).
 *
 * The "数字人不说话" report shows a MID-SESSION state: the first greeting spoke fine, the user
 * answered, the interviewer's next message appears as TEXT in the transcript — but no speech.
 * This spec reproduces a full turn: Chromium's fake mic plays a real spoken answer WAV
 * (--use-file-for-fake-audio-capture), server-VAD picks it up, and we then measure whether the
 * avatar's WebRTC audio track carries energy during the SECOND agent response, and whether
 * `session.avatar.switch_to_speaking` fires again.
 *
 * Run: LIVE_VOICE=1 npx playwright test audio-turn2 --config=e2e/live.config.ts
 * (live.config.ts adds the fake-audio-capture flag pointing at /tmp/answer-raw.wav)
 */
import { test, expect } from "@playwright/test";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

test.describe("Second-turn audio diagnostic (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");

  test("avatar audio across a full user turn", async ({ page }) => {
    test.setTimeout(300_000);
    const events: string[] = [];
    const frameCounts: Record<string, number> = {};
    let responsesDone = 0;
    let userTranscript = "";
    page.on("console", (msg) => {
      if (/\[voice|\[avatar/.test(msg.text()) || msg.type() === "error")
        events.push(`console ${msg.type()}: ${msg.text()}`);
    });
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as {
            type?: string;
            transcript?: string;
            error?: { message?: string };
            response?: { status?: string; status_details?: unknown; id?: string };
          };
          if (!msg.type) return;
          frameCounts[msg.type] = (frameCounts[msg.type] ?? 0) + 1;
          if (msg.type === "response.done") responsesDone++;
          if (msg.type === "conversation.item.input_audio_transcription.completed")
            userTranscript += ` ${msg.transcript ?? ""}`;
          if (/avatar|error|speech_started|speech_stopped|response\.created|response\.done|response\.cancelled/.test(msg.type)) {
            const status = msg.response
              ? ` status=${msg.response.status} details=${JSON.stringify(msg.response.status_details ?? null).slice(0, 200)}`
              : "";
            events.push(
              `t+${Math.round(performance.timeOrigin ? 0 : 0) || ""}${new Date().toISOString().slice(14, 23)} ws: ${msg.type}${status}${msg.error ? " " + JSON.stringify(msg.error).slice(0, 200) : ""}`,
            );
          }
        } catch {
          /* non-JSON */
        }
      });
    });

    await page.addInitScript(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      w.__pcs = [];
      const OrigPC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OrigPC {
        constructor(...args: unknown[]) {
          // @ts-expect-error passthrough
          super(...args);
          w.__pcs.push(this);
        }
      } as unknown as typeof RTCPeerConnection;
    });

    const sampleAudio = async () => {
      return page.evaluate(async () => {
        const w = window as unknown as { __pcs: RTCPeerConnection[] };
        for (const pc of w.__pcs ?? []) {
          for (const r of pc.getReceivers()) {
            if (r.track?.kind !== "audio") continue;
            const stats = await r.getStats();
            let out: Record<string, unknown> = {};
            stats.forEach((s) => {
              if (s.type === "inbound-rtp" && (s as { kind?: string }).kind === "audio") {
                const st = s as unknown as Record<string, unknown>;
                out = {
                  audioLevel: st.audioLevel,
                  totalAudioEnergy: st.totalAudioEnergy,
                  packetsReceived: st.packetsReceived,
                  trackState: r.track.readyState,
                  trackMuted: r.track.muted,
                  pcState: pc.connectionState,
                };
              }
            });
            return out;
          }
        }
        return null;
      });
    };

    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByRole("textbox")).toBeVisible();
    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

    // Wait for the FIRST agent response to complete (greeting/question spoken).
    await expect.poll(() => responsesDone, { timeout: 60_000 }).toBeGreaterThan(0);
    const turn1Energy = (await sampleAudio()) as { totalAudioEnergy?: number } | null;
    events.push(`--- turn1 audio sample: ${JSON.stringify(turn1Energy)}`);

    // The fake mic file (answer WAV) has been playing since getUserMedia; server-VAD should detect
    // the utterance once the agent stops talking. Capture-only: wait but don't fail, we want the
    // dump regardless.
    let deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(userTranscript.trim().length > 0 || responsesDone >= 2)) {
      await page.waitForTimeout(1000);
    }
    events.push(`--- user transcript: "${userTranscript.trim().slice(0, 120)}" responsesDone=${responsesDone}`);

    // Click "I'm done answering" — the real user flow: commitAnswer drains the transcript, submits
    // it, the backend advances the question pointer, and the page calls speakQuestion(next prompt).
    const doneBtn = page.getByRole("button", { name: /我答完了|i'm done/i });
    if (await doneBtn.isVisible().catch(() => false)) {
      await doneBtn.click();
      events.push("--- clicked I'm done answering");
    }

    // Wait (softly) for the SECOND spoken response (the next question read aloud).
    deadline = Date.now() + 60_000;
    while (Date.now() < deadline && responsesDone < 2) {
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(4_000);
    const turn2Energy = (await sampleAudio()) as { totalAudioEnergy?: number } | null;
    events.push(`--- turn2 audio sample: ${JSON.stringify(turn2Energy)}`);
    await page.waitForTimeout(6_000);
    const turn2EnergyLater = (await sampleAudio()) as { totalAudioEnergy?: number } | null;
    events.push(`--- turn2 audio sample later: ${JSON.stringify(turn2EnergyLater)}`);

    // Grab the on-screen question + transcript so we can correlate "text shown but not spoken".
    const uiState = await page.evaluate(() => ({
      question: document.querySelector("h2, h3")?.textContent ?? "",
      bodyHasError: /没听到|不可用|error/i.test(document.body.innerText),
    }));
    events.push(`--- ui: ${JSON.stringify(uiState)}`);

    const audioEls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("audio")).map((a) => ({
        paused: a.paused,
        muted: a.muted,
        volume: a.volume,
        readyState: a.readyState,
        hasSrcObject: !!a.srcObject,
        currentTime: a.currentTime,
      })),
    );

    console.log("\n========== TURN-2 AUDIO DIAGNOSTIC ==========");
    console.log("WS frame counts:", JSON.stringify(frameCounts, null, 2));
    console.log("turn1 energy:", JSON.stringify(turn1Energy));
    console.log("turn2 energy (early):", JSON.stringify(turn2Energy));
    console.log("turn2 energy (later):", JSON.stringify(turn2EnergyLater));
    console.log("hidden <audio> elements:", JSON.stringify(audioEls, null, 2));
    console.log("event timeline:");
    events.forEach((l) => console.log("   ", l));
    console.log("=============================================\n");

    expect(true).toBe(true);
  });
});
