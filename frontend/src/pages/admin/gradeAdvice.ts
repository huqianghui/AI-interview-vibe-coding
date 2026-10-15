/**
 * What to change, comparing a grade's recommended starting form and settings
 * (docs/network-grades.md §2) with the current ones: the interviewer's digital human (video,
 * photo, none) and the deployment's avatar bitrate and uplink sample rate. Each line is a change
 * the grade calls for, or a note that something already matches or could be better.
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

/** The bitrate each grade wants at most, in bit/s; null = leave Azure's default. */
const MAX_BITRATE: Record<Grade, number | null> = {
  A: null,
  B: 500_000,
  C: 300_000,
  D: null,
  E: null,
};
const SAMPLE_RATE = 16_000;

export function adviseConfig(grade: Grade, config: CurrentConfig): Advice[] {
  const out: Advice[] = [];
  const who = config.interviewer;
  if (!who) {
    out.push({ key: "noInterviewer", change: false });
  } else {
    const name = who.name;
    const avatar = who.avatar;
    if (grade === "A") {
      if (avatar !== "video") out.push({ key: "videoPossible", params: { name }, change: false });
    } else if (grade === "B" || grade === "C") {
      if (avatar === "video") out.push({ key: "switchToPhoto", params: { name }, change: true });
      if (avatar === "none") out.push({ key: "photoPossible", params: { name }, change: false });
    } else if (grade === "D") {
      if (avatar !== "none") out.push({ key: "startVoiceOnly", params: { name }, change: true });
    } else if (avatar !== "none") {
      out.push({ key: "avatarCannotConnect", params: { name }, change: true });
    }
  }
  const usesAvatar = who !== null && who.avatar !== "none" && grade !== "D" && grade !== "E";
  const cap = MAX_BITRATE[grade];
  const bitrate = config.avatar_video_bitrate;
  if (usesAvatar && cap !== null && (bitrate === null || bitrate > cap)) {
    // A separate key when unset: the text says "not set (Azure's 2 Mbit/s)" in each language.
    const key = grade === "C" ? "setBitrate" : "bitrateOptional";
    out.push({
      key: bitrate === null ? `${key}Unset` : key,
      params: bitrate === null ? { value: cap } : { value: cap, current: bitrate },
      change: grade === "C",
    });
  }
  if (usesAvatar && grade === "A" && bitrate !== null && bitrate < 1_000_000) {
    out.push({ key: "bitrateTooLow", params: { current: bitrate }, change: false });
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
