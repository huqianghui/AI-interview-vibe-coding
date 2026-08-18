/**
 * LIVE Azure Voice Live round-trip E2E (opt-in, real Azure — NOT part of CI).
 *
 * The default Playwright config runs mock-only (zero Azure). This spec instead drives the REAL
 * running dev servers (frontend :5173 → backend :8000 with real Foundry credentials) to verify the
 * full voice path: clicking 语音作答 connects the interviewer's Foundry agent, Azure streams the
 * avatar + agent audio, and the UI never falls back to "Voice unavailable".
 *
 * TRANSPORT NOTE (v0.26+): voice was migrated to a BACKEND WebSocket proxy (`voice_live_proxy.py`)
 * so avatar VIDEO works — the browser no longer connects directly to Azure's `voice-live/realtime`.
 * The browser opens a single WS at `/api/voice-live/ws`; the backend holds the Azure SDK connection
 * and relays every Voice Live server event (plus its own `proxy.connected` bootstrap frame). So this
 * spec asserts on the frames the browser receives over `/api/voice-live/ws` — NOT a browser-side
 * `voice-live/realtime` WS (that URL no longer exists on the browser side; asserting on it would
 * always time out with zero frames). See `useInterviewVoice.ts` header.
 *
 * Mic: Chromium fake-media flags make getUserMedia succeed with a synthetic device, so no real
 * microphone/human is needed.
 *
 * Run: `LIVE_VOICE=1 BASE=http://localhost:5173 npx playwright test voice-live-azure --config=e2e/live.config.ts`
 * (see e2e/live.config.ts). Skipped entirely unless LIVE_VOICE=1.
 */
import { test, expect } from "@playwright/test";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

test.describe("Voice Live agent-mode (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1 to run against real Azure");

  test("语音作答 connects the Foundry agent over the WS proxy (proxy.connected → avatar ice → transcript, no fallback)", async ({
    page,
  }) => {
    // Collect frames the BACKEND PROXY relays to the browser over /api/voice-live/ws.
    const frames: string[] = [];
    let proxyConnected = false;
    let avatarIceServers = false;
    let transcriptStreamed = false;
    let errorFrame: string | null = null;

    page.on("websocket", (ws) => {
      if (!/voice-live\/ws/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          const type = msg.type as string | undefined;
          if (!type) return;
          frames.push(type);
          if (type === "proxy.connected") proxyConnected = true;
          if (type === "session.updated") {
            const session = msg.session as Record<string, unknown> | undefined;
            const avatar = session?.avatar as Record<string, unknown> | undefined;
            const ice = (avatar?.ice_servers as unknown[] | undefined) ?? [];
            if (avatar && ice.length > 0) avatarIceServers = true;
          }
          if (type === "response.audio_transcript.delta") transcriptStreamed = true;
          // A Voice Live rejection surfaces as an `error` frame (or a *.error type).
          if (type === "error" || type.endsWith(".error")) {
            errorFrame = data.slice(0, 300);
          }
        } catch {
          /* non-JSON / binary frame */
        }
      });
    });

    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByRole("textbox")).toBeVisible();

    // Click 语音作答 (Answer by voice) → the hook opens the WS proxy; the backend brokers the Azure
    // Voice Live agent session and relays frames back.
    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

    // The mic-permission dialog must NOT appear (fake device grants getUserMedia).
    await expect(page.getByText(/需要麦克风权限|microphone/i)).toHaveCount(0, { timeout: 5_000 });

    // 1) The backend proxy connected to Azure and acknowledged the initial session.update.
    await expect
      .poll(() => (proxyConnected ? "ok" : errorFrame ? `err:${errorFrame}` : "pending"), {
        timeout: 40_000,
        message: "backend proxy never sent proxy.connected (check backend log for the Azure connect)",
      })
      .toBe("ok");

    // 2) Azure delivered the avatar block with ICE servers (the video handshake can start) AND the
    //    agent actually started speaking (transcript deltas stream). Both prove a real, working turn.
    await expect
      .poll(() => avatarIceServers && transcriptStreamed, {
        timeout: 60_000,
        message: "no avatar ice_servers and/or no transcript deltas — agent turn did not stream",
      })
      .toBe(true);

    // 3) No agent/session rejection was surfaced.
    expect(errorFrame, `Azure rejected the session: ${errorFrame}`).toBeNull();

    // 4) The UI did NOT fall back to the text-only "Voice unavailable" notice, and left "connecting".
    await expect(page.getByText(/语音不可用|voice unavailable/i)).toHaveCount(0);
    await expect(page.getByText(/连接中|connecting/i)).toHaveCount(0, { timeout: 10_000 });
  });
});
