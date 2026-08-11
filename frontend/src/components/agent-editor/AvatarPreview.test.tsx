/** AvatarPreview: static real-face preview, onError fallback, orb when no character. */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import { AvatarPreview } from "./AvatarPreview";

function renderPreview(character: string, style: string) {
  render(
    <FluentProvider theme={webLightTheme}>
      <AvatarPreview character={character} style={style} />
    </FluentProvider>,
  );
}

describe("AvatarPreview", () => {
  it("shows the selected video avatar's real-face CDN photo for its style", () => {
    renderPreview("lisa", "graceful-standing");
    const img = screen.getByTestId("avatar-preview-img");
    expect(img.getAttribute("src")).toContain("lisa-graceful-standing.png");
  });

  it("shows a photo avatar's single CDN photo (with -avatar suffix where applicable)", () => {
    renderPreview("amira", "");
    const img = screen.getByTestId("avatar-preview-img");
    expect(img.getAttribute("src")).toContain("amira-avatar.png");
  });

  it("falls back to the name initial when the photo fails to load", () => {
    renderPreview("lisa", "casual-sitting");
    fireEvent.error(screen.getByTestId("avatar-preview-img"));
    expect(screen.queryByTestId("avatar-preview-img")).toBeNull();
    expect(screen.getByText("L")).toBeInTheDocument();
  });

  it("shows the voice-only orb when there is no character", () => {
    renderPreview("", "");
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-preview-img")).toBeNull();
  });
});
