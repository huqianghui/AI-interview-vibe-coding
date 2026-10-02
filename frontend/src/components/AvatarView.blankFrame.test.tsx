/**
 * The stage's three-state contract, under the one case that used to break it.
 *
 * Owner, 2026-10-02, on seeing a solid black 1920x1080 frame with a timestamp burned into it while the
 * UI said "Speaking": "it is either the cached frame, the digital human, or the audio orb — a black
 * screen is not our design." `isAvatarConnected` could not catch that: it means frames are ARRIVING,
 * and a stream that is alive but empty satisfies it, so the stage kept claiming a working picture and
 * neither fallback ever showed.
 *
 * Separate file rather than an edit to AvatarView.test.tsx: these tests need a stubbed 2-D canvas
 * (jsdom has none) and fake timers, and imposing both on the existing cases would change what they
 * exercise.
 */
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AVATAR_PORTRAIT_STORAGE_KEY, AvatarView } from "./AvatarView";
import { BLANK_SAMPLE_INTERVAL_MS, BLANK_STREAK_TO_FAIL } from "./avatarFrameHealth";

/** Stub `getContext("2d")` so the component can "read" frames jsdom cannot produce. `luma` picks what
 * every pixel reads back as: 0 = the black frame, 255 = a lit one. */
function stubCanvas(luma: number) {
  const getImageData = (_x: number, _y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = luma;
      data[i * 4 + 1] = luma;
      data[i * 4 + 2] = luma;
      data[i * 4 + 3] = 255;
    }
    return { data, width: w, height: h };
  };
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ drawImage: () => undefined, getImageData } as unknown as CanvasRenderingContext2D);
}

/** A connected stage whose element reports a real, decodable 1080p frame. */
function renderConnected() {
  const ref = createRef<HTMLVideoElement>();
  render(
    <FluentProvider theme={webLightTheme}>
      <AvatarView ref={ref} audioState="speaking" isAvatarConnected />
    </FluentProvider>,
  );
  const el = ref.current!;
  Object.defineProperty(el, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(el, "videoHeight", { value: 1080, configurable: true });
  // HAVE_CURRENT_DATA — the sampler refuses to judge anything below this.
  Object.defineProperty(el, "readyState", { value: 2, configurable: true });
  return ref;
}

/** Run the sampler past the verdict threshold. */
function advancePastVerdict() {
  act(() => {
    vi.advanceTimersByTime(BLANK_SAMPLE_INTERVAL_MS * (BLANK_STREAK_TO_FAIL + 1));
  });
}

describe("AvatarView with an empty picture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("falls back to the orb when the stream is alive but black, instead of showing the black", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubCanvas(0);
    renderConnected();
    advancePastVerdict();

    const view = screen.getByTestId("avatar-view");
    // Still "connected" — frames ARE arriving, and saying otherwise would be a different lie.
    expect(view).toHaveAttribute("data-avatar-connected", "true");
    // But the picture is not usable, so the video layer is hidden and a fallback is on screen.
    expect(view).toHaveAttribute("data-picture-dead", "true");
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
    // And the verdict left EVIDENCE: a screenshot of a black box cannot say where the pixels came
    // from, so the next occurrence has to be explainable from the console alone.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("picture is EMPTY"),
      expect.objectContaining({ meanLuma: 0, videoSize: "1920x1080" }),
    );
  });

  it("prefers the cached still over the orb when one exists", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem(AVATAR_PORTRAIT_STORAGE_KEY, "data:image/jpeg;base64,AAAA");
    stubCanvas(0);
    renderConnected();
    advancePastVerdict();

    expect(screen.getByTestId("avatar-portrait")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-orb")).toBeNull();
  });

  it("leaves a lit frame alone, and still caches it — the complement of the test below", () => {
    stubCanvas(255);
    // jsdom has no real encoder; stub it so the capture path completes instead of throwing into the
    // component's best-effort catch (which would hide whether it ran at all).
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,LIT");
    renderConnected();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    const view = screen.getByTestId("avatar-view");
    expect(view).toHaveAttribute("data-picture-dead", "false");
    expect(screen.queryByTestId("audio-orb")).toBeNull();
    // A good frame IS worth keeping — so the guard below is specific to blank ones, not a blanket
    // "never cache" that would quietly retire the instant-portrait feature.
    expect(localStorage.getItem(AVATAR_PORTRAIT_STORAGE_KEY)).toBe("data:image/jpeg;base64,LIT");
  });

  it("never caches a black frame as the still — that would make one fault permanent", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubCanvas(0);
    renderConnected();
    // Past the portrait-capture delay as well as the verdict.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(localStorage.getItem(AVATAR_PORTRAIT_STORAGE_KEY)).toBeNull();
  });
});
