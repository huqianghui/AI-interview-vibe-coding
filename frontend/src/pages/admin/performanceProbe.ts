/** The Performance tab's network check, run from the admin's own browser (nothing is stored):
 * the API round trip, whether the voice WebSocket opens, whether UDP reaches Azure's STUN/TURN
 * relay, and the downlink. The avatar's media path itself is
 * not tested here: that needs a real avatar session, which Azure rate-limits; every real
 * interview reports it (`voice.media`), and the tab grades that per interview. */
import { fetchDownloadProbe } from "../../api/admin";
import { API_BASE } from "../../api/http";

export type WsReach = { ok: true; ms: number } | { ok: false; reason: string };

/** The p-th percentile (nearest rank) of `values`; 0 for none. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** One `GET /api/health` round trip in ms (liveness only: no database, no Azure), or null on a
 * failure. The backend runs in the Voice Live region, so this is also a TCP lower bound for the
 * RTT to it. */
export async function apiRttOnce(fetchFn: typeof fetch = fetch): Promise<number | null> {
  const started = performance.now();
  try {
    const res = await fetchFn(`${API_BASE}/health`, { cache: "no-store" });
    if (!res.ok) return null;
    return performance.now() - started;
  } catch {
    return null;
  }
}

/** Open the voice WebSocket in probe mode: the backend authenticates, answers `probe.ok` and closes
 * (no Voice Live session, no Azure call). `ms` is the time to that answer. */
export function measureWs(token: string, timeoutMs = 8000): Promise<WsReach> {
  return new Promise((resolve) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ token, probe: "1" });
    const started = performance.now();
    let settled = false;
    let ws: WebSocket | null = null;
    const finish = (result: WsReach) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: `no answer in ${timeoutMs} ms` }),
      timeoutMs,
    );
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/api/voice-live/ws?${params}`);
    } catch (e) {
      finish({ ok: false, reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    ws.onmessage = (event) => {
      let type = "";
      try {
        type = (JSON.parse(String(event.data)) as { type?: string }).type ?? "";
      } catch {
        /* not JSON */
      }
      if (type === "probe.ok") finish({ ok: true, ms: Math.round(performance.now() - started) });
      else finish({ ok: false, reason: "unexpected answer" });
    };
    ws.onerror = () => finish({ ok: false, reason: "connection failed" });
    ws.onclose = (event) => finish({ ok: false, reason: `closed (${event.code})` });
  });
}

/** The STUN/TURN relay Azure hands every avatar session (docs/network-grades.md). */
export const AZURE_STUN = "stun:relay.communication.microsoft.com:3478";

export type StunReach = { ok: true; ms: number } | { ok: false; reason: string };

/** Ask Azure's relay for this browser's public address over UDP 3478 (a STUN Binding, no
 * credentials). A server-reflexive candidate = the UDP gate is open. Its time is to the NEAREST
 * relay, not to the media server or the region: it answers "is UDP open", not "how far". */
export function measureStun(timeoutMs = 5000): Promise<StunReach> {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection === "undefined") {
      resolve({ ok: false, reason: "no WebRTC in this browser" });
      return;
    }
    const started = performance.now();
    let settled = false;
    let pc: RTCPeerConnection | null = null;
    const finish = (result: StunReach) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc?.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: `no STUN answer in ${timeoutMs} ms` }),
      timeoutMs,
    );
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: AZURE_STUN }] });
      pc.createDataChannel("probe");
      pc.onicecandidate = (event) => {
        if (event.candidate && / typ srflx( |$)/.test(event.candidate.candidate)) {
          finish({ ok: true, ms: Math.round(performance.now() - started) });
        } else if (!event.candidate) {
          finish({ ok: false, reason: "no answer from the relay (UDP 3478 blocked?)" });
        }
      };
      void pc
        .createOffer()
        .then((offer) => pc?.setLocalDescription(offer))
        .catch((e: unknown) => finish({ ok: false, reason: String(e) }));
    } catch (e) {
      finish({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Download `kb` KiB of random bytes from the backend and return the rate in kbit/s, or null on a
 * failure. Random, so the compression in front of the app cannot shrink what is timed. Timed after
 * the first chunk (see fetchDownloadProbe); still a lower bound for a distant link. */
export async function measureDownlink(kb = 2048): Promise<number | null> {
  try {
    const { bytes, ms } = await fetchDownloadProbe(kb);
    return ms > 0 && bytes > 0 ? Math.round((bytes * 8) / ms) : null;
  } catch {
    return null;
  }
}

/** A rate in kbit/s, as Mbit/s from 1000 up (73843 kbit/s is hard to read). */
export function formatRate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
}
