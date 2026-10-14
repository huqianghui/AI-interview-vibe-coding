/**
 * Digital-human mode off (no character) + voice on used to render TWO orbs and two "Ready" labels:
 * AvatarView's live orb, with the static portrait overlay's own orb stacked on top of it. With no
 * character there is no portrait to hold, so the overlay must stand down once voice is on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import { PlaygroundPanel } from "./PlaygroundPanel";
import * as voiceModule from "../../hooks/useInterviewVoice";

function renderPanel(character: string) {
  vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue({
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    toggleMute: () => undefined,
    isMuted: false,
    connectionState: "connected",
    audioState: "idle",
    isAvatarConnected: false,
    mediaMode: "video",
  } as never);
  return render(
    <FluentProvider theme={webLightTheme}>
      <PlaygroundPanel personaId="p1" character={character} style="" locale="en-US" />
    </FluentProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PlaygroundPanel with digital-human mode off", () => {
  it("shows the preview orb while voice is off", () => {
    renderPanel("");
    expect(screen.getByTestId("playground-portrait-overlay")).toBeInTheDocument();
  });

  it("shows exactly one orb and one status label once voice is on", async () => {
    renderPanel("");
    await userEvent.click(screen.getByTestId("playground-voice-toggle"));
    expect(screen.queryByTestId("playground-portrait-overlay")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("audio-orb")).toHaveLength(1);
    expect(screen.getAllByTestId("orb-status-label")).toHaveLength(1);
  });

  it("still holds the portrait over the stage when a character is set and voice is on", async () => {
    renderPanel("lisa");
    await userEvent.click(screen.getByTestId("playground-voice-toggle"));
    expect(screen.getByTestId("playground-portrait-overlay")).toBeInTheDocument();
  });
});
