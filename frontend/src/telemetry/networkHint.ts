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
/** The last this many media windows (15 s each) are kept: about the last five minutes of a call. */
const WINDOWS = 20;
const PRECONNECT_PINGS = 3;

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
    return Array.isArray(parsed.rtts) && Array.isArray(parsed.losses) ? parsed : null;
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

/** A few round trips to the backend, kept for the next voice connection. Never throws. */
export async function measurePreconnect(fetchFn: typeof fetch = fetch): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < PRECONNECT_PINGS; i += 1) {
    const started = performance.now();
    try {
      const res = await fetchFn(`${API_BASE}/health`, { cache: "no-store" });
      if (res.ok) times.push(performance.now() - started);
    } catch {
      /* a failed ping says nothing about the RTT */
    }
  }
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
