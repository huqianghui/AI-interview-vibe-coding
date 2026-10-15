/** Advice: a grade's recommendation (docs/network-grades.md §2) against the current settings. */
import { describe, expect, it } from "vitest";
import type { CurrentConfig } from "../../api/admin";
import { adviseConfig } from "./gradeAdvice";

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

const keys = (grade: "A" | "B" | "C" | "D" | "E", c: CurrentConfig) =>
  adviseConfig(grade, c).map((a) => `${a.key}${a.change ? "!" : ""}`);

describe("adviseConfig", () => {
  it.each([
    ["A", "video", []],
    ["A", "photo", ["videoPossible"]],
    // B is fine at Azure's default bitrate: no line for it unset.
    ["B", "photo", []],
    ["B", "video", ["switchToPhoto!"]],
    ["B", "none", ["photoPossible"]],
    ["C", "photo", ["setBitrateUnset!"]],
    ["C", "video", ["switchToPhoto!", "setBitrateUnset!"]],
    ["D", "photo", ["startVoiceOnly!"]],
    ["D", "none", []],
    ["E", "video", ["avatarCannotConnect!"]],
    ["E", "none", []],
  ] as const)("grade %s with a %s avatar: %o", (grade, avatar, expected) => {
    expect(keys(grade, config(avatar))).toEqual(expected);
  });

  it("C with the bitrate already at 300 kbit/s or lower needs no bitrate change", () => {
    expect(keys("C", config("photo", { avatar_video_bitrate: 300000 }))).toEqual([]);
    expect(adviseConfig("C", config("photo", { avatar_video_bitrate: 500000 }))).toEqual([
      { key: "setBitrate", params: { value: 300000, current: 500000 }, change: true },
    ]);
  });

  it("B flags only a cap set above 500 kbit/s", () => {
    expect(keys("B", config("photo", { avatar_video_bitrate: 800000 }))).toEqual([
      "bitrateOptional",
    ]);
    expect(keys("B", config("photo", { avatar_video_bitrate: 400000 }))).toEqual([]);
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
