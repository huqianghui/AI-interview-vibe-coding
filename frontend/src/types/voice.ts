/** Voice Live client types (SPEC F9) — ported in shape from the reference Avatar layer. */

export type VoiceConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type AudioState = "idle" | "listening" | "speaking" | "muted";

/** One reading of an audio path, for the orb: `level` is 0..1 loudness, `bands` is 0..1 energy per
 * voice-range band, low to high. */
export interface AudioLevels {
  level: number;
  bands: readonly number[];
}

/** Reads the candidate's mic or the interviewer's playback right now (null before that path exists). */
export type AudioLevelReader = (source: "mic" | "playback") => AudioLevels | null;

export interface TranscriptSegment {
  id: string;
  role: "user" | "assistant";
  content: string;
  isFinal: boolean;
  timestamp: number;
}
