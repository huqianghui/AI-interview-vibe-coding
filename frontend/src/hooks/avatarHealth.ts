/**
 * Avatar media-health sampling + the downgrade/restore decision, as PURE functions.
 *
 * Why this exists (weak-network probe, 2026-09-30 — `docs/avatar-weaknet-probe.md` §3.8/§3.9):
 * the digital human's video and the interviewer's VOICE share one RTP transport, so on a lossy link
 * a fat video stream starves its own audio. Measured at 3% loss / 120 ms: the 1080p avatar decoded
 * ZERO frames for 30+ s while still pulling ~1 Mbps, and **31% of the interviewer's audio was
 * synthesised by packet-loss concealment** — the candidate cannot hear the question, so the interview
 * is void. Re-offering the same connection with the video m-line `a=inactive` dropped that to 2.5%
 * (audio packetsLost 505 → 66, RTT 876 → 534 ms). So the right adaptation is not "lower the bitrate"
 * (Azure already adapts, and mid-session bitrate changes are silently ignored) — it is
 * **give up the picture to keep the voice**, and take it back when the link recovers.
 *
 * Two deliberate metric choices, both learned from the probe:
 *
 *  - **Audio health is `concealedSamples / totalSamplesReceived`**, not "concealed samples per second
 *    ÷ 48000". During silence the sender uses DTX, so both counters stop growing together and the
 *    ratio stays flat — a wall-clock rate would read a quiet stretch as 100% broken.
 *  - **Video health is "did the decoder emit a frame", not `freezeCount`.** `freezeCount` is actively
 *    misleading here: when nothing decodes at all, no freeze events are generated, so the frozen
 *    1080p run reported FEWER freezes than the healthy photo-avatar run. `framesDecoded` not growing
 *    while `bytesReceived` does is the honest signature of "burning bandwidth for nothing".
 *
 * Kept free of React so the whole policy is unit-testable without a browser or a PeerConnection.
 */

export type MediaMode = "video" | "audio-only";

/** `auto` = follow the health signal (default). `on`/`off` = the candidate pinned it by hand; the
 * automation stops touching the mode, but the UI keeps telling the truth about the link. */
export type VideoPreference = "auto" | "on" | "off";

export const HEALTH_THRESHOLDS = {
  /** How often to poll `getStats()`. One "window" below = one interval. */
  SAMPLE_INTERVAL_MS: 2_000,
  /** Consecutive bad windows before dropping the picture (≈4 s — long enough to ride out a blip). */
  BAD_WINDOWS: 2,
  /** Consecutive windows with no video bytes before the UI stops claiming the avatar is live. The
   * probe measured a ~4 s gap between "video bitrate hit zero" and ICE reporting `disconnected`,
   * during which the page still showed a connected avatar frozen on its last frame. */
  STALL_WINDOWS: 2,
  /** MEASURED AND RETIRED as a decision input — see `USE_VOICE_DAMAGE_TRIGGER`. Kept because the
   * ratio is still worth logging, and because re-enabling the trigger needs a number to start from. */
  CONCEAL_BAD: 0.15,
  /** Also retired as a decision input. The calibration run (2026-09-30) measured the AUDIBLE ratio on a
   * CLEAN link, in audio-only, over 22 consecutive windows: 8% to 19%, median about 13%, minimum 3.1%.
   * So 3% is below the floor of the healthy distribution — unreachable, which is exactly why the picture
   * could never come back. Kept for the same reason as above. */
  CONCEAL_GOOD: 0.03,
  /** Whether audio concealment may DROP the picture on its own.
   *
   * False, on measurement rather than taste. The same calibration run recorded 16.9% audible concealment
   * at the moment it decided to downgrade under 3% packet loss — and 17.0%, 18.0% and 19.3% on the same
   * link minutes later with the shaping REMOVED. The metric therefore has no demonstrated power to
   * separate a lossy link from a clean one, and at 0.15 it fires on healthy sessions: that downgrade was
   * a false positive. Acting on a signal that cannot tell the two conditions apart is worse than not
   * acting, because the cost is the candidate's picture.
   *
   * The PRIMARY trigger is unaffected and keeps the feature honest: video bytes arriving while
   * `framesDecoded` does not grow needs no threshold, and it is what the original 1080p failure actually
   * exhibited (`decoding=false`, ~1 Mbps in, zero frames out). Everything v0.40.0.0 verified live went
   * through that path.
   *
   * To re-enable, first find a metric that separates the two conditions — TODOS.md has the open
   * question and what the run would have to show. */
  USE_VOICE_DAMAGE_TRIGGER: false,
  /** Never restore the picture sooner than this after dropping it. Sized by a hard Azure limit, not by
   * taste: every mode change creates a NEW avatar session (see `useAvatarStream`'s header) and Azure
   * rate-limits avatar requests — a third one inside ~20 s was refused with
   * `"Avatar request was rate-limited. Retry after 43.0s."` (measured 2026-09-30). 60 s keeps any
   * restore comfortably past that retry-after. */
  MIN_AFTER_DOWNGRADE_MS: 60_000,
  /** How long the link must stay healthy before the first restore attempt. */
  INITIAL_HEALTHY_HOLD_MS: 45_000,
  /** Minimum gap between avatar session creations, applied ONLY to switches back INTO video. Dropping
   * the picture is urgent — it is what saves the interview — so it is never delayed; taking it back is
   * a luxury and must not risk the rate limit. */
  VIDEO_SWITCH_MIN_INTERVAL_MS: 60_000,
  /** A restore that gets downgraded again within this window counts as failed, and the required
   * healthy hold doubles. Two failures ⇒ audio-only for the rest of the session. */
  PROBATION_MS: 60_000,
  MAX_RESTORE_ATTEMPTS: 2,
  /** Video bytes per window below which we call the video stream stalled. */
  VIDEO_BYTES_FLOOR: 1_000,
} as const;

/** Raw counters from one `getStats()` pass. Deltas between two snapshots give the health numbers. */
export interface HealthSnapshot {
  at: number;
  concealedSamples: number;
  /** The SILENT subset of `concealedSamples` (comfort noise / silence fill). Tracked separately
   * because it is the difference between "the voice is being destroyed" and "nobody is talking" —
   * see `readHealth`. */
  silentConcealedSamples: number;
  totalSamplesReceived: number;
  framesDecoded: number;
  videoBytesReceived: number;
}

export interface MediaHealth {
  /** Fraction of the interviewer's audio that was invented by AUDIBLE packet-loss concealment, 0..1.
   * Silent concealment is excluded — see `readHealth` for why that distinction is the whole ballgame. */
  concealmentRatio: number;
  /** The raw `concealedSamples / totalSamplesReceived`, silence included. Diagnostics only: it is what
   * the ratio above used to be, and keeping it visible in the logs is what makes an old measurement
   * comparable with a new one. Never make a decision on this. */
  rawConcealmentRatio: number;
  /** The decoder produced at least one new frame during this window. */
  videoDecoding: boolean;
  /** Video RTP bytes are still arriving (whether or not anything decodes). */
  videoBytesFlowing: boolean;
  /** Audio samples actually arrived in this window: the stream is alive rather than dead or torn down.
   * This is what the restore decision uses now — see `reduceHealth`. It is a liveness check, not a
   * quality one, which is the most the receiver can honestly tell us while there is no video to watch. */
  audioFlowing: boolean;
  /** Round-trip time on the selected candidate pair, for diagnostics only. */
  rttMs: number | null;
}

/** Structural stand-in for `RTCStatsReport` so tests can pass a plain `Map`. */
export interface StatsReportLike {
  forEach(callback: (value: Record<string, unknown>, key: string) => void): void;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Turn one `getStats()` report into a snapshot, and (given the previous snapshot) the health of the
 * window between them. `health` is null for the very first sample — there is no window yet.
 */
export function readHealth(
  prev: HealthSnapshot | null,
  report: StatsReportLike,
  now: number,
): { snapshot: HealthSnapshot; health: MediaHealth | null } {
  const rows: Record<string, unknown>[] = [];
  report.forEach((value) => rows.push(value));

  const audio = rows.find((r) => r.type === "inbound-rtp" && r.kind === "audio");
  const video = rows.find((r) => r.type === "inbound-rtp" && r.kind === "video");
  const transport = rows.find((r) => r.type === "transport");
  // Looked up directly rather than via a Map: this runs every 2 s for the whole session, a getStats
  // report is only tens of rows, and the id lookup happens at most once per sample — building a Map of
  // every row to read one entry (sometimes none) was pure per-tick allocation.
  const selectedPairId = transport?.selectedCandidatePairId;
  const pair =
    (typeof selectedPairId === "string"
      ? rows.find((r) => r.id === selectedPairId)
      : undefined) ??
    rows.find((r) => r.type === "candidate-pair" && r.nominated === true && r.state === "succeeded");

  const snapshot: HealthSnapshot = {
    at: now,
    concealedSamples: num(audio?.concealedSamples),
    silentConcealedSamples: num(audio?.silentConcealedSamples),
    totalSamplesReceived: num(audio?.totalSamplesReceived),
    framesDecoded: num(video?.framesDecoded),
    videoBytesReceived: num(video?.bytesReceived),
  };

  if (!prev) return { snapshot, health: null };

  const dSamples = snapshot.totalSamplesReceived - prev.totalSamplesReceived;
  const dConcealed = snapshot.concealedSamples - prev.concealedSamples;
  const dSilent = snapshot.silentConcealedSamples - prev.silentConcealedSamples;
  // SILENT concealment is not damage, and subtracting it is the difference between a metric that works
  // and one that lies. `silentConcealedSamples` is a documented SUBSET of `concealedSamples` (W3C
  // webrtc-stats): when the sender stops transmitting during a pause, the receiver fills the gap with
  // silence or comfort noise, and those samples land in BOTH `concealedSamples` and
  // `totalSamplesReceived`. So the raw ratio climbs toward 1.0 every time the interviewer stops
  // talking — which is most of an interview, since they are usually waiting for the candidate.
  //
  // Measured consequence (2026-09-30, the run that was meant to calibrate CONCEAL_GOOD): the picture
  // was dropped at `conceal=58.2% decoding=true` — video decoding perfectly well — and then never came
  // back within 225 s, because "healthy" required 45 s of unbroken sub-3% readings that a silent
  // interviewer can never produce. Chrome's own legacy `googSpeechExpandRate` excludes the silent
  // subset for exactly this reason.
  //
  // A window with no audible audio at all therefore reports 0: the link's VOICE health is genuinely
  // unknown, and "unknown" must not read as damaged. For the downgrade that is the safe direction (the
  // threshold-free video trigger still fires); for the restore it means a quiet stretch can hand the
  // picture back, which self-corrects — if the link is still bad the video trigger drops it again
  // within ~4 s. `avatar-restore-live.spec.ts` prints `earned` so a restore that rode on silence is
  // never mistaken for a calibrated one.
  const dAudible = Math.max(0, dConcealed - Math.max(0, dSilent));
  const concealmentRatio = dSamples > 0 ? Math.max(0, Math.min(1, dAudible / dSamples)) : 0;
  const rawConcealmentRatio = dSamples > 0 ? Math.max(0, Math.min(1, dConcealed / dSamples)) : 0;

  return {
    snapshot,
    health: {
      concealmentRatio,
      rawConcealmentRatio,
      audioFlowing: dSamples > 0,
      videoDecoding: snapshot.framesDecoded - prev.framesDecoded > 0,
      videoBytesFlowing:
        snapshot.videoBytesReceived - prev.videoBytesReceived >= HEALTH_THRESHOLDS.VIDEO_BYTES_FLOOR,
      rttMs:
        typeof pair?.currentRoundTripTime === "number"
          ? Math.round(pair.currentRoundTripTime * 1000)
          : null,
    },
  };
}

export interface DecisionState {
  mode: MediaMode;
  preference: VideoPreference;
  /** Consecutive bad windows while showing video. */
  badWindows: number;
  /** Consecutive windows with no video bytes while showing video (drives the honest-UI signal). */
  stalledWindows: number;
  /** When the current uninterrupted healthy streak began, while audio-only. */
  healthySince: number | null;
  lastDowngradeAt: number | null;
  lastRestoreAt: number | null;
  /** Restores that were followed by another downgrade inside the probation window. */
  failedRestores: number;
  /** Required healthy hold before the next restore; doubles after each failed restore. */
  healthyHoldMs: number;
}

export function initialDecisionState(preference: VideoPreference = "auto"): DecisionState {
  return {
    mode: preference === "off" ? "audio-only" : "video",
    preference,
    badWindows: 0,
    stalledWindows: 0,
    healthySince: null,
    lastDowngradeAt: null,
    lastRestoreAt: null,
    failedRestores: 0,
    healthyHoldMs: HEALTH_THRESHOLDS.INITIAL_HEALTHY_HOLD_MS,
  };
}

export type MediaAction = "downgrade" | "restore" | null;

/**
 * Fold one health window into the decision state.
 *
 * `action` is what the caller must actually do to the PeerConnection; `state.mode` is already updated
 * to the post-action mode, so the caller can treat this as the single source of truth.
 */
export function reduceHealth(
  state: DecisionState,
  health: MediaHealth,
  now: number,
): { state: DecisionState; action: MediaAction } {
  // Pinned by the candidate: keep sampling (the UI still reports link quality) but never move the
  // mode on our own. Streaks are reset so un-pinning starts from a clean slate.
  if (state.preference !== "auto") {
    return { state: { ...state, badWindows: 0, stalledWindows: 0, healthySince: null }, action: null };
  }

  if (state.mode === "video") {
    // Primary trigger, threshold-free: bytes are arriving and nothing decodes. Secondary: the
    // interviewer's voice is being invented by the concealment algorithm.
    const wasting = health.videoBytesFlowing && !health.videoDecoding;
    const voiceDamaged =
      HEALTH_THRESHOLDS.USE_VOICE_DAMAGE_TRIGGER &&
      health.concealmentRatio > HEALTH_THRESHOLDS.CONCEAL_BAD;
    const badWindows = wasting || voiceDamaged ? state.badWindows + 1 : 0;
    const stalledWindows = health.videoBytesFlowing ? 0 : state.stalledWindows + 1;

    if (badWindows < HEALTH_THRESHOLDS.BAD_WINDOWS) {
      return { state: { ...state, badWindows, stalledWindows }, action: null };
    }

    // A restore that did not survive probation means our healthy-hold was too optimistic: count it
    // and double the hold, so the worst case is a couple of brief black frames, not a strobe.
    const restoreFailed =
      state.lastRestoreAt !== null && now - state.lastRestoreAt < HEALTH_THRESHOLDS.PROBATION_MS;
    return {
      state: {
        ...state,
        mode: "audio-only",
        badWindows: 0,
        stalledWindows: 0,
        healthySince: null,
        lastDowngradeAt: now,
        failedRestores: state.failedRestores + (restoreFailed ? 1 : 0),
        healthyHoldMs: restoreFailed ? state.healthyHoldMs * 2 : state.healthyHoldMs,
      },
      action: "downgrade",
    };
  }

  // audio-only → consider taking the picture back.
  if (state.failedRestores >= HEALTH_THRESHOLDS.MAX_RESTORE_ATTEMPTS) {
    return { state: { ...state, healthySince: null }, action: null };
  }

  // The restore used to require the audible concealment ratio under CONCEAL_GOOD. Measurement killed
  // that: on a CLEAN link the ratio sits at 8-19% (median ~13%, minimum 3.1% over 22 windows), so the
  // condition was unsatisfiable and the picture could never come back. There is also nothing better to
  // measure here — with the video off there is no decode signal, and the receiver cannot tell us whether
  // the link would now carry a video stream. So the restore is an explicit TRIAL, gated on liveness plus
  // time, and made safe by the hysteresis that already exists: the picture comes back, and if the link
  // still cannot carry it the threshold-free video trigger drops it again within about four seconds,
  // which doubles the next hold and, after MAX_RESTORE_ATTEMPTS, settles on audio-only for good.
  const healthy = health.audioFlowing;
  const healthySince = healthy ? (state.healthySince ?? now) : null;
  const heldLongEnough = healthySince !== null && now - healthySince >= state.healthyHoldMs;
  const pastCooldown =
    state.lastDowngradeAt === null ||
    now - state.lastDowngradeAt >= HEALTH_THRESHOLDS.MIN_AFTER_DOWNGRADE_MS;

  if (!heldLongEnough || !pastCooldown) {
    return { state: { ...state, healthySince }, action: null };
  }

  return {
    state: { ...state, mode: "video", healthySince: null, lastRestoreAt: now, stalledWindows: 0 },
    action: "restore",
  };
}

/**
 * Carry a decision state across a session restart: clear the per-window streaks, keep every piece of
 * hysteresis bookkeeping. Switching the picture on or off costs a full Voice Live session rebuild
 * (Azure honours `session.avatar.connect` only ONCE per session and has no disconnect/renegotiate
 * event — measured 2026-09-30, it answers a second offer with "WebRTC connection is in connected
 * state"). If the restart reset `failedRestores`/`healthyHoldMs`, the very reconnect a downgrade
 * causes would forgive the failed restore that caused it, and a bad link would flap forever.
 */
export function resetStreaks(state: DecisionState): DecisionState {
  return { ...state, badWindows: 0, stalledWindows: 0, healthySince: null };
}

/** True once the video stream has been silent long enough that claiming "avatar live" would be a lie. */
export function isVideoStalled(state: DecisionState): boolean {
  return state.mode === "video" && state.stalledWindows >= HEALTH_THRESHOLDS.STALL_WINDOWS;
}
