/** The Performance tab's network check, run from the admin's own browser (nothing is stored):
 * the API round trip, whether the voice WebSocket opens, and the browser's own network estimate.
 * The avatar's media path (ICE / TURN) is not tested here: that needs a real avatar session, which
 * Azure rate-limits; the workbook reports it for every real interview. */
import { API_BASE } from "../../api/http";

export interface ApiRtt {
  median: number;
  p95: number;
  failed: number;
  total: number;
}

export type WsReach = { ok: true; ms: number } | { ok: false; reason: string };

export interface BrowserNetwork {
  type: string;
  rtt: number | null;
  downlink: number | null;
}

/** The p-th percentile (nearest rank) of `values`; 0 for none. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** `count` sequential `GET /api/health` calls (liveness only: no database, no Azure). */
export async function measureApi(count = 10, fetchFn: typeof fetch = fetch): Promise<ApiRtt> {
  const times: number[] = [];
  let failed = 0;
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    try {
      const res = await fetchFn(`${API_BASE}/health`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      times.push(performance.now() - started);
    } catch {
      failed += 1;
    }
  }
  return {
    median: Math.round(percentile(times, 50)),
    p95: Math.round(percentile(times, 95)),
    failed,
    total: count,
  };
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

/** `navigator.connection` (Chromium only); null where the browser does not expose it. */
export function browserNetwork(): BrowserNetwork | null {
  const conn = (
    navigator as Navigator & {
      connection?: { effectiveType?: string; rtt?: number; downlink?: number };
    }
  ).connection;
  if (!conn) return null;
  return {
    type: conn.effectiveType ?? "?",
    rtt: typeof conn.rtt === "number" ? conn.rtt : null,
    downlink: typeof conn.downlink === "number" ? conn.downlink : null,
  };
}
