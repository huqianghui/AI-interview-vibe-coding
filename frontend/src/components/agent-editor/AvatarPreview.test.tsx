/** AvatarPreview: static real-face preview, onError fallback, orb when no character. */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import { AvatarPreview } from "./AvatarPreview";
import { AVATAR_CHARACTER_MAP } from "../../data/avatarCharacters";

function renderPreview(character: string, style: string) {
  return render(
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

  it("shows the photo without a panel behind it, and the roster knows its backdrop colour", () => {
    // Owner rule (2026-09-24): no outer frame — the photo is the only surface. The measured backdrop
    // colour lives on the roster so the live video can be painted the same colour by Azure.
    renderPreview("amira", "");
    expect(screen.getByTestId("avatar-preview").style.background).toBe("");
    expect(AVATAR_CHARACTER_MAP.get("amira")?.backdrop).toBe("#c09d75");
    expect(AVATAR_CHARACTER_MAP.get("lisa")?.backdrop).toBeUndefined();
  });
});
