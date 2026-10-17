/** State of the admin "Performance" tab (spec-admin-performance-tab): the live network check from
 * this browser, the Operation id lookup with the network that interview ran on, and what this
 * deployment can link to. The page owns the hook, so a lookup survives switching tabs, and
 * Interview results can open it on an id. */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type {
  CurrentConfig,
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
  measureDownlink,
  measureStun,
  measureWs,
  percentile,
  type StunReach,
  type WsReach,
} from "./performanceProbe";

/** A pasted Operation id (or interview id) as 32 lowercase hex, or null. The backend's
 * `performance_service.normalize` is the same rule. */
export function normalizeOperationId(raw: string): string | null {
  return operationIdFor(raw.trim());
}

/** How often each part of the live check runs while the tab is open and visible. Exported so a
 * test can shorten them. The RTT is cheap (a health check); the rest cost more and change
 * slower. */
export const LIVE_CHECK = {
  rttMs: 2000,
  wsMs: 15_000,
  // 2 MiB each: often enough to follow the link, rare enough for ~60 MB an hour. Only while the
  // Performance tab is open; the other checks run on every /admin tab.
  downMs: 120_000,
  stunMs: 60_000,
  /** The grade's window: 30 samples = the last minute. */
  samples: 30,
  /** The same windows in time: a sample from before the page was hidden must not count as recent
   * (samples are kept by count, and an hour hidden would otherwise leave them "last"). */
  gradeWindowMs: 60_000,
  chartWindowMs: 300_000,
  /** The chart's window: 150 samples = the last 5 minutes, measured on any /admin tab, so the
   * Performance tab opens on a stretch of history rather than an empty chart (owner, 2026-10-17). */
  chartSamples: 150,
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
  /** STUN failures in a row: one lost UDP answer is not a blocked port. */
  stunFailures: number;
  downKbps: number | null;
}

const EMPTY_LIVE: LiveNetwork = {
  rtt: [],
  ws: null,
  stun: null,
  stunFailures: 0,
  downKbps: null,
};
/** STUN failures in a row before the UDP gate counts as closed. */
export const STUN_FAILURES_FOR_CLOSED = 2;
/** Of the last RECENT round trips, this many failing means the app is not answering: no grade. */
const RECENT = 5;
const RECENT_FAILED = 3;

/** The samples of the grade's window: the last minute, by time and by count. */
export function recentRtts(samples: RttSample[], now: number = Date.now()): RttSample[] {
  return samples.filter((s) => s.at >= now - LIVE_CHECK.gradeWindowMs).slice(-LIVE_CHECK.samples);
}

/** The RTTs that answered, oldest first. */
export function okRtts(samples: RttSample[]): number[] {
  return samples.flatMap((s) => (s.ms === null ? [] : [s.ms]));
}

/** This browser's estimated grade: TCP RTT to the region (a lower bound for the media path), no
 * UDP loss reading, the STUN answer as the UDP gate. */
export function liveGrade(live: LiveNetwork): GradeResult | null {
  // The last minute only: the chart keeps five, and a grade should follow the link as it is now.
  const recent = recentRtts(live.rtt);
  const rtts = okRtts(recent);
  if (rtts.length < 3) return null;
  if (recent.slice(-RECENT).filter((s) => s.ms === null).length >= RECENT_FAILED) return null;
  let udpOk: boolean | null = null;
  if (live.stun?.ok) udpOk = true;
  else if (live.stunFailures >= STUN_FAILURES_FOR_CLOSED) udpOk = false;
  return gradeNetwork({
    udpOk,
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

/** Run `fn` now and every `ms` while `on`; a slow run is never overlapped by the next. `fn` gets
 * `live()`: false once this run of the loop has stopped, so a reading that lands after the tab
 * was hidden or left is dropped instead of written. */
function useEvery(on: boolean, ms: number, fn: (live: () => boolean) => Promise<void>) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = () => !stopped;
    const tick = async () => {
      await fnRef.current(live).catch(() => undefined);
      if (!stopped) timer = setTimeout(() => void tick(), ms);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [on, ms]);
}

/** `signedIn`: the admin page is open and signed in, on any tab; the cheap live checks (API round
 * trip, WebSocket, STUN) run then. `active`: the Performance tab itself is open; the rest of the
 * tab's reads, and the 2 MiB downlink check, wait for it. */
export function usePerformanceTab(active: boolean, signedIn: boolean = active) {
  const [links, setLinks] = useState<PerformanceLinks | null>(null);
  const [live, setLive] = useState<LiveNetwork>(EMPTY_LIVE);
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<OperationLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<TransactionState>({ kind: "idle" });
  const [interviewNetwork, setInterviewNetwork] = useState<NetworkState>({ kind: "idle" });
  // What a grade is compared with: the default interviewer's settings (no interview chosen) and
  // the looked-up interview's own interviewer.
  const [defaultConfig, setDefaultConfig] = useState<CurrentConfig | null>(null);
  const [interviewConfig, setInterviewConfig] = useState<CurrentConfig | null>(null);
  const lookupSeq = useRef(0);

  useEffect(() => {
    if (!active || links) return;
    admin.getPerformanceLinks().then(setLinks, () => undefined);
  }, [active, links]);
  // Read each time the tab opens: someone may have changed the default interviewer meanwhile.
  useEffect(() => {
    if (!active) return;
    admin.getCurrentConfig().then(setDefaultConfig, () => undefined);
  }, [active]);

  // The live check runs while the admin page is open on any tab and visible, so the Performance
  // tab opens on history; the downlink check, 2 MiB a run, only while that tab is open.
  const visible = useVisible();
  const running = signedIn && visible;
  const downRunning = active && visible;
  useEvery(running, LIVE_CHECK.rttMs, async (isLive) => {
    const ms = await apiRttOnce();
    if (!isLive()) return;
    setLive((l) => ({
      ...l,
      rtt: [...l.rtt, { at: Date.now(), ms }]
        .filter((s) => s.at >= Date.now() - LIVE_CHECK.chartWindowMs)
        .slice(-LIVE_CHECK.chartSamples),
    }));
  });
  useEvery(running, LIVE_CHECK.wsMs, async (isLive) => {
    // An expired sign-in clears the token: no probe that can only fail (and log) every 15 s.
    const token = auth.getAdminToken();
    if (!token) return;
    const ws = await measureWs(token);
    if (isLive()) setLive((l) => ({ ...l, ws }));
  });
  useEvery(downRunning, LIVE_CHECK.downMs, async (isLive) => {
    const downKbps = await measureDownlink();
    if (isLive()) setLive((l) => ({ ...l, downKbps }));
  });
  useEvery(running, LIVE_CHECK.stunMs, async (isLive) => {
    const stun = await measureStun();
    if (!isLive()) return;
    setLive((l) => ({ ...l, stun, stunFailures: stun.ok ? 0 : l.stunFailures + 1 }));
  });

  // The links are read once; a lookup only asks for the end-to-end view when it can exist.
  const linksRef = useRef<PerformanceLinks | null>(null);
  linksRef.current = links;
  // The lookup the shown result belongs to: a retry answers for it, never for a newer one.
  const resultSeqRef = useRef(0);

  /** The end-to-end transaction link for `id` (a Logs query, a few seconds); an answer that lands
   * after a newer lookup is dropped. */
  const findTransactionFor = useCallback(async (id: string, seq: number) => {
    const current = () => seq === lookupSeq.current;
    setTransaction({ kind: "finding" });
    try {
      const link = await admin.getTransactionLink(id);
      if (current()) setTransaction({ kind: "done", link });
    } catch (e) {
      if (current()) setTransaction({ kind: "failed", message: errorText(e) });
    }
  }, []);

  /** Look an id up (from the input, or from Interview results), then, at once, the network it ran
   * on and its end-to-end view: one click from Interview results to the link. */
  const lookup = useCallback(async (raw: string) => {
    setInput(raw);
    setError(null);
    setTransaction({ kind: "idle" });
    setInterviewNetwork({ kind: "idle" });
    setInterviewConfig(null);
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
      resultSeqRef.current = seq;
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
    if (linksRef.current?.transaction !== false) void findTransactionFor(id, seq);
    setInterviewNetwork({ kind: "loading" });
    admin.getCurrentConfig(id).then(
      (config) => current() && setInterviewConfig(config),
      () => undefined,
    );
    try {
      const network = await admin.getInterviewNetwork(id);
      if (current()) setInterviewNetwork({ kind: "done", network });
    } catch (e) {
      if (current()) setInterviewNetwork({ kind: "failed", message: errorText(e) });
    }
  }, [findTransactionFor]);

  /** Ask again (the telemetry was not in App Insights yet: it arrives a few minutes late). */
  const findTransaction = useCallback(async () => {
    const id = result?.operation_id;
    if (id) await findTransactionFor(id, resultSeqRef.current);
  }, [result, findTransactionFor]);

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
    defaultConfig,
    interviewConfig,
  };
}

export type PerformanceTabState = ReturnType<typeof usePerformanceTab>;
