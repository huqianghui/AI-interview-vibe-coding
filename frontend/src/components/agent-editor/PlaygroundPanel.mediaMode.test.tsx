/**
 * Coverage for the portrait-overlay's new `mediaMode` gating (weak-network media adaptation,
 * 2026-09-30).
 *
 * `PlaygroundPanel.tsx`'s "shows the static portrait while the avatar is not yet painting frames"
 * overlay used to be gated purely on `!voice.isAvatarConnected`. It is now ALSO suppressed when
 * `voice.mediaMode === "audio-only"` — per the inline comment, once the weak-network degrade drops
 * the picture it is NOT coming back on its own, so the panel must not cover the orb with a still
 * portrait that implies the picture is still loading. `AvatarView`'s own voice-only pill explains
 * the state instead.
 *
 * `PlaygroundPanel.test.tsx` renders the REAL `useInterviewVoice` hook (no mock at all) and never
 * varies `mediaMode` — with no live session, the real hook's `mediaMode` stays at its "video"
 * default, so that file's existing "shows the static portrait…" assertion never exercises the new
 * `voice.mediaMode !== "audio-only"` clause. This is a separate NEW test file (not an edit to the
 * existing one) so the audit's "only add new test files" constraint holds; it introduces its own
 * `vi.spyOn(voiceModule, "useInterviewVoice")`, mirroring the exact pattern already proven in
 * `InterviewPage.videoToggle.test.tsx` (a fresh file's mocking choices don't need to match the
 * existing file's, only produce a valid, convention-consistent test).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import { PlaygroundPanel } from "./PlaygroundPanel";
import * as voiceModule from "../../hooks/useInterviewVoice";

function baseVoiceMock(overrides: Record<string, unknown> = {}) {
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    toggleMute: () => undefined,
    isMuted: false,
    connectionState: "idle" as const,
    audioState: "idle" as const,
    isAvatarConnected: false,
    mediaMode: "video" as const,
    ...overrides,
  };
}

function renderPanel(voiceMock: Record<string, unknown>) {
  vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue(voiceMock as never);
  return render(
    <FluentProvider theme={webLightTheme}>
      <PlaygroundPanel personaId="p1" character="lisa" style="casual-sitting" locale="zh-CN" />
    </FluentProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PlaygroundPanel portrait overlay vs mediaMode", () => {
  it("shows the static portrait while not connected and still in video mode (unchanged behaviour)", () => {
    renderPanel(baseVoiceMock({ isAvatarConnected: false, mediaMode: "video" }));
    expect(screen.getByTestId("playground-portrait-overlay")).toBeInTheDocument();
  });

  it("suppresses the portrait once the weak-network degrade drops to audio-only, even though not connected", () => {
    renderPanel(baseVoiceMock({ isAvatarConnected: false, mediaMode: "audio-only" }));
    expect(screen.queryByTestId("playground-portrait-overlay")).not.toBeInTheDocument();
  });

  it("keeps the portrait hidden once actually connected, regardless of mediaMode (pre-existing behaviour, sanity check)", () => {
    renderPanel(baseVoiceMock({ isAvatarConnected: true, mediaMode: "video" }));
    expect(screen.queryByTestId("playground-portrait-overlay")).not.toBeInTheDocument();
  });
});
