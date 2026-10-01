/**
 * Can a PURE-AUDIO session be created over WebRTC — not reached by downgrading a video one?
 *
 * This matters for what can be claimed about Voice Live's transport story. Two facts were already
 * established separately: a session with NO avatar configured creates zero RTCPeerConnections and the
 * reply audio arrives as PCM on the WebSocket (series 01 §4.2, measured), and an avatar session can drop
 * its picture mid-call and keep the audio on the existing RTP track (series 12 §6). Neither answers the
 * question here, which is whether the FIRST handshake of a session can be audio-only over WebRTC.
 *
 * The route is the video pin: setVideoPreference("off") before any session exists decides what the next
 * connect() offers, so the very first `session.avatar.connect` carries a video m-line marked a=inactive.
 *
 * What this proves, and what it does not: it shows WebRTC carrying audio alone from the first offer. It
 * still goes through `session.avatar.connect`, so an avatar is still allocated — this is not Azure's
 * native WebRTC entry point (the SDK / WebSocket / WebRTC / SIP interface list), which would not involve
 * the avatar at all and is a separate thing we do not implement.
 *
 * REQUIRES a default bank with at least TURNS+1 questions, and says so if it is not: the cold start
 * consumes one question and each turn consumes another. On a 2-question bank the loop reported a silent
 * turn that was simply the interview ending correctly — a test-setup artefact that reads exactly like a
 * product bug, so the count is asserted up front instead.
 */
import { expect, test } from "@playwright/test";

import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
const TURNS = Number(process.env.TURNS ?? 3);

test.describe("Pure-audio WebRTC from the first handshake (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");

  test("creates an audio-only WebRTC session and times it", async ({ page }) => {
    test.setTimeout(120_000 + TURNS * 120_000);

    const marks: { name: string; t: number }[] = [];
    const mark = (n: string) => {
      if (!marks.some((m) => m.name === n)) marks.push({ name: n, t: Date.now() });
    };
    let offerSdp = "";
    let heardCount = 0;
    let micFrames = 0;
    let readsSent = 0;
    let readsCreated = 0;
    let readsDone = 0;
    let heard = "";
    const errors: string[] = [];

    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framesent", (f) => {
        const d = typeof f.payload === "string" ? f.payload : "";
        if (!d) return;
        try {
          const m = JSON.parse(d) as Record<string, unknown>;
          if (m.type === "session.avatar.connect") {
            mark("avatar_connect_sent");
            // The offer is base64 SDP; keep it so the m-lines can be inspected directly.
            const sdp = (m as { client_sdp?: string; clientSdp?: string }).client_sdp ?? (m as { clientSdp?: string }).clientSdp ?? "";
            if (sdp && !offerSdp) {
              try {
                offerSdp = atob(sdp);
              } catch {
                offerSdp = sdp;
              }
            }
          }
          if (m.type === "response.create") { mark("read_sent"); readsSent += 1; }
        } catch {
          micFrames += 1; // binary mic frame
        }
      });
      ws.on("framereceived", (f) => {
        const d = typeof f.payload === "string" ? f.payload : "";
        if (!d) return;
        try {
          const m = JSON.parse(d) as Record<string, unknown>;
          const t = m.type as string | undefined;
          if (t === "session.avatar.connecting") mark("avatar_answer");
          if (t === "response.created") { mark("read_created"); readsCreated += 1; }
          if (t === "response.done") readsDone += 1;
          if (t === "conversation.item.input_audio_transcription.completed") {
            heard = String((m as { transcript?: string }).transcript ?? "");
            heardCount += 1;
          }
          if (t === "error") errors.push(d.slice(0, 200));
        } catch {
          /* binary */
        }
      });
    });

    await page.addInitScript(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[]; __pcCount: number };
      w.__pcs = [];
      w.__pcCount = 0;
      const O = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends O {
        constructor(...a: unknown[]) {
          // @ts-expect-error passthrough
          super(...a);
          w.__pcs.push(this);
          w.__pcCount += 1;
        }
      } as unknown as typeof RTCPeerConnection;
    });

    const audio = async (): Promise<{ level: number; videoBytes: number; audioBytes: number }> =>
      page.evaluate(async () => {
        const w = window as unknown as { __pcs: RTCPeerConnection[] };
        const acc = { level: 0, videoBytes: 0, audioBytes: 0 };
        for (const pc of w.__pcs) {
          if (pc.connectionState !== "connected") continue;
          const r = await pc.getStats();
          r.forEach((st) => {
            const row = st as unknown as Record<string, unknown>;
            if (row.type !== "inbound-rtp") return;
            if (row.kind === "audio") {
              if (typeof row.audioLevel === "number") acc.level = Math.max(acc.level, row.audioLevel as number);
              if (typeof row.bytesReceived === "number") acc.audioBytes += row.bytesReceived as number;
            }
            if (row.kind === "video" && typeof row.bytesReceived === "number") {
              acc.videoBytes += row.bytesReceived as number;
            }
          });
        }
        return acc;
      });

    const waitForVoice = async (budget: number): Promise<number | null> => {
      const until = Date.now() + budget;
      while (Date.now() < until) {
        if ((await audio()).level > 0.05) return Date.now();
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const waitForQuiet = async (budget: number): Promise<void> => {
      const until = Date.now() + budget;
      let q = 0;
      while (Date.now() < until && q < 6) {
        q = (await audio()).level <= 0.05 ? q + 1 : 0;
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    const startResp = page.waitForResponse(
      (r) => r.url().includes("/candidate/interview/start") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    // The count lives on the current question (QuestionOut.total), not at the top level.
    const started = (await (await startResp).json()) as { current_question?: { total?: number } | null };
    const qTotal = started.current_question?.total ?? 0;
    console.log(`  bank questions: ${qTotal} (need >= ${TURNS + 1}: 1 for the cold start + 1 per turn)`);
    expect(
      qTotal,
      `the default bank has ${qTotal} questions; with ${TURNS} turns the interview ends mid-run and the silence looks like a bug`,
    ).toBeGreaterThanOrEqual(TURNS + 1);
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);

    // Pin audio-only BEFORE any session exists, so the first offer is the audio-only one.
    const toggle = page.getByTestId("voice-video-toggle");
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    const view = page.locator('[data-testid="avatar-view"]');
    await expect(view).toHaveAttribute("data-media-mode", "audio-only", { timeout: 30_000 });
    mark("pinned_audio_only");

    const t0 = Date.now();
    await enterVoiceChannel(page);
    const firstVoice = await waitForVoice(150_000);
    const coldMs = firstVoice === null ? null : firstVoice - t0;

    const state = await audio();
    const pcCount = await page.evaluate(() => (window as unknown as { __pcCount: number }).__pcCount);
    // Report the CAPTURE first. "No m=video line" and "the SDP never reached this probe" look identical
    // in the output otherwise, and only one of them is a finding about Azure.
    // No claim about m-lines: `client_sdp`'s encoding was never established (a decode produced 7799
    // chars with zero "m=" lines, which means the shape is not what this probe assumed — likely base64
    // around JSON whose newlines are escaped). The transport question is answered by the RTP counters
    // below, which need no SDP parsing at all.
    const sdpNote = `${offerSdp.length} chars captured, shape unverified — no m-line claim made`;

    console.log("\n===== PURE-AUDIO WebRTC: WAS IT ACTUALLY WebRTC? =====");
    console.log(`  RTCPeerConnection objects created : ${pcCount}`);
    console.log(`  session.avatar.connect sent       : ${marks.some((m) => m.name === "avatar_connect_sent") ? "yes" : "no"}`);
    console.log(`  offer SDP                        : ${sdpNote}`);
    console.log(`  inbound AUDIO bytes over RTP     : ${state.audioBytes}`);
    console.log(`  inbound VIDEO bytes over RTP     : ${state.videoBytes}`);
    console.log(`  cold start: pin → voice audible  : ${coldMs === null ? "NOT HEARD" : `${coldMs}ms`}`);

    const results: number[] = [];
    const doneBtn = page.getByRole("button", { name: /我说完了|i'm done answering/i });
    if (process.env.FAKE_AUDIO) {
      await waitForQuiet(60_000);
      for (let turn = 1; turn <= TURNS; turn++) {
        const seen = heardCount;
        const micAt = micFrames;
        try {
          await expect.poll(() => heardCount, { timeout: 90_000, intervals: [1000] }).toBeGreaterThan(seen);
        } catch {
          const mode = await view.getAttribute("data-media-mode");
          console.log(
            `  turn ${turn}: no new transcript in 90s — mic frames since: ${micFrames - micAt}, media-mode=${mode}, errors=${errors.length}`,
          );
          break;
        }
        console.log(`  [turn ${turn}] answer heard: ${JSON.stringify(heard.slice(0, 50))}`);
        await expect(doneBtn).toBeEnabled({ timeout: 60_000 });
        const tS = Date.now();
        await doneBtn.click();
        const v = await waitForVoice(60_000);
        console.log(
          `  turn ${turn}: submit → voice audible   ${v === null ? "NOT HEARD" : `${v - tS}ms`}` +
            `   (reads sent/created/done so far: ${readsSent}/${readsCreated}/${readsDone})`,
        );
        if (v !== null) results.push(v - tS);
        await waitForQuiet(60_000);
      }
    } else {
      console.log("  (set FAKE_AUDIO to also measure per-turn latency)");
    }
    if (errors.length) console.log(`  errors: ${errors[0]}`);
    console.log("======================================================\n");

    // The claim under test: WebRTC was created, and it carried audio with no video.
    expect(pcCount, "no RTCPeerConnection means this was not WebRTC").toBeGreaterThan(0);
    expect(state.audioBytes, "no audio arrived over RTP").toBeGreaterThan(0);
    expect(state.videoBytes, "a pure-audio session must carry no video").toBe(0);
    expect(coldMs, "the first question never became audible").not.toBeNull();
  });
});
