/** Advice: a grade's recommendation (docs/network-grades.md §2) against the current settings. */
import { describe, expect, it } from "vitest";
import type { CurrentConfig } from "../../api/admin";
import { adviseConfig } from "./gradeAdvice";
import type { Grade } from "./networkGrade";

const config = (
  avatar: "video" | "photo" | "none",
  over: Partial<CurrentConfig> = {},
): CurrentConfig => ({
  source: "default",
  interviewer: { id: "p1", name: "Ava", avatar, character: avatar === "none" ? "" : "x" },
  avatar_video_bitrate: null,
  input_sampling_rate: 16000,
  ...over,
});

const keys = (grade: Grade, c: CurrentConfig, autoBitrate = false) =>
  adviseConfig(grade, c, { autoBitrate }).map((a) => `${a.key}${a.change ? "!" : ""}`);

describe("adviseConfig", () => {
  it.each([
    ["A", "video", []],
    ["A", "photo", ["videoPossible"]],
    ["B", "photo", []],
    ["B", "video", ["switchToPhoto!"]],
    ["B", "none", ["photoPossible"]],
    ["C", "photo", ["startVoiceOnly!"]],
    ["C", "none", []],
    ["D", "video", ["avatarCannotConnect!"]],
    ["D", "none", []],
  ] as const)("grade %s with a %s avatar: %o", (grade, avatar, expected) => {
    expect(keys(grade, config(avatar))).toEqual(expected);
  });

  it("B's upper half: the backend lowers a photo avatar's bitrate, said as a note", () => {
    expect(keys("B", config("photo"), true)).toEqual(["autoBitrate"]);
    // A video avatar is told to switch; the automatic bitrate is for photo avatars only.
    expect(keys("B", config("video"), true)).toEqual(["switchToPhoto!"]);
  });

  it("a configured bitrate overrides the backend's choice, and B says so", () => {
    expect(keys("B", config("photo", { avatar_video_bitrate: 500000 }), true)).toEqual([
      "overrideBitrate",
    ]);
  });

  it("A notes a bitrate cap it does not need", () => {
    expect(keys("A", config("video", { avatar_video_bitrate: 300000 }))).toEqual(["bitrateTooLow"]);
  });

  it("the uplink sample rate must be 16 kHz everywhere", () => {
    expect(keys("A", config("video", { input_sampling_rate: 24000 }))).toEqual(["sampleRate!"]);
  });

  it("no interviewer configured", () => {
    expect(keys("B", config("photo", { interviewer: null }))).toEqual(["noInterviewer"]);
  });
});
