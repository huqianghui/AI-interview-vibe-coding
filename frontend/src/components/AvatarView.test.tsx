/** AvatarView (SPEC F5/F9): shows the avatar video when connected, the audio orb otherwise. */
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AVATAR_PORTRAIT_STORAGE_KEY, AvatarView } from "./AvatarView";

function renderView(isAvatarConnected: boolean) {
  const ref = createRef<HTMLVideoElement>();
  render(
    <FluentProvider theme={webLightTheme}>
      <AvatarView ref={ref} audioState="listening" isAvatarConnected={isAvatarConnected} />
    </FluentProvider>,
  );
  return ref;
}

describe("AvatarView", () => {
  it("renders the audio orb as the fallback when no avatar video is connected", () => {
    renderView(false);
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
    // The video element is always present (so ontrack can attach a stream at any time).
    expect(screen.getByTestId("avatar-video")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-view")).toHaveAttribute("data-avatar-connected", "false");
  });

  it("keeps the <video> muted so autoplay from ontrack is allowed (avatar audio is separate)", () => {
    // Chrome blocks play() on an unmuted media element outside a user gesture; the avatar track is
    // attached from the async ontrack handler, so an unmuted video silently fails to paint. The
    // avatar's audio arrives on a separate <audio> element, so muting the video loses nothing.
    renderView(true);
    expect(screen.getByTestId<HTMLVideoElement>("avatar-video").muted).toBe(true);
  });

  it("shows the avatar video and hides the orb once connected", () => {
    renderView(true);
    expect(screen.getByTestId("avatar-video")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-orb")).not.toBeInTheDocument();
    expect(screen.getByTestId("avatar-view")).toHaveAttribute("data-avatar-connected", "true");
  });

  it("exposes the video element via ref for the voice hook to attach a stream", () => {
    const ref = renderView(true);
    expect(ref.current).toBeInstanceOf(HTMLVideoElement);
  });

  it("shows the cached portrait (not the orb) while connecting, once a portrait exists", () => {
    // Issue 5: the interviewer's FIGURE should appear instantly on every visit after the first —
    // a frame captured from the previous live session stands in while the stream connects.
    localStorage.setItem(
      AVATAR_PORTRAIT_STORAGE_KEY,
      "data:image/jpeg;base64,aGVsbG8=",
    );
    try {
      renderView(false);
      expect(screen.getByTestId("avatar-portrait")).toBeInTheDocument();
      expect(screen.getByTestId("avatar-connecting-hint")).toBeInTheDocument();
      expect(screen.queryByTestId("audio-orb")).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem(AVATAR_PORTRAIT_STORAGE_KEY);
    }
  });

  it("hides the portrait and its connecting hint once the live video is up", () => {
    localStorage.setItem(
      AVATAR_PORTRAIT_STORAGE_KEY,
      "data:image/jpeg;base64,aGVsbG8=",
    );
    try {
      renderView(true);
      expect(screen.queryByTestId("avatar-portrait")).not.toBeInTheDocument();
      expect(screen.queryByTestId("avatar-connecting-hint")).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem(AVATAR_PORTRAIT_STORAGE_KEY);
    }
  });

  it("ignores a non-image value in the portrait slot (falls back to the orb)", () => {
    localStorage.setItem(AVATAR_PORTRAIT_STORAGE_KEY, "javascript:alert(1)");
    try {
      renderView(false);
      expect(screen.queryByTestId("avatar-portrait")).not.toBeInTheDocument();
      expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
    } finally {
      localStorage.removeItem(AVATAR_PORTRAIT_STORAGE_KEY);
    }
  });
});
