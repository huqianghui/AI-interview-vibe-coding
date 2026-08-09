/** AudioOrb (SPEC F9): reflects the Voice Live audio state on the sphere. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AudioOrb } from "./AudioOrb";
import type { AudioState } from "../types/voice";

function renderOrb(state: AudioState) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AudioOrb audioState={state} />
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
