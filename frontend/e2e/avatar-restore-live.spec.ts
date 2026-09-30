/**
 * LIVE calibration of the RESTORE half of the weak-network policy (opt-in, real Azure — NOT CI).
 *
 * `avatar-auto-downgrade-live.spec.ts` proves the picture is given UP. This spec proves it comes BACK,
 * and is the run that finally exercises `CONCEAL_GOOD` — the only threshold in `avatarHealth.ts` that
 * has never met a real link (TODOS.md, filed from the v0.40.0.0 review).
 *
 * It cannot shape the network itself (that needs root), so it cooperates with
 * `frontend/e2e/scripts/verify-restore.sh`: the script shapes the link and then waits for THIS spec to
 * touch `RESTORE_SIGNAL_FILE` the moment it observes the downgrade. The script removes shaping, and the
 * spec then watches for the picture to return. Handshaking on a file rather than a fixed timer means the
 * link is un-shaped at a known point in the policy's life, so the measured restore delay is meaningful.
 *
 * READ THIS BEFORE TRUSTING A PASS. In audio-only mode the policy calls the link healthy when
 * `concealedSamples / totalSamplesReceived` is under `CONCEAL_GOOD`, and `readHealth` reports 0 when NO
 * samples arrive at all (DTX silence is indistinguishable from a dead stream at that layer). So a quiet
 * interviewer also reads as "healthy". That is defensible in production — with no voice arriving there is
 * no voice to protect, and if the link is still bad the threshold-free trigger drops the picture again
 * within ~4 s — but it means a pass does NOT by itself prove `CONCEAL_GOOD` was exercised. This spec
 * therefore samples `totalSamplesReceived` throughout and prints whether audio was actually flowing
 * during the healthy hold. Read `earned` in the summary: false ⇒ the restore rode on silence and the
 * threshold is still unmeasured. Pass FAKE_AUDIO to keep a turn in progress if you need `earned: true`.
 *
 * Run through the wrapper (it handles sudo, shaping and restore):
 *   sudo frontend/e2e/scripts/verify-restore.sh
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { enterVoiceChannel, primeCandidateLogin, waitForInterviewStage } from "./helpers/candidateLogin";
import { HEALTH_THRESHOLDS } from "../src/hooks/avatarHealth";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
/** Touched as soon as the downgrade is observed; the wrapper script un-shapes when it appears. */
const SIGNAL_FILE = process.env.RESTORE_SIGNAL_FILE || "";
const DOWNGRADE_BUDGET_MS = Number(process.env.DOWNGRADE_BUDGET_MS ?? 150_000);
/** The policy needs MIN_AFTER_DOWNGRADE_MS since the downgrade AND healthyHoldMs of health, and the
 * rebuild itself takes ~5 s. Budget generously over the sum — this is a measurement, not a race. */
const RESTORE_BUDGET_MS = Number(
  process.env.RESTORE_BUDGET_MS ??
    HEALTH_THRESHOLDS.MIN_AFTER_DOWNGRADE_MS + HEALTH_THRESHOLDS.INITIAL_HEALTHY_HOLD_MS + 120_000,
);

interface Sample {
  t: number;
  mode: string | null;
  audioSamples: number;
  concealed: number;
  videoBytes: number;
  framesDecoded: number;
  rttMs: number | null;
}

async function sampleStats(page: import("@playwright/test").Page): Promise<Omit<Sample, "t" | "mode">> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs ?? [];
    const acc = { audioSamples: 0, concealed: 0, videoBytes: 0, framesDecoded: 0, rttMs: null as number | null };
    for (const pc of pcs) {
      if (pc.connectionState !== "connected") continue;
      const report = await pc.getStats();
      report.forEach((s) => {
        const row = s as unknown as Record<string, unknown>;
        if (row.type === "inbound-rtp" && row.kind === "audio") {
          if (typeof row.totalSamplesReceived === "number") acc.audioSamples += row.totalSamplesReceived;
          if (typeof row.concealedSamples === "number") acc.concealed += row.concealedSamples;
        }
        if (row.type === "inbound-rtp" && row.kind === "video") {
          if (typeof row.bytesReceived === "number") acc.videoBytes += row.bytesReceived;
          if (typeof row.framesDecoded === "number") acc.framesDecoded += row.framesDecoded;
        }
        if (row.type === "candidate-pair" && row.nominated === true && typeof row.currentRoundTripTime === "number") {
          acc.rttMs = Math.round((row.currentRoundTripTime as number) * 1000);
        }
      });
    }
    return acc;
  });
}

test.describe("Weak-network picture RESTORE (real Azure link, shaping removed mid-run)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1");
  test.setTimeout(DOWNGRADE_BUDGET_MS + RESTORE_BUDGET_MS + 120_000);

  test("gives the picture back once the link recovers, and says whether CONCEAL_GOOD earned it", async ({ page }) => {
    const decisions: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (/media health|media mode →|rebuilding the session|not restoring the picture/.test(text)) {
        decisions.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
      }
    });

    await page.addInitScript(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      w.__pcs = [];
      const Orig = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Orig {
        constructor(...args: unknown[]) {
          // @ts-expect-error passthrough
          super(...args);
          w.__pcs.push(this);
        }
      } as unknown as typeof RTCPeerConnection;
    });

    await primeCandidateLogin(page);
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    const view = page.locator('[data-testid="avatar-view"]');
    const started = Date.now();
    const samples: Sample[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          const stats = await sampleStats(page);
          const mode = await view.getAttribute("data-media-mode").catch(() => null);
          samples.push({ t: Date.now() - started, mode, ...stats });
        } catch {
          // page navigating / closed between polls — a dropped sample is not a failure.
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    })();

    // 1. Start from a picture, under shaping, so there is something to lose.
    await expect(view).toHaveAttribute("data-media-mode", "video");

    // 2. The shaped link should make the policy drop the picture on its own.
    await expect(view).toHaveAttribute("data-media-mode", "audio-only", { timeout: DOWNGRADE_BUDGET_MS });
    const downgradedAt = Date.now();
    console.log(`[restore] downgraded at t=${Math.round((downgradedAt - started) / 1000)}s — signalling the shaper`);

    // 3. Tell the wrapper to remove shaping. Without a wrapper the link never recovers and this spec
    //    is expected to fail at step 4 — say so rather than failing mysteriously.
    if (SIGNAL_FILE) {
      fs.mkdirSync(path.dirname(SIGNAL_FILE), { recursive: true });
      fs.writeFileSync(SIGNAL_FILE, String(Date.now()));
    } else {
      console.warn("[restore] RESTORE_SIGNAL_FILE is not set — nothing will un-shape the link, so the");
      console.warn("[restore] restore below can only pass if the link was never shaped to begin with.");
    }

    // 4. The measurement: does the picture come back, and how long after the link recovered?
    let restored = true;
    try {
      await expect(view).toHaveAttribute("data-media-mode", "video", { timeout: RESTORE_BUDGET_MS });
    } catch {
      restored = false;
    }
    const restoredAt = Date.now();

    sampling = false;
    await sampler;

    // Was the "healthy" reading earned by real audio, or by silence? Compare samples received across
    // the audio-only stretch: DTX silence reports concealment 0, which the policy reads as healthy.
    const audioOnly = samples.filter((s) => s.mode === "audio-only");
    const first = audioOnly[0];
    const last = audioOnly[audioOnly.length - 1];
    const samplesDuringHold = first && last ? last.audioSamples - first.audioSamples : 0;
    const concealedDuringHold = first && last ? last.concealed - first.concealed : 0;
    const earned = samplesDuringHold > 0;
    const observedRatio = samplesDuringHold > 0 ? concealedDuringHold / samplesDuringHold : null;

    console.log("\n===== picture restore, shaping removed mid-run =====");
    console.log(`downgraded at                : ${Math.round((downgradedAt - started) / 1000)}s`);
    console.log(`restored                     : ${restored ? `${Math.round((restoredAt - downgradedAt) / 1000)}s after the downgrade` : `NO — not within ${Math.round(RESTORE_BUDGET_MS / 1000)}s`}`);
    console.log(`policy minimum               : ${HEALTH_THRESHOLDS.MIN_AFTER_DOWNGRADE_MS / 1000}s cooldown + ${HEALTH_THRESHOLDS.INITIAL_HEALTHY_HOLD_MS / 1000}s healthy hold`);
    console.log(`audio samples during hold    : ${samplesDuringHold}`);
    console.log(`concealed during hold        : ${concealedDuringHold}`);
    console.log(`observed concealment ratio   : ${observedRatio === null ? "n/a (no audio arrived)" : observedRatio.toFixed(4)}  (CONCEAL_GOOD=${HEALTH_THRESHOLDS.CONCEAL_GOOD})`);
    console.log(`earned (CONCEAL_GOOD tested) : ${earned}`);
    if (!earned) {
      console.log("  ⚠ the interviewer was silent for the whole hold, so the restore rode on a 0-of-0");
      console.log("    concealment reading. CONCEAL_GOOD is still unmeasured — rerun with FAKE_AUDIO so a");
      console.log("    turn is in progress and the interviewer is actually speaking.");
    }
    console.log("\nper-sample trace (t, mode, audioSamples, concealed, videoBytes, framesDecoded, rtt):");
    samples.forEach((s) =>
      console.log(
        `  ${String(Math.round(s.t / 1000)).padStart(4)}s  ${String(s.mode).padEnd(11)} ${String(s.audioSamples).padStart(9)} ${String(s.concealed).padStart(8)} ${String(s.videoBytes).padStart(9)} ${String(s.framesDecoded).padStart(6)} ${s.rttMs ?? "-"}`,
      ),
    );
    console.log("\ndecision log:");
    decisions.forEach((d) => console.log(`  ${d}`));
    console.log("===================================================\n");

    // The assertion is the restore itself. Everything above is the evidence for calibrating the
    // threshold, and it is printed BEFORE this so a failure still hands over the numbers.
    expect(restored, "the picture came back after the link recovered").toBe(true);
    const videoAfter = samples.filter((s) => s.mode === "video" && s.t > (downgradedAt - started));
    expect(
      videoAfter.some((s) => s.framesDecoded > 0),
      "the restored session actually decodes frames (not just a video m-line)",
    ).toBe(true);
  });
});
