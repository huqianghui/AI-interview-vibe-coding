/**
 * Does Azure drop the avatar after 5 minutes of idle (docs/avatar-rate-limit.md, "not yet live-tested")?
 *
 * One real interview with a SILENT fake microphone (Chromium's default fake device beeps, which VAD
 * could take for speech). After the first question has been read, the candidate says nothing for
 * HOLD_MIN minutes; every voice WebSocket open/close, error frame, avatar event and WebRTC state change
 * is logged with its time since the hold began.
 *
 * Usage (live):
 *   cd frontend
 *   BASE=https://<frontend> API=https://<frontend>/api AU=admin AP=<seed admin password> \
 *     SILENCE=/path/to/silence.wav node e2e/scripts/avatar-idle-probe.mjs
 *
 * HOLD_FROM=connect: start the clock when the avatar connects and stay on the "Before we begin"
 * screen (never press "I'm ready"): the avatar is connected and says nothing at all.
 *
 * KEEPALIVE='{"type":"..."}' KEEPALIVE_AT_S=300: send that event on the voice WebSocket once, that many
 * seconds into the hold, to see whether it resets Voice Live's 900 s idle clock (session_idle_timeout).
 * USER_NAME=user2 picks the candidate account (one live seat per account, so parallel runs need different ones).
 *
 * FORCE_TRACK_END_AT_S=30: fire `ended` on the received video track that many seconds into the
 * hold, the signal the page treats as a media drop, to watch the rebuild that follows.
 *
 * It signs in as USER_NAME (default user1), so it resumes user1's live interview if one is open. Costs Azure time.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE || "http://localhost:5173";
const API = process.env.API || "http://127.0.0.1:8000";
const HOLD_MIN = Number(process.env.HOLD_MIN || 8);
if (!process.env.AU || !process.env.AP || !process.env.SILENCE) {
  console.error("needs AU, AP and SILENCE (a silent WAV)");
  process.exit(2);
}

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${process.env.SILENCE}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

async function candidateToken() {
  const ctx = await browser.newContext();
  const login = async (username, password) =>
    (
      await (
        await ctx.request.post(`${API}/auth/login`, { data: { username, password } })
      ).json()
    ).access_token;
  const admin = await login(process.env.AU, process.env.AP);
  const users = await (
    await ctx.request.get(`${API}/admin/users`, { headers: { Authorization: `Bearer ${admin}` } })
  ).json();
  const who = process.env.USER_NAME || "user1";
  const token = await login(who, users.find((u) => u.username === who)?.generated_password);
  await ctx.close();
  return token;
}

const token = await candidateToken();
let holdAt = null;
const t0 = Date.now();
const stamp = () => {
  const base = holdAt ?? t0;
  const s = Math.round((Date.now() - base) / 1000);
  return `${holdAt ? "hold" : "pre "} ${String(Math.floor(s / 60)).padStart(2)}m${String(s % 60).padStart(2, "0")}s`;
};
const log = (...a) => console.log(stamp(), ...a);

const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, permissions: ["microphone"] });
await ctx.addInitScript(([k, v]) => sessionStorage.setItem(k, v), ["candidate_access_token", token]);
// The voice WebSocket, so the keep-alive test can send on it. NO_WS_WRAP=1 leaves the page's
// WebSocket untouched (to rule the wrapper out when a connection misbehaves).
if (!process.env.NO_WS_WRAP) await ctx.addInitScript(() => {
  const Orig = window.WebSocket;
  window.__wss = [];
  window.WebSocket = function (...args) {
    const ws = new Orig(...args);
    window.__wss.push(ws);
    return ws;
  };
  window.WebSocket.prototype = Orig.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
});
// Every RTCPeerConnection the page makes, with its state changes, for the heartbeat below.
await ctx.addInitScript(() => {
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new Orig(...args);
    const rec = { n: window.__pcs.length + 1, states: [] };
    window.__pcs.push(rec);
    pc.addEventListener("connectionstatechange", () =>
      rec.states.push(`${pc.connectionState}@${new Date().toISOString().slice(11, 19)}`),
    );
    rec.pc = pc;
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
});
const page = await ctx.newPage();

let firstReadDone = false;
const INTERESTING = /^(error|proxy\.|session\.avatar|session\.created|session\.updated|response\.done)/;
page.on("websocket", (ws) => {
  if (!/voice-live\/ws/.test(ws.url())) return;
  log("WS open");
  ws.on("close", () => log("WS close"));
  ws.on("framereceived", (f) => {
    if (typeof f.payload !== "string") return;
    let m;
    try {
      m = JSON.parse(f.payload);
    } catch {
      return;
    }
    if (m.type === "response.done" && !firstReadDone) {
      firstReadDone = true;
      holdAt = Date.now();
      log(`first read done: holding silent for ${HOLD_MIN} min`);
      return;
    }
    if (process.env.HOLD_FROM === "connect" && m.type === "session.avatar.connecting" && !holdAt) {
      holdAt = Date.now();
      log(`avatar connecting: holding idle (no "I'm ready") for ${HOLD_MIN} min`);
    }
    if (m.type === "error") log("ERROR frame", JSON.stringify(m.error ?? m).slice(0, 300));
    else if (INTERESTING.test(m.type) && m.type !== "response.done") log("frame", m.type);
    else if (holdAt && m.type?.startsWith("response.")) log("frame", m.type);
  });
});
page.on("console", (msg) => {
  const t = msg.text();
  if (/\[voice\]|\[avatar\]|reconnect|ice|error/i.test(t)) log("console", t.slice(0, 200));
});

await page.goto(`${BASE}/interview`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const clicks = [/start interview|开始面试/i, /resume/i];
if (process.env.HOLD_FROM !== "connect") clicks.push(/i'm ready|我准备好了/i, /answer by voice|语音作答/i);
for (const name of clicks) {
  const b = page.getByRole("button", { name });
  if (await b.count()) {
    await b.first().click({ timeout: 5000 }).catch(() => {});
    log("clicked", String(name));
    await page.waitForTimeout(2000);
  }
}

const KEEPALIVE = process.env.KEEPALIVE;
const KEEPALIVE_AT_S = Number(process.env.KEEPALIVE_AT_S || 300);
let keepaliveSent = false;
let trackEnded = false;
const deadline = () => holdAt && Date.now() - holdAt > HOLD_MIN * 60_000;
const startedAt = Date.now();
while (!deadline()) {
  if (!holdAt && Date.now() - startedAt > 120_000) {
    log("no first read within 2 min; giving up");
    break;
  }
  await page.waitForTimeout(30_000);
  if (KEEPALIVE && !keepaliveSent && holdAt && Date.now() - holdAt > KEEPALIVE_AT_S * 1000) {
    keepaliveSent = true;
    const sent = await page.evaluate((msg) => {
      const ws = window.__wss.filter((w) => /voice-live\/ws/.test(w.url) && w.readyState === 1).pop();
      if (!ws) return false;
      ws.send(msg);
      return true;
    }, KEEPALIVE);
    log(`KEEPALIVE sent=${sent}: ${KEEPALIVE}`);
  }
  if (process.env.FORCE_TRACK_END_AT_S && !trackEnded && holdAt &&
      Date.now() - holdAt > Number(process.env.FORCE_TRACK_END_AT_S) * 1000) {
    trackEnded = true;
    const fired = await page.evaluate(() => {
      const pc = (window.__pcs || []).at(-1)?.pc;
      const track = pc?.getReceivers().map((r) => r.track).find((t) => t?.kind === "video");
      if (!track) return false;
      track.dispatchEvent(new Event("ended"));
      return true;
    });
    log(`FORCED video track ended: fired=${fired}`);
  }
  const hb = await page
    .evaluate(async () => {
      const pcs = [];
      for (const r of window.__pcs || []) {
        // Received bytes per kind: a stream that stalls without closing still shows here.
        const kb = {};
        try {
          (await r.pc.getStats()).forEach((st) => {
            if (st.type === "inbound-rtp") kb[st.kind] = Math.round(st.bytesReceived / 1024);
          });
        } catch {}
        pcs.push(`#${r.n} ${r.pc.connectionState} rx=${JSON.stringify(kb)} [${r.states.join(",")}]`);
      }
      return { pcs };
    })
    .catch((e) => ({ err: String(e) }));
  log("heartbeat", JSON.stringify(hb));
}
await page.screenshot({ path: "/tmp/idle-probe/end.png" });
log("done; screenshot /tmp/idle-probe/end.png");
await browser.close();
