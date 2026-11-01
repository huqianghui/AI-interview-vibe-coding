/** AudioOrb (SPEC F9): reflects the Voice Live audio state on the sphere, and moves with the sound. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AudioOrb } from "./AudioOrb";
import type { AudioLevelReader, AudioState } from "../types/voice";

function renderOrb(state: AudioState, readAudioLevels?: AudioLevelReader) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AudioOrb audioState={state} readAudioLevels={readAudioLevels} />
    </FluentProvider>,
  );
}

describe("AudioOrb", () => {
  it("exposes the audio state on the sphere for each state", () => {
    for (const state of ["idle", "listening", "speaking", "muted"] as AudioState[]) {
      const { unmount } = renderOrb(state);
      expect(screen.getByTestId("orb-sphere")).toHaveAttribute("data-state", state);
      unmount();
    }
  });

  it("renders a status label", () => {
    renderOrb("listening");
    expect(screen.getByTestId("orb-status-label")).toBeInTheDocument();
  });
});

/** A 2D context that records the largest x any outline point reached in the last frame — which,
 * the orb being centred, is how far it swelled. */
function recordingContext() {
  const gradient = { addColorStop: vi.fn() };
  let frameMaxX = 0;
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(() => {
      frameMaxX = 0;
    }),
    createRadialGradient: vi.fn(() => gradient),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn((cpx: number) => {
      frameMaxX = Math.max(frameMaxX, cpx);
    }),
    closePath: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clip: vi.fn(),
  };
  return { ctx, frameMaxX: () => frameMaxX };
}

describe("AudioOrb drawing", () => {
  let frames: FrameRequestCallback[] = [];
  let now = 0;

  /** Run `n` animation frames, 16 ms apart. */
  const step = (n: number) =>
    act(() => {
      for (let i = 0; i < n; i++) {
        now += 16;
        const due = frames;
        frames = [];
        due.forEach((cb) => cb(now));
      }
    });

  beforeEach(() => {
    frames = [];
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function withContext() {
    const rec = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      rec.ctx as unknown as CanvasRenderingContext2D,
    );
    return rec;
  }

  it("swells with the interviewer's playback level", () => {
    const rec = withContext();
    let level = 0;
    const reader: AudioLevelReader = (src) => (src === "playback" ? { level, bands: [0, 0, 0, 0] } : null);
    renderOrb("speaking", reader);
    step(30);
    const quiet = rec.frameMaxX();
    level = 1;
    step(30);
    expect(rec.frameMaxX()).toBeGreaterThan(quiet + 5);
  });

  it("follows the mic only while listening", () => {
    const rec = withContext();
    const reader: AudioLevelReader = (src) => (src === "mic" ? { level: 1, bands: [] } : null);
    const { rerender } = renderOrb("speaking", reader);
    step(30);
    const notListening = rec.frameMaxX();
    rerender(
      <FluentProvider theme={webLightTheme}>
        <AudioOrb audioState="listening" readAudioLevels={reader} />
      </FluentProvider>,
    );
    step(30);
    expect(rec.frameMaxX()).toBeGreaterThan(notListening + 5);
  });

  it("stops drawing once a muted orb has settled, and wakes when unmuted", () => {
    withContext();
    // The candidate's mic is loud, but muted ignores it: only the interviewer moves a muted orb.
    const { rerender } = renderOrb("muted", (src) => (src === "mic" ? { level: 1, bands: [] } : null));
    step(200);
    expect(frames).toHaveLength(0);
    rerender(
      <FluentProvider theme={webLightTheme}>
        <AudioOrb audioState="idle" />
      </FluentProvider>,
    );
    expect(frames).toHaveLength(1);
  });

  it("still moves with the interviewer while the candidate is muted", () => {
    const silent = withContext();
    const first = renderOrb("muted", () => null);
    step(30);
    const quiet = silent.frameMaxX();
    first.unmount();
    const loud = withContext();
    renderOrb("muted", (src) => (src === "playback" ? { level: 1, bands: [] } : null));
    step(30);
    expect(loud.frameMaxX()).toBeGreaterThan(quiet + 5);
    expect(frames, "an audible interviewer keeps the loop running").toHaveLength(1);
  });

  it("wakes a parked muted orb when the interviewer starts speaking", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      withContext();
      let level = 0;
      renderOrb("muted", (src) => (src === "playback" ? { level, bands: [] } : null));
      step(200);
      expect(frames).toHaveLength(0);
      act(() => vi.advanceTimersByTime(1000));
      expect(frames, "silence keeps it parked").toHaveLength(0);
      level = 0.5;
      act(() => vi.advanceTimersByTime(300));
      expect(frames).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps drawing when the level reader throws, reading it as silence", () => {
    const rec = withContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderOrb("speaking", () => {
      throw new Error("analyser on a closed context");
    });
    step(10);
    expect(frames, "the loop must survive a failing reader").toHaveLength(1);
    expect(rec.ctx.clearRect).toHaveBeenCalledTimes(10);
    expect(warn, "logged once, not once per frame").toHaveBeenCalledTimes(1);
  });

  it("draws one still frame per state under prefers-reduced-motion, with no loop", () => {
    const rec = withContext();
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { rerender } = renderOrb("speaking", () => ({ level: 1, bands: [1, 1, 1, 1] }));
    expect(frames).toHaveLength(0);
    expect(rec.ctx.clearRect).toHaveBeenCalledTimes(1);
    rerender(
      <FluentProvider theme={webLightTheme}>
        <AudioOrb audioState="listening" />
      </FluentProvider>,
    );
    expect(rec.ctx.clearRect).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(0);
  });

  it("leaves a blank orb, not a broken page, when the canvas cannot draw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    renderOrb("speaking");
    step(5);
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
    expect(frames).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("follows the louder of mic and playback while listening", () => {
    const rec = withContext();
    let mic = 0.2;
    const reader: AudioLevelReader = (src) =>
      src === "mic" ? { level: mic, bands: [] } : { level: 1, bands: [] };
    renderOrb("listening", reader);
    step(30);
    const playbackWins = rec.frameMaxX();
    mic = 1;
    step(30);
    // Mic and playback are now equal: no jump beyond the outline's own drift.
    expect(Math.abs(rec.frameMaxX() - playbackWins)).toBeLessThan(3); // level swell alone is ~10 px
  });

  it("switches to a still orb when prefers-reduced-motion turns on mid-session", () => {
    const rec = withContext();
    let onChange: () => void = () => undefined;
    const mq = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => {
        onChange = cb;
      },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("matchMedia", () => mq);
    renderOrb("speaking");
    step(2);
    expect(frames.length).toBeGreaterThan(0);
    mq.matches = true;
    act(() => onChange());
    const drawn = rec.ctx.clearRect.mock.calls.length;
    step(5);
    expect(frames).toHaveLength(0);
    expect(rec.ctx.clearRect.mock.calls.length).toBe(drawn);
  });
});
