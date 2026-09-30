/**
 * Coverage for the `mediaMode` prop (weak-network media adaptation, 2026-09-30).
 *
 * `AvatarView.test.tsx` never passes `mediaMode` (every call site there relies on the `"video"`
 * default), so `data-media-mode`, the `audio-only` branch (`audioOnly`/`showPortrait` gating), and
 * the `avatar-voice-only-hint` pill (role=status/aria-live, per the source comment on losing the
 * digital human mid-interview) are all currently unexercised. This is a separate NEW test file
 * (not an edit to the existing one) so the audit's "only add new test files" constraint holds.
 */
import { createRef } from "react";
import { describe, expect, it, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AVATAR_PORTRAIT_STORAGE_KEY, AvatarView } from "./AvatarView";

function renderView(isAvatarConnected: boolean, mediaMode?: "video" | "audio-only") {
  const ref = createRef<HTMLVideoElement>();
  render(
    <FluentProvider theme={webLightTheme}>
      <AvatarView
        ref={ref}
        audioState="listening"
        isAvatarConnected={isAvatarConnected}
        mediaMode={mediaMode}
      />
    </FluentProvider>,
  );
  return ref;
}

afterEach(() => {
  localStorage.removeItem(AVATAR_PORTRAIT_STORAGE_KEY);
});

describe("AvatarView mediaMode", () => {
  it("defaults data-media-mode to video when the prop is omitted", () => {
    renderView(false);
    expect(screen.getByTestId("avatar-view")).toHaveAttribute("data-media-mode", "video");
    expect(screen.queryByTestId("avatar-voice-only-hint")).not.toBeInTheDocument();
  });

  it("reflects an explicit video mediaMode and shows no voice-only hint", () => {
    renderView(true, "video");
    expect(screen.getByTestId("avatar-view")).toHaveAttribute("data-media-mode", "video");
    expect(screen.queryByTestId("avatar-voice-only-hint")).not.toBeInTheDocument();
  });

  it("shows an accessible voice-only notice once the media layer drops to audio-only", () => {
    renderView(false, "audio-only");
    const view = screen.getByTestId("avatar-view");
    expect(view).toHaveAttribute("data-media-mode", "audio-only");
    const hint = screen.getByTestId("avatar-voice-only-hint");
    expect(hint).toHaveAttribute("role", "status");
    expect(hint).toHaveAttribute("aria-live", "polite");
    // The orb still fills in for the missing picture (no avatar video connected).
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
  });

  it("keeps the voice-only hint even if the avatar video is (unusually) still marked connected", () => {
    // Belt-and-braces: the hint is gated on mediaMode alone, not on isAvatarConnected, so a caller
    // that hasn't yet flipped isAvatarConnected still gets the accessible notice.
    renderView(true, "audio-only");
    expect(screen.getByTestId("avatar-voice-only-hint")).toBeInTheDocument();
  });

  it("never shows the cached portrait once downgraded to audio-only, even if one is cached", () => {
    // Without the audioOnly gate, a cached portrait would otherwise win over the orb (see
    // AvatarView.test.tsx "shows the cached portrait... while connecting"). A deliberate audio-only
    // degrade must say so plainly, not silently show a stale picture of the interviewer.
    localStorage.setItem(AVATAR_PORTRAIT_STORAGE_KEY, "data:image/jpeg;base64,aGVsbG8=");
    renderView(false, "audio-only");
    expect(screen.queryByTestId("avatar-portrait")).not.toBeInTheDocument();
    expect(screen.queryByTestId("avatar-connecting-hint")).not.toBeInTheDocument();
    expect(screen.getByTestId("avatar-voice-only-hint")).toBeInTheDocument();
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
  });
});
