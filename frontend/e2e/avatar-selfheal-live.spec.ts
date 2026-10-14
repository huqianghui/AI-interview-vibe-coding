/**
 * LIVE avatar self-heal (opt-in, real Azure — NOT part of CI).
 *
 * Azure honours `session.avatar.connect` once per Voice Live session. The self-heal used to answer an
 * avatar media drop by re-offering on the SAME session, and Azure refused every one of those with
 * `webrtc_connection_invalid` ("WebRTC connection is in connected state") — 12 of 12 in production on
 * 2026-10-14, each spending the avatar rate-limit allowance. It now rebuilds the whole session, bounded:
 * video → video → audio-only → orb, three avatar sessions, Azure's allowance per 60 s.
 *
 * Both tests assert against Azure's own frames: every session sends exactly ONE avatar offer, Azure
 * answers it, and nothing is refused.
 *   A. The picture is up, then the avatar's ICE "fails" (the getter is shadowed and the handler fired —
 *      the signal a dead TURN path produces): a rebuilt session paints again. Needs a network that can
 *      carry the avatar; it skips itself, saying so, on one that cannot.
 *   B. ICE never connects on any session (the production shape, forced so it runs on any network): the
 *      self-heal walks the bounded sequence and stops. Start it with no avatar session in the last
 *      60 s on this Speech resource: Azure counts them all, and a fourth is refused. A spends one or
 *      two, so run B on its own (`-g "B:"`) a minute after anything else.
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

  test("B: ICE that never connects walks video → video → audio-only, then stops", async ({ page }) => {
    test.setTimeout(180_000);
    // Every avatar connection "fails" the moment Azure's answer is applied, before a frame can paint:
    // the production shape (ICE checking → failed), on any network.
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
    const { sessions, logs, dump } = watch(page);
    await startVoiceInterview(page);

    try {
      const rebuilds = () => logs.filter((l) => /rebuilding the Voice Live session in/.test(l));
      await expect
        .poll(() => logs.some((l) => /media failed in audio-only .*showing orb/.test(l)), {
          timeout: 120_000,
          message: "the self-heal never reached its end (the orb after the audio-only fallback fails)",
        })
        .toBe(true);
      expect(rebuilds().map((l) => /in (video|audio-only)$/.exec(l)?.[1])).toEqual(["video", "audio-only"]);
      // It stops: no fourth session.
      await page.waitForTimeout(15_000);
      expect(sessions).toHaveLength(3);
      expect(sessions.map((s) => s.answers), "Azure answered every session's single offer").toEqual([1, 1, 1]);
      expectNoReoffer(sessions);
    } catch (err) {
      console.log(dump());
      throw err;
    }
  });
});
