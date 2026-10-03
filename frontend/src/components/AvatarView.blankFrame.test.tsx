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
import { AvatarView } from "./AvatarView";
// These cases render AvatarView with no `character`, so the slot they touch is the one a persona
// without an avatar uses. Naming it through the helper keeps them honest about which slot that is.
import { portraitKeyFor } from "./avatarPortraitCache";
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

  it("NEVER shows a black stream — not even for the first frame", () => {
    // The point of the rewrite. The previous policy showed the picture and retracted ~3s later; measured
    // on real Azure 2026-10-03 the black frame arrives at session START, so those were the three seconds
    // the candidate spent looking at it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubCanvas(0);
    renderConnected();

    const view = screen.getByTestId("avatar-view");
    // Unproven from the start: no timer has judged anything yet, so nothing may be shown.
    expect(view).toHaveAttribute("data-picture", "waiting");
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
    // Still "connected": frames ARE arriving, and saying otherwise would be a different lie.
    expect(view).toHaveAttribute("data-avatar-connected", "true");

    advancePastVerdict();
    // It stays unproven rather than flipping to a "dead" state — there is nothing to retract.
    expect(screen.getByTestId("avatar-view")).toHaveAttribute("data-picture", "waiting");
    // And a sustained blank run leaves EVIDENCE even though nothing was ever shown: a screenshot of a
    // black box cannot say where the pixels came from, so the console has to.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("picture is EMPTY"),
      expect.objectContaining({ meanLuma: 0, videoSize: "1920x1080" }),
    );
  });

  it("retracts a picture that was proven and then goes black mid-session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = stubCanvas(255);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,LIT");
    renderConnected();
    // `renderConnected` defines videoWidth/readyState AFTER the first render, so the effect's immediate
    // tick saw a not-ready element. Let one interval pass so a tick actually judges a frame.
    act(() => {
      vi.advanceTimersByTime(BLANK_SAMPLE_INTERVAL_MS);
    });
    expect(screen.getByTestId("avatar-view")).toHaveAttribute("data-picture", "content");
    // The stream goes black while it is on screen.
    ctx.mockRestore();
    stubCanvas(0);
    advancePastVerdict();
    expect(screen.getByTestId("avatar-view")).toHaveAttribute("data-picture", "blank");
    expect(warn).toHaveBeenCalled();
  });

  it("prefers the cached still over the orb when one exists", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem(portraitKeyFor(null), "data:image/jpeg;base64,AAAA");
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
    expect(view).toHaveAttribute("data-picture", "content");
    expect(screen.queryByTestId("audio-orb")).toBeNull();
    // A good frame IS worth keeping — so the guard below is specific to blank ones, not a blanket
    // "never cache" that would quietly retire the instant-portrait feature.
    expect(localStorage.getItem(portraitKeyFor(null))).toBe("data:image/jpeg;base64,LIT");
  });

  it("never caches a black frame as the still — that would make one fault permanent", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubCanvas(0);
    renderConnected();
    // Past the portrait-capture delay as well as the verdict.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(localStorage.getItem(portraitKeyFor(null))).toBeNull();
  });
});
