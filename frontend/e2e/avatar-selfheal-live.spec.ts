/**
 * LIVE avatar self-heal (opt-in, real Azure — NOT part of CI).
 *
 * Azure honours `session.avatar.connect` once per Voice Live session. The self-heal used to answer an
 * avatar media drop by re-offering on the SAME session, and Azure refused every one of those with
 * `webrtc_connection_invalid` ("WebRTC connection is in connected state") — 12 of 12 in production on
 * 2026-10-14, each spending the avatar rate-limit allowance. It now rebuilds the whole session: once
 * more with the avatar after a drop of media that had flowed, and VOICE-ONLY (no avatar session, the
 * interviewer's voice over the WebSocket) when the avatar's media never flowed at all.
 *
 * Both tests assert against Azure's own frames: every session sends exactly ONE avatar offer, Azure
 * answers it, and nothing is refused.
 *   A. The picture is up, then the avatar's ICE "fails" (the getter is shadowed and the handler fired —
 *      the signal a dead TURN path produces): a rebuilt session paints again. Needs a network that can
 *      carry the avatar; it skips itself, saying so, on one that cannot.
 *   B. The avatar's ICE never connects (the production shape behind a secure-access client, forced so
 *      it runs on any network): ONE avatar session, then a voice-only session (`avatar=off`) in which
 *      the interviewer is actually heard — PCM arriving on the WebSocket.
 *
 *   C. Nothing forced: whatever THIS network does. On a network that blocks the avatar's WebRTC (run it
 *      with the secure-access client on), it must end voice-only with the interviewer heard and a
 *      `voice.fallback` saying why; on one that carries it, the picture paints and nothing falls back.
 *      Telemetry is read without reaching Azure: start the backend with a connection string whose
 *      IngestionEndpoint is https://fake-ingest.invalid/ and the page's batches are intercepted here.
 *
 * Run: E2E_API=http://127.0.0.1:8000 BASE=http://localhost:5173 E2E_ADMIN_USERNAME=… E2E_ADMIN_PASSWORD=…
 *      LIVE_VOICE=1 npx playwright test avatar-selfheal-live --config=e2e/live.config.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

interface Session {
  offersSent: number;
  answers: number;
  errors: string[];
}

/** Record every Voice Live session the page opens, and the hooks' own narration (printed when a step
 * fails: it says which leg of the handshake stalled). */
function watch(page: Page) {
  const sessions: Session[] = [];
  const logs: string[] = [];
  page.on("console", (m) => {
    if (/\[avatar-stream\]|\[voice\]/.test(m.text())) logs.push(m.text().slice(0, 240));
  });
  page.on("websocket", (ws) => {
    if (!/voice-live\/ws/.test(ws.url())) return;
    const s: Session = { offersSent: 0, answers: 0, errors: [] };
    sessions.push(s);
    const parse = (payload: string | Buffer) => {
      if (typeof payload !== "string") return null;
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    ws.on("framesent", (f) => {
      if (parse(f.payload)?.type === "session.avatar.connect") s.offersSent += 1;
    });
    ws.on("framereceived", (f) => {
      const msg = parse(f.payload);
      if (!msg) return;
      if (msg.type === "session.avatar.connecting") s.answers += 1;
      if (msg.type === "error") s.errors.push(JSON.stringify(msg.error ?? msg).slice(0, 300));
    });
  });
  const dump = () => `sessions: ${JSON.stringify(sessions)}\n${logs.slice(-40).join("\n")}`;
  return { sessions, logs, dump };
}

/** Every session: one offer, answered, and no refusal — the invariant the old self-heal broke. */
function expectNoReoffer(sessions: Session[]) {
  for (const [i, s] of sessions.entries()) {
    expect(s.offersSent, `session ${i + 1} sent more than one avatar offer`).toBeLessThanOrEqual(1);
  }
  const refused = sessions.flatMap((s) => s.errors).filter((e) => /webrtc_connection_invalid|connected state/i.test(e));
  expect(refused).toEqual([]);
}

async function startVoiceInterview(page: Page) {
  await primeCandidateLogin(page);
  await page.goto(`${BASE}/interview`);
  await page.getByRole("button", { name: /开始面试|start interview/i }).click();
  await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
  await waitForInterviewStage(page);
  await enterVoiceChannel(page);
}

const painting = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="avatar-video"]');
    return !!v && v.videoWidth > 0 && v.srcObject !== null;
  });

test.describe("avatar self-heal (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1 to run against real Azure");

  test("A: a drop after the picture is up rebuilds the session, and the picture comes back", async ({ page }) => {
    test.setTimeout(180_000);
    // Keep every peer connection the page creates, so the test can fail the avatar's.
    await page.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      const all: RTCPeerConnection[] = [];
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = all;
      window.RTCPeerConnection = function (config?: RTCConfiguration) {
        const pc = new Native(config);
        all.push(pc);
        return pc;
      } as unknown as typeof RTCPeerConnection;
      window.RTCPeerConnection.prototype = Native.prototype;
    });
    const { sessions, dump } = watch(page);
    await startVoiceInterview(page);

    try {
      // Wait for the picture on the first session only: a network whose ICE never connects starts the
      // self-heal on its own, and that path is test B's.
      const deadline = Date.now() + 45_000;
      while (!(await painting(page)) && Date.now() < deadline && sessions.length <= 1) {
        await page.waitForTimeout(500);
      }
      test.skip(
        !(await painting(page)) || sessions.length > 1,
        "this network cannot carry the avatar's media (ICE never connects), so there is no picture to drop — test B covers that shape",
      );
      expect(sessions[0].answers).toBe(1);

      const failed = await page.evaluate(() => {
        const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
        const pc = pcs.find((p) => p.iceConnectionState === "connected" || p.iceConnectionState === "completed");
        if (!pc || !pc.oniceconnectionstatechange) return false;
        Object.defineProperty(pc, "iceConnectionState", { get: () => "failed" });
        pc.oniceconnectionstatechange.call(pc, new Event("iceconnectionstatechange"));
        return true;
      });
      expect(failed, "no connected avatar peer connection to fail").toBe(true);

      await expect
        .poll(() => sessions.length >= 2 && sessions[1].answers >= 1, {
          timeout: 60_000,
          message: "no rebuilt session answered an avatar offer",
        })
        .toBe(true);
      await expect.poll(() => painting(page), { timeout: 60_000, message: "frames never painted again" }).toBe(true);
      expectNoReoffer(sessions);
      await expect(page.getByText(/语音不可用|voice unavailable/i)).toHaveCount(0);
    } catch (err) {
      console.log(dump());
      throw err;
    }
  });

  test("B: an avatar whose media never connects falls back to a voice-only session that speaks", async ({ page }) => {
    test.setTimeout(150_000);
    // Every avatar connection "fails" the moment Azure's answer is applied, before a frame can paint.
    await page.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = function (config?: RTCConfiguration) {
        const pc = new Native(config);
        const apply = pc.setRemoteDescription.bind(pc);
        pc.setRemoteDescription = (async (desc: RTCSessionDescriptionInit) => {
          await apply(desc);
          setTimeout(() => {
            Object.defineProperty(pc, "iceConnectionState", { get: () => "failed" });
            pc.oniceconnectionstatechange?.call(pc, new Event("iceconnectionstatechange"));
          }, 0);
        }) as typeof pc.setRemoteDescription;
        return pc;
      } as unknown as typeof RTCPeerConnection;
      window.RTCPeerConnection.prototype = Native.prototype;
    });
    const { sessions, dump } = watch(page);
    const urls: string[] = [];
    const voiceOnlyFrames = { avatarEnabled: null as boolean | null, audioDeltas: 0 };
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      urls.push(ws.url());
      const voiceOnly = new URL(ws.url()).searchParams.get("avatar") === "off";
      ws.on("framereceived", (f) => {
        if (!voiceOnly || typeof f.payload !== "string") return;
        try {
          const msg = JSON.parse(f.payload) as Record<string, unknown>;
          if (msg.type === "proxy.connected") voiceOnlyFrames.avatarEnabled = Boolean(msg.avatar_enabled);
          if (msg.type === "response.audio.delta") voiceOnlyFrames.audioDeltas += 1;
        } catch {
          /* not JSON */
        }
      });
    });
    await startVoiceInterview(page);

    try {
      await expect
        .poll(() => voiceOnlyFrames.audioDeltas, {
          timeout: 90_000,
          message: "no voice-only session, or the interviewer was never heard in it",
        })
        .toBeGreaterThan(0);
      expect(urls, "one avatar session, then one voice-only session").toHaveLength(2);
      expect(new URL(urls[0]).searchParams.get("avatar")).toBeNull();
      expect(new URL(urls[1]).searchParams.get("avatar")).toBe("off");
      expect(voiceOnlyFrames.avatarEnabled, "the backend built it without the avatar").toBe(false);
      expect(sessions.map((s) => s.offersSent), "no avatar offer in the voice-only session").toEqual([1, 0]);
      expect(sessions[0].answers).toBe(1);
      expectNoReoffer(sessions);
      await expect(page.locator('[data-testid="avatar-view"]')).toHaveAttribute("data-media-mode", "voice-only");
      await expect(page.getByTestId("avatar-voice-only-hint")).toBeVisible();
      await expect(page.getByText(/语音不可用|voice unavailable/i)).toHaveCount(0);
      // It stays put: no further session.
      await page.waitForTimeout(10_000);
      expect(urls).toHaveLength(2);
    } catch (err) {
      console.log(dump());
      throw err;
    }
  });

  test("C: on the real network, the interviewer is heard — with the picture, or voice-only and saying why", async ({ page }) => {
    test.setTimeout(150_000);
    // Capture the page's App Insights batches without sending them anywhere.
    const fallbacks: Record<string, unknown>[] = [];
    let ingestRequests = 0;
    type Envelope = { data?: { baseData?: { name?: string; properties?: Record<string, unknown> } } };
    const take = (item: Envelope) => {
      const base = item.data?.baseData;
      if (base?.name === "voice.fallback") fallbacks.push(base.properties ?? {});
    };
    await page.route("https://fake-ingest.invalid/**", async (route) => {
      ingestRequests += 1;
      const body = route.request().postData() ?? "";
      // The SDK posts a JSON array of envelopes; the beacon path may send one envelope per line.
      try {
        const parsed = JSON.parse(body) as Envelope | Envelope[];
        (Array.isArray(parsed) ? parsed : [parsed]).forEach(take);
      } catch {
        for (const line of body.split("\n")) {
          try {
            take(JSON.parse(line) as Envelope);
          } catch {
            /* not JSON */
          }
        }
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"itemsReceived":1,"itemsAccepted":1,"errors":[]}' });
    });
    const { sessions, logs, dump } = watch(page);
    const urls: string[] = [];
    let voiceOnlyAudio = 0;
    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      urls.push(ws.url());
      const voiceOnly = new URL(ws.url()).searchParams.get("avatar") === "off";
      ws.on("framereceived", (f) => {
        if (voiceOnly && typeof f.payload === "string" && f.payload.includes('"response.audio.delta"')) voiceOnlyAudio += 1;
      });
    });
    await startVoiceInterview(page);

    try {
      await expect
        .poll(async () => (await painting(page)) || voiceOnlyAudio > 0, {
          timeout: 90_000,
          message: "neither a painted digital human nor a voice-only session that speaks",
        })
        .toBe(true);
      const picture = await painting(page);
      console.log(`[C] outcome: ${picture ? "PICTURE (this network carries the avatar)" : "VOICE-ONLY"}; sessions=${JSON.stringify(sessions)}; urls=${urls.length}`);
      expectNoReoffer(sessions);
      await expect(page.getByText(/语音不可用|voice unavailable/i)).toHaveCount(0);
      if (picture) return;

      await expect(page.locator('[data-testid="avatar-view"]')).toHaveAttribute("data-media-mode", "voice-only");
      await expect(page.getByTestId("avatar-voice-only-hint")).toBeVisible();
      expect(urls.at(-1) && new URL(urls.at(-1)!).searchParams.get("avatar")).toBe("off");
      // Heard once, so shown once: the dead avatar session's transcript still reached the page, and the
      // re-read must replace that bubble rather than add a second one (owner, live, 2026-10-14).
      await page.waitForTimeout(8_000); // let the re-read's transcript finish
      const transcript = (await page.getByTestId("transcript").innerText()).replace(/\s+/g, " ");
      const question = transcript.match(/Interviewer\s*(.{20,}?[.?!])/)?.[1] ?? "";
      expect(question, `no interviewer question in the transcript: ${transcript.slice(0, 200)}`).not.toBe("");
      expect(transcript.split(question).length - 1, `shown more than once: ${transcript.slice(0, 400)}`).toBe(1);
      // The SDK batches; flush it by leaving the page, then read what it sent.
      await page.goto("about:blank");
      await expect
        .poll(() => fallbacks.length, { timeout: 30_000, message: `no voice.fallback among ${ingestRequests} telemetry requests` })
        .toBeGreaterThan(0);
      console.log(`[C] voice.fallback: ${JSON.stringify(fallbacks)}`);
      console.log(`[C] decisions: ${logs.filter((l) => /media dropped|rate-limited|voice-only/.test(l)).join(" | ")}`);
    } catch (err) {
      console.log(dump());
      throw err;
    }
  });
});
