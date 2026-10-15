/**
 * What to change, comparing a grade's recommended starting form and settings
 * (docs/network-grades.md §2, verbatim: change one, change the other) with the current ones: the
 * interviewer's digital human (video, photo, none) and the deployment's avatar bitrate override and
 * uplink sample rate. Each line is a change the grade calls for, or a note that something already
 * matches or could be better.
 */
import type { CurrentConfig } from "../../api/admin";
import type { Grade } from "./networkGrade";

export interface Advice {
  /** i18n key under admin.performance.advice */
  key: string;
  params?: Record<string, string | number>;
  /** A change the grade calls for (else a note). */
  change: boolean;
}

const SAMPLE_RATE = 16_000;
/** An override below this lowers a video avatar's picture for no reason on grade A. */
const VIDEO_BITRATE_FLOOR = 1_000_000;

export function adviseConfig(
  grade: Grade,
  config: CurrentConfig,
  { autoBitrate = false }: { autoBitrate?: boolean } = {},
): Advice[] {
  const out: Advice[] = [];
  const who = config.interviewer;
  const override = config.avatar_video_bitrate;
  if (!who) {
    out.push({ key: "noInterviewer", change: false });
  } else {
    const { name, avatar } = who;
    if (grade === "A") {
      if (avatar !== "video") out.push({ key: "videoPossible", params: { name }, change: false });
      if (avatar !== "none" && override !== null && override < VIDEO_BITRATE_FLOOR) {
        out.push({ key: "bitrateTooLow", params: { current: override }, change: false });
      }
    } else if (grade === "B") {
      if (avatar === "video") out.push({ key: "switchToPhoto", params: { name }, change: true });
      if (avatar === "none") out.push({ key: "photoPossible", params: { name }, change: false });
      if (avatar !== "none") {
        // The backend picks the bitrate per session; an override switches that off.
        if (override !== null) {
          out.push({ key: "overrideBitrate", params: { current: override }, change: false });
        } else if (autoBitrate && avatar === "photo") {
          out.push({ key: "autoBitrate", params: { name }, change: false });
        }
      }
    } else if (grade === "C") {
      if (avatar !== "none") out.push({ key: "startVoiceOnly", params: { name }, change: true });
    } else if (avatar !== "none") {
      out.push({ key: "avatarCannotConnect", params: { name }, change: true });
    }
  }
  if (config.input_sampling_rate !== SAMPLE_RATE) {
    out.push({
      key: "sampleRate",
      params: { current: config.input_sampling_rate, value: SAMPLE_RATE },
      change: true,
    });
  }
  return out;
}
