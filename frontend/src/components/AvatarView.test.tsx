/** AvatarView (SPEC F5/F9): shows the avatar video when connected, the audio orb otherwise. */
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AvatarView } from "./AvatarView";

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
});
