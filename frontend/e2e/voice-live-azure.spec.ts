/**
 * LIVE Azure Voice Live round-trip E2E (opt-in, real Azure — NOT part of CI).
 *
 * The default Playwright config runs mock-only (zero Azure). This spec instead drives the REAL
 * running dev servers (frontend :5173 → backend :8000 with real Foundry credentials) to verify the
 * fix for "Voice unavailable": that clicking 语音作答 actually connects to the interviewer's Foundry
 * agent over WebRTC and Azure returns an SDP answer (agent initialized), rather than falling back.
 *
 * Mic: Chromium fake-media flags make getUserMedia succeed with a synthetic device, so no real
 * microphone/human is needed. We capture the signaling WebSocket frames to prove Azure accepted the
 * agent session (`rtc.call.sdp.created`) and never sent a rejection (`rtc.call.error`/`error`), and
 * assert the UI leaves the "connecting" state without showing the "Voice unavailable" notice.
 *
 * Run: `LIVE_VOICE=1 BASE=http://localhost:5173 npx playwright test voice-live-azure --config=e2e/live.config.ts`
 * (see e2e/live.config.ts). Skipped entirely unless LIVE_VOICE=1.
 */
import { test, expect } from "@playwright/test";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";

test.describe("Voice Live agent-mode (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1 to run against real Azure");

  test("语音作答 connects to the Foundry agent (SDP answer, no unavailable fallback)", async ({
    page,
  }) => {
    // Collect signaling WebSocket frames to the Voice Live realtime endpoint.
    const wsEvents: string[] = [];
    let sdpAnswered = false;
    let callError: string | null = null;
    page.on("websocket", (ws) => {
      if (!/voice-live\/realtime/.test(ws.url())) return;
      ws.on("framereceived", (f) => {
        const data = typeof f.payload === "string" ? f.payload : "";
        if (!data) return;
        try {
          const msg = JSON.parse(data) as { type?: string; error?: { message?: string } };
          if (msg.type) wsEvents.push(msg.type);
          if (msg.type === "rtc.call.sdp.created") sdpAnswered = true;
          if (msg.type === "rtc.call.error" || msg.type === "error") {
            callError = msg.error?.message ?? msg.type;
          }
        } catch {
          /* non-JSON frame */
        }
      });
    });

    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await expect(page.getByRole("textbox")).toBeVisible();

    // Click 语音作答 (Answer by voice) → the hook brokers a session and opens the signaling WS.
    await page.getByRole("button", { name: /语音作答|answer by voice/i }).click();

    // The mic-permission dialog must NOT appear (fake device grants getUserMedia).
    await expect(page.getByText(/需要麦克风权限|microphone/i)).toHaveCount(0, { timeout: 5_000 });

    // Wait until Azure returns an SDP answer (agent initialized + WebRTC negotiated), OR a rejection.
    await expect
      .poll(() => (sdpAnswered ? "ok" : callError ? `err:${callError}` : "pending"), {
        timeout: 40_000,
        message: `signaling frames seen: ${JSON.stringify(wsEvents)}`,
      })
      .toBe("ok");

    // No agent/session rejection was surfaced.
    expect(callError, `Azure rejected the session: ${callError}`).toBeNull();

    // The UI did NOT fall back to the text-only "Voice unavailable" notice.
    await expect(page.getByText(/语音不可用|voice unavailable/i)).toHaveCount(0);

    // The connect completed: the connecting spinner is gone and the "I'm done"/submit voice control
    // is enabled (it is disabled until connectionState === "connected").
    await expect(page.getByText(/连接中|connecting/i)).toHaveCount(0, { timeout: 40_000 });
  });
});
