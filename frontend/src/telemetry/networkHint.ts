/**
 * What this browser knows about its network when it opens a voice session, sent with the voice
 * WebSocket (`net_rtt`, `net_loss`) so the backend can pick a photo avatar's video bitrate for the
 * session (voice_live_proxy.choose_avatar_bitrate, docs/network-grades.md). Azure takes the bitrate
 * only when a session is created, so it has to be known before connecting.
 *
 * Two sources, the worse one wins:
 * - this browser's last in-session media numbers (`getStats` RTT and audio loss, the authoritative
 *   ones), remembered for a day: weak networks reconnect, reload and restart often, so every
 *   session after the first one uses real media data;
 * - a quick round trip to the backend just before (TCP to the region: a lower bound for the media
 *   path), the only thing a browser's very first session can know.
 *
 * Remembered in localStorage, per browser: a convenience, never relied on. Nothing here is text.
 */
import { API_BASE } from "../api/http";

const KEY = "ai-interview.network-hint";
/** Media numbers older than this describe another day's network. */
export const MEDIA_FRESH_MS = 24 * 60 * 60 * 1000;
/** The last this many media windows (15 s each) count: about the last minute and a quarter, so a
 * candidate who moved to a better network is not held to an old bad call for long. */
const WINDOWS = 5;
const PRECONNECT_PINGS = 3;
const PING_TIMEOUT_MS = 2000;

interface Stored {
  at: number;
  rtts: number[];
  losses: number[];
}

let preconnectRttMs: number | null = null;

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (!Array.isArray(parsed.rtts) || !Array.isArray(parsed.losses)) return null;
    // Only finite numbers: anything else (a stale format, a hand edit) would weaken the hint.
    const finite = (xs: unknown[]) => xs.filter((x): x is number => Number.isFinite(x));
    return { at: Number(parsed.at) || 0, rtts: finite(parsed.rtts), losses: finite(parsed.losses) };
  } catch {
    return null;
  }
}

/** Remember one `voice.media` window's RTT and audio loss (either may be missing). */
export function recordMediaWindow(rttMs: number | undefined, lossPct: number | undefined): void {
  const now = Date.now();
  const prev = read();
  const fresh = prev && now - prev.at < MEDIA_FRESH_MS ? prev : { at: now, rtts: [], losses: [] };
  const next: Stored = {
    at: now,
    rtts: typeof rttMs === "number" ? [...fresh.rtts, rttMs].slice(-WINDOWS) : fresh.rtts,
    losses: typeof lossPct === "number" ? [...fresh.losses, lossPct].slice(-WINDOWS) : fresh.losses,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the hint falls back to the round trip */
  }
}

/** A few round trips to the backend at once, each given up after PING_TIMEOUT_MS, kept for the
 * next voice connection: started when the interview page opens, so they are in before the
 * candidate starts. Never throws. */
export async function measurePreconnect(fetchFn: typeof fetch = fetch): Promise<void> {
  const ping = async (): Promise<number | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const started = performance.now();
    try {
      const res = await fetchFn(`${API_BASE}/health`, {
        cache: "no-store",
        signal: controller.signal,
      });
      return res.ok ? performance.now() - started : null;
    } catch {
      return null; // a failed or timed-out ping says nothing about the RTT
    } finally {
      clearTimeout(timer);
    }
  };
  const results = await Promise.all(Array.from({ length: PRECONNECT_PINGS }, ping));
  const times = results.filter((t): t is number => t !== null);
  if (times.length) {
    times.sort((a, b) => a - b);
    preconnectRttMs = times[Math.floor(times.length / 2)];
  }
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

export interface NetworkHint {
  rttMs: number | null;
  lossPct: number | null;
}

/** The hint for the next voice connection: the worse of the two sources. */
export function networkHint(now = Date.now()): NetworkHint {
  const stored = read();
  const fresh = stored && now - stored.at < MEDIA_FRESH_MS ? stored : null;
  const mediaRtt = fresh && fresh.rtts.length ? p95(fresh.rtts) : null;
  const rtts = [mediaRtt, preconnectRttMs].filter((v): v is number => v !== null);
  const loss =
    fresh && fresh.losses.length
      ? fresh.losses.reduce((a, b) => a + b, 0) / fresh.losses.length
      : null;
  return { rttMs: rtts.length ? Math.round(Math.max(...rtts)) : null, lossPct: loss };
}

/** Test hook. */
export function resetNetworkHintForTests(): void {
  preconnectRttMs = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}
