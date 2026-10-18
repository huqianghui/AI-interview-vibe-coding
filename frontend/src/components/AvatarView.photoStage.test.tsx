/** AvatarView: a photo avatar at its own 512 px, on a stage filled with its own wall colour, so
 * there is no colour step around it (owner, 2026-10-17). A video avatar is unchanged. */
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AvatarView } from "./AvatarView";
import { portraitKeyFor } from "./avatarPortraitCache";

const STAGE = { width: 710, height: 820 };
// The picture is proven on the frame check's second sample, one second in (avatarFrameHealth), so a
// default 1 s wait races it.
const SETTLE = { timeout: 3000 };

beforeEach(() => {
  // jsdom has no layout: give the stage a size and a ResizeObserver that reports it.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {}
      observe() {
        this.cb();
      }
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderStage(
  stream: { width: number; height: number },
  backdrop: string | null,
  extra: Partial<Parameters<typeof AvatarView>[0]> = {},
) {
  const ref = createRef<HTMLVideoElement>();
  render(
    <FluentProvider theme={webLightTheme}>
      <div data-testid="stage" ref={(el) => {
        if (!el) return;
        Object.defineProperty(el, "clientWidth", { value: STAGE.width, configurable: true });
        Object.defineProperty(el, "clientHeight", { value: STAGE.height, configurable: true });
      }}>
        <AvatarView
          ref={ref}
          audioState="speaking"
          isAvatarConnected
          character="sakura"
          backdrop={backdrop}
          {...extra}
        />
      </div>
    </FluentProvider>,
  );
  const video = ref.current!;
  Object.defineProperty(video, "videoWidth", { value: stream.width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: stream.height, configurable: true });
  Object.defineProperty(video, "readyState", { value: 2, configurable: true });
  act(() => video.dispatchEvent(new Event("loadedmetadata")));
  return video;
}

describe("AvatarView photo stage", () => {
  it("fills the whole stage with the wall colour and draws the face at 512, bottom-centre", async () => {
    renderStage({ width: 512, height: 512 }, "#bbad9c");
    const root = screen.getByTestId("avatar-view");
    await waitFor(() => expect(root).toHaveAttribute("data-photo-stage", "true"), SETTLE);
    // The stage is not hugged to the square: it fills its column, painted the wall colour.
    expect(root.style.width).toBe("");
    expect(root.style.backgroundColor).toBe("rgb(187, 173, 156)");
    const video = screen.getByTestId("avatar-video");
    // Its own size, not enlarged to the 710×820 stage; shoulders on the bottom edge.
    expect(video.style.width).toBe("512px");
    expect(video.style.height).toBe("512px");
    expect(video.style.bottom).toBe("0px");
    expect(video.style.left).toBe("50%");
  });

  it("leaves a video avatar as it was: no fill, filling the stage by cover", async () => {
    renderStage({ width: 1920, height: 1080 }, null);
    const root = screen.getByTestId("avatar-view");
    await waitFor(
      () => expect(screen.getByTestId("avatar-video")).toHaveAttribute("data-fit", "cover"),
      SETTLE,
    );
    expect(root).toHaveAttribute("data-photo-stage", "false");
    expect(root.style.backgroundColor).toBe("");
    expect(screen.getByTestId("avatar-video").style.width).toBe("");
  });

  it("framed (the interview page): a window of exactly 512, the plate inside it, the strip under it", async () => {
    const onPhotoStage = vi.fn();
    renderStage({ width: 512, height: 512 }, "#bbad9c", {
      framed: true,
      onPhotoStage,
      photoOverlay: <div data-testid="plate">Sakura</div>,
      photoBelow: <div data-testid="strip">Topic</div>,
    });
    const root = screen.getByTestId("avatar-view");
    // The window hugs the picture at its own size (710×820 stage, room left for the strip). The
    // size settles over a few renders (stream size, stage size, the picture proven), so wait for it.
    await waitFor(() => {
      expect(root).toHaveAttribute("data-framed", "true");
      expect(root.style.width).toBe("512px");
      expect(root.style.height).toBe("512px");
    }, SETTLE);
    expect(root.style.boxShadow).toContain("#4A2680"); // the ink frame
    expect(root.style.backgroundImage).toBe(""); // the page draws the set, not the window
    // The name plate is INSIDE the window; the strip is its next sibling, directly under it.
    expect(root).toContainElement(screen.getByTestId("plate"));
    expect(root.nextElementSibling).toBe(screen.getByTestId("strip"));
    expect(onPhotoStage).toHaveBeenLastCalledWith(true);
  });

  it("framed but no photo (a video avatar): no window, no plate, no strip; the page is told", async () => {
    const onPhotoStage = vi.fn();
    renderStage({ width: 1920, height: 1080 }, null, {
      framed: true,
      onPhotoStage,
      photoOverlay: <div data-testid="plate" />,
      photoBelow: <div data-testid="strip" />,
    });
    await waitFor(
      () => expect(screen.getByTestId("avatar-video")).toHaveAttribute("data-fit", "cover"),
      SETTLE,
    );
    expect(screen.queryByTestId("plate")).toBeNull();
    expect(screen.queryByTestId("strip")).toBeNull();
    expect(onPhotoStage).toHaveBeenLastCalledWith(false);
  });

  it("framed on a short screen: the window shrinks to leave the strip room, never grows", async () => {
    STAGE.height = 500;
    try {
      renderStage({ width: 512, height: 512 }, "#bbad9c", { framed: true, photoBelow: <div /> });
      const root = screen.getByTestId("avatar-view");
      // 500 - 14 above - 136 for the strip at its tallest (22 gap + 114) = 350.
      await waitFor(() => expect(root.style.width).toBe("350px"), SETTLE);
    } finally {
      STAGE.height = 820;
    }
  });

  it("framed on a narrow screen: sized from the width alone (its height follows its content)", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width: 900px"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    STAGE.height = 300; // content-sized on a phone: must not shrink the window to 170
    try {
      renderStage({ width: 512, height: 512 }, "#bbad9c", { framed: true, photoBelow: <div /> });
      const root = screen.getByTestId("avatar-view");
      await waitFor(() => expect(root.style.width).toBe("512px"), SETTLE);
    } finally {
      STAGE.height = 820;
    }
  });

  it("framed, the 'connecting' pill over the cached still clears the name plate", async () => {
    localStorage.setItem(portraitKeyFor("sakura"), "data:image/jpeg;base64,AAAA");
    try {
      render(
        <FluentProvider theme={webLightTheme}>
          <div ref={(el) => {
            if (!el) return;
            Object.defineProperty(el, "clientWidth", { value: STAGE.width, configurable: true });
            Object.defineProperty(el, "clientHeight", { value: STAGE.height, configurable: true });
          }}>
            <AvatarView
              audioState="idle"
              isAvatarConnected={false}
              character="sakura"
              framed
              photoOverlay={<div data-testid="plate" />}
            />
          </div>
        </FluentProvider>,
      );
      const still = screen.getByTestId("avatar-portrait");
      Object.defineProperty(still, "naturalWidth", { value: 480, configurable: true });
      Object.defineProperty(still, "naturalHeight", { value: 480, configurable: true });
      fireEvent.load(still);
      await screen.findByTestId("plate");
      expect(screen.getByTestId("avatar-connecting-hint").style.bottom).toBe("72px");
    } finally {
      localStorage.removeItem(portraitKeyFor("sakura"));
    }
  });

  it("framed with a masthead: the window sits below it, and the layer around it gets the gutter", async () => {
    const around = vi.fn(() => <span data-testid="around-child" />);
    renderStage({ width: 512, height: 512 }, "#bbad9c", {
      framed: true,
      framedTopPx: 60,
      photoAround: around,
      photoBelow: <div />,
    });
    const root = screen.getByTestId("avatar-view");
    await waitFor(() => expect(root.style.width).toBe("512px"), SETTLE);
    expect(root.style.marginTop).toBe("60px");
    // The layer covers the window exactly: centred in the 710 px stage, 60 px from its top.
    const layer = screen.getByTestId("avatar-photo-around");
    expect(layer.style.top).toBe("60px");
    expect(layer.style.left).toBe("99px");
    expect(layer.style.width).toBe("512px");
    expect(layer).toContainElement(screen.getByTestId("around-child"));
    expect(around).toHaveBeenLastCalledWith({ gutter: 99 });
  });

  it("unframed (the editor) never draws the layer around the window", async () => {
    const around = vi.fn(() => <span data-testid="around-child" />);
    renderStage({ width: 512, height: 512 }, "#bbad9c", { photoAround: around });
    const root = screen.getByTestId("avatar-view");
    await waitFor(() => expect(root).toHaveAttribute("data-photo-stage", "true"), SETTLE);
    expect(screen.queryByTestId("avatar-photo-around")).toBeNull();
    expect(around).not.toHaveBeenCalled();
  });
});
