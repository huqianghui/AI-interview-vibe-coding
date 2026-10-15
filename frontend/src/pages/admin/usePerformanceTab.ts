/** State of the admin "Performance" tab (spec-admin-performance-tab): the live network check from
 * this browser, the Operation id lookup with the network that interview ran on, and what this
 * deployment can link to. The page owns the hook, so a lookup survives switching tabs, and
 * Interview results can open it on an id. */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type {
  InterviewNetwork,
  OperationLookup,
  PerformanceLinks,
  TransactionLink,
} from "../../api/admin";
import * as auth from "../../api/auth";
import { operationIdFor } from "../../telemetry/appInsights";
import { gradeNetwork, type GradeResult } from "./networkGrade";
import {
  apiRttOnce,
  browserNetwork,
  measureDownlink,
  measureStun,
  measureWs,
  percentile,
  type BrowserNetwork,
  type StunReach,
  type WsReach,
} from "./performanceProbe";

/** A pasted Operation id (or interview id) as 32 lowercase hex, or null. The backend's
 * `performance_service.normalize` is the same rule. */
export function normalizeOperationId(raw: string): string | null {
  return operationIdFor(raw.trim());
}

/** How often each part of the live check runs while the tab is open and visible. Exported so a
 * test can shorten them. The RTT is cheap (a health check); the rest cost more and change slower. */
export const LIVE_CHECK = {
  rttMs: 2000,
  wsMs: 15_000,
  downMs: 30_000,
  stunMs: 60_000,
  /** The chart's window: 30 samples = the last minute. */
  samples: 30,
};

export interface RttSample {
  at: number;
  /** null = the call failed. */
  ms: number | null;
}

export interface LiveNetwork {
  rtt: RttSample[];
  ws: WsReach | null;
  stun: StunReach | null;
  downKbps: number | null;
  browser: BrowserNetwork | null;
}

const EMPTY_LIVE: LiveNetwork = { rtt: [], ws: null, stun: null, downKbps: null, browser: null };

/** The RTTs that answered, oldest first. */
export function okRtts(samples: RttSample[]): number[] {
  return samples.flatMap((s) => (s.ms === null ? [] : [s.ms]));
}

/** This browser's estimated grade: TCP RTT to the region (a lower bound for the media path), no
 * UDP loss reading, the STUN answer as the UDP gate. */
export function liveGrade(live: LiveNetwork): GradeResult | null {
  const rtts = okRtts(live.rtt);
  if (rtts.length < 3) return null;
  return gradeNetwork({
    udpOk: live.stun ? live.stun.ok : null,
    rttMs: percentile(rtts, 95),
    lossPct: null,
    downKbps: live.downKbps,
    downCounts: true,
  });
}

/** A video avatar streams 1080p; a photo avatar 512x512. Only a video avatar's downlink estimate
 * reaches the link's capacity, so only it is graded on downlink. */
export function isVideoAvatar(resolution: string | null | undefined): boolean {
  const width = Number((resolution ?? "").split("x")[0]);
  return Number.isFinite(width) && width >= 1280;
}

/** The grade of the network an interview ran on, from its own WebRTC telemetry. */
export function interviewGrade(net: InterviewNetwork): GradeResult | null {
  const media = net.media;
  const avatar = net.avatar;
  // The UDP gate: an avatar that connected passed it; one that only ever failed, or a session that
  // fell back to voice over the WebSocket, did not.
  let udpOk: boolean | null = null;
  if (avatar && avatar.connected > 0) udpOk = true;
  else if (avatar && (avatar.failed > 0 || avatar.voice_over_ws > 0)) udpOk = false;
  if (!media || media.samples === 0) {
    if (udpOk !== false) return null;
    return gradeNetwork({ udpOk, rttMs: null, lossPct: null, downKbps: null, downCounts: false });
  }
  return gradeNetwork({
    udpOk,
    rttMs: media.rtt_p95_ms,
    lossPct: media.audio_loss_pct,
    downKbps: media.available_in_p50_kbps,
    downCounts: isVideoAvatar(media.resolution),
  });
}

export type TransactionState =
  | { kind: "idle" }
  | { kind: "finding" }
  | { kind: "done"; link: TransactionLink }
  | { kind: "failed"; message: string };

export type NetworkState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; network: InterviewNetwork }
  | { kind: "failed"; message: string };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** Run `fn` now and every `ms` while `on`; a slow run is never overlapped by the next. */
function useEvery(on: boolean, ms: number, fn: () => Promise<void>) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await fnRef.current().catch(() => undefined);
      if (!stopped) timer = setTimeout(() => void tick(), ms);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [on, ms]);
}

export function usePerformanceTab(active: boolean) {
  const [links, setLinks] = useState<PerformanceLinks | null>(null);
  const [live, setLive] = useState<LiveNetwork>(EMPTY_LIVE);
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<OperationLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<TransactionState>({ kind: "idle" });
  const [interviewNetwork, setInterviewNetwork] = useState<NetworkState>({ kind: "idle" });
  const lookupSeq = useRef(0);

  useEffect(() => {
    if (!active || links) return;
    admin.getPerformanceLinks().then(setLinks, () => undefined);
  }, [active, links]);

  // The live check runs only while someone is looking at it: the tab is open and the page visible.
  const visible = useVisible();
  const running = active && visible;
  useEvery(running, LIVE_CHECK.rttMs, async () => {
    const ms = await apiRttOnce();
    setLive((l) => ({
      ...l,
      rtt: [...l.rtt, { at: Date.now(), ms }].slice(-LIVE_CHECK.samples),
      browser: browserNetwork(),
    }));
  });
  useEvery(running, LIVE_CHECK.wsMs, async () => {
    const ws = await measureWs(auth.getAdminToken());
    setLive((l) => ({ ...l, ws }));
  });
  useEvery(running, LIVE_CHECK.downMs, async () => {
    const downKbps = await measureDownlink();
    setLive((l) => ({ ...l, downKbps }));
  });
  useEvery(running, LIVE_CHECK.stunMs, async () => {
    const stun = await measureStun();
    setLive((l) => ({ ...l, stun }));
  });

  /** Look an id up (from the input, or from Interview results), then the network it ran on. */
  const lookup = useCallback(async (raw: string) => {
    setInput(raw);
    setError(null);
    setTransaction({ kind: "idle" });
    setInterviewNetwork({ kind: "idle" });
    const id = normalizeOperationId(raw);
    setInvalid(id === null);
    // Bumped first, so a lookup still in flight cannot land after this one (valid or not).
    const seq = ++lookupSeq.current;
    const current = () => seq === lookupSeq.current;
    if (id === null) {
      setResult(null);
      setLooking(false);
      return;
    }
    setLooking(true);
    try {
      const found = await admin.lookupOperation(id);
      if (!current()) return;
      setResult(found);
    } catch (e) {
      if (current()) {
        setResult(null);
        setError(errorText(e));
      }
      return;
    } finally {
      if (current()) setLooking(false);
    }
    setInterviewNetwork({ kind: "loading" });
    try {
      const network = await admin.getInterviewNetwork(id);
      if (current()) setInterviewNetwork({ kind: "done", network });
    } catch (e) {
      if (current()) setInterviewNetwork({ kind: "failed", message: errorText(e) });
    }
  }, []);

  const findTransaction = useCallback(async () => {
    const id = result?.operation_id;
    if (!id) return;
    setTransaction({ kind: "finding" });
    const seq = lookupSeq.current;
    // A new lookup since this started owns the card now: drop this answer.
    const current = () => seq === lookupSeq.current;
    try {
      const link = await admin.getTransactionLink(id);
      if (current()) setTransaction({ kind: "done", link });
    } catch (e) {
      if (current()) setTransaction({ kind: "failed", message: errorText(e) });
    }
  }, [result]);

  return {
    links,
    live,
    running,
    input,
    setInput,
    invalid,
    looking,
    result,
    error,
    lookup,
    transaction,
    findTransaction,
    interviewNetwork,
  };
}

export type PerformanceTabState = ReturnType<typeof usePerformanceTab>;
