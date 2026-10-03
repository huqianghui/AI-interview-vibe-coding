/**
 * The cached still belongs to ONE face.
 *
 * Owner, 2026-10-03, after switching the persona to a photo avatar: "the cached photo doesn't change
 * with the selected digital human — it's still lisa." The slot was shared by every character on the
 * reasoning that a change "self-corrects on the next successful session". It does not correct in the
 * window that matters: the still is shown FIRST, while the stream connects, so every visit opened with
 * the previous character's face. Showing the wrong person is worse than showing no person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AvatarView } from "./AvatarView";
import { AVATAR_PORTRAIT_STORAGE_KEY, portraitKeyFor } from "./avatarPortraitCache";

const JPEG = (tag: string) => `data:image/jpeg;base64,${tag}`;

function renderFor(character: string | null, isAvatarConnected = false) {
  const ref = createRef<HTMLVideoElement>();
  const r = render(
    <FluentProvider theme={webLightTheme}>
      <AvatarView
        ref={ref}
        audioState="idle"
        isAvatarConnected={isAvatarConnected}
        character={character}
      />
    </FluentProvider>,
  );
  return { ref, ...r };
}

describe("portraitKeyFor", () => {
  it("gives each character its own slot", () => {
    expect(portraitKeyFor("lisa")).toBe(`${AVATAR_PORTRAIT_STORAGE_KEY}:lisa`);
    expect(portraitKeyFor("amira")).toBe(`${AVATAR_PORTRAIT_STORAGE_KEY}:amira`);
    expect(portraitKeyFor("lisa")).not.toBe(portraitKeyFor("amira"));
  });

  it("normalises case and surrounding space, so the roster's spelling cannot split the slot", () => {
    expect(portraitKeyFor("  LISA ")).toBe(portraitKeyFor("lisa"));
  });

  it("is ALWAYS suffixed — never the bare legacy key, even with no character", () => {
    // The bare key holds whichever face was captured before keying existed. A voice-only persona
    // reading it would show someone who is not in the interview at all.
    for (const c of [null, undefined, "", "   "]) {
      expect(portraitKeyFor(c)).toBe(`${AVATAR_PORTRAIT_STORAGE_KEY}:none`);
      expect(portraitKeyFor(c)).not.toBe(AVATAR_PORTRAIT_STORAGE_KEY);
    }
  });
});

describe("AvatarView portrait slot", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows the still cached for the configured character", () => {
    localStorage.setItem(portraitKeyFor("amira"), JPEG("AMIRA"));
    renderFor("amira");
    expect(screen.getByTestId("avatar-portrait")).toHaveAttribute("src", JPEG("AMIRA"));
  });

  it("does NOT show another character's still — it falls back to the orb instead", () => {
    // The reported bug: lisa's still shown while the persona is a photo avatar.
    localStorage.setItem(portraitKeyFor("lisa"), JPEG("LISA"));
    renderFor("amira");
    expect(screen.queryByTestId("avatar-portrait")).toBeNull();
    expect(screen.getByTestId("audio-orb")).toBeInTheDocument();
  });

  it("follows a character change within one mount", () => {
    localStorage.setItem(portraitKeyFor("lisa"), JPEG("LISA"));
    localStorage.setItem(portraitKeyFor("amira"), JPEG("AMIRA"));
    const { rerender } = renderFor("lisa");
    expect(screen.getByTestId("avatar-portrait")).toHaveAttribute("src", JPEG("LISA"));
    act(() => {
      rerender(
        <FluentProvider theme={webLightTheme}>
          <AvatarView audioState="idle" isAvatarConnected={false} character="amira" />
        </FluentProvider>,
      );
    });
    expect(screen.getByTestId("avatar-portrait")).toHaveAttribute("src", JPEG("AMIRA"));
  });

  it("deletes the legacy un-keyed slot and never shows it", () => {
    localStorage.setItem(AVATAR_PORTRAIT_STORAGE_KEY, JPEG("STALE"));
    renderFor("amira");
    expect(screen.queryByTestId("avatar-portrait")).toBeNull();
    // Freed, not merely ignored — it is a 480px JPEG that nothing can ever read again.
    expect(localStorage.getItem(AVATAR_PORTRAIT_STORAGE_KEY)).toBeNull();
  });

  it("keeps each character's slot, so switching back finds the earlier still", () => {
    localStorage.setItem(portraitKeyFor("lisa"), JPEG("LISA"));
    renderFor("amira");
    expect(localStorage.getItem(portraitKeyFor("lisa"))).toBe(JPEG("LISA"));
  });
});
