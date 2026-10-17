/** AvatarView: a photo avatar at its own 512 px, on a stage filled with its own wall colour, so
 * there is no colour step around it (owner, 2026-10-17). A video avatar is unchanged. */
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { AvatarView } from "./AvatarView";

const STAGE = { width: 710, height: 820 };

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

function renderStage(stream: { width: number; height: number }, backdrop: string | null) {
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
    await waitFor(() => expect(root).toHaveAttribute("data-photo-stage", "true"));
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
    await waitFor(() => expect(screen.getByTestId("avatar-video")).toHaveAttribute("data-fit", "cover"));
    expect(root).toHaveAttribute("data-photo-stage", "false");
    expect(root.style.backgroundColor).toBe("");
    expect(screen.getByTestId("avatar-video").style.width).toBe("");
  });
});
