/** AvatarGrid: real-face thumbnails, onError→initial fallback, all/photo/video filter, style dropdown. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { AvatarGrid } from "./AvatarGrid";

function renderGrid(props: Partial<Parameters<typeof AvatarGrid>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <AvatarGrid character="lisa" style="casual-sitting" onSelect={onSelect} {...props} />
    </FluentProvider>,
  );
  return { onSelect };
}

describe("AvatarGrid", () => {
  it("renders real-face thumbnail images (not just letter blocks)", () => {
    renderGrid();
    const imgs = screen.getAllByRole("img");
    expect(imgs.length).toBeGreaterThan(0);
    // Lisa's default-style tile points at the MS Learn CDN.
    const lisa = imgs.find((el) => el.getAttribute("src")?.includes("lisa-casual-sitting.png"));
    expect(lisa).toBeTruthy();
  });

  it("falls back to the name initial when a thumbnail fails to load", () => {
    renderGrid();
    const harryTiles = screen.getAllByTestId("avatar-option-harry");
    const firstImg = within(harryTiles[0]).getByRole("img");
    fireEvent.error(firstImg); // simulate a 404
    // The tile now shows the initial "H" instead of an <img>.
    expect(within(harryTiles[0]).queryByRole("img")).toBeNull();
    expect(within(harryTiles[0]).getByText("H")).toBeInTheDocument();
  });

  it("video filter hides photo avatars; photo filter hides video avatars", async () => {
    const user = userEvent.setup();
    renderGrid();
    // Adrian is a photo avatar; Lisa is a video avatar.
    expect(screen.getByTestId("avatar-option-adrian")).toBeInTheDocument();
    expect(screen.getAllByTestId("avatar-option-lisa").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("avatar-filter-video"));
    expect(screen.queryByTestId("avatar-option-adrian")).toBeNull();
    expect(screen.getAllByTestId("avatar-option-lisa").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("avatar-filter-photo"));
    expect(screen.getByTestId("avatar-option-adrian")).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-option-lisa")).toBeNull();
  });

  it("shows a style dropdown for a selected video avatar", () => {
    renderGrid({ character: "lisa", style: "casual-sitting" });
    expect(screen.getByTestId("avatar-style-dropdown")).toBeInTheDocument();
  });

  it("hides the style dropdown for a selected photo avatar", () => {
    renderGrid({ character: "adrian", style: "" });
    expect(screen.queryByTestId("avatar-style-dropdown")).toBeNull();
  });

  it("selecting a video tile calls onSelect with that character's default style", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderGrid();
    await user.click(screen.getAllByTestId("avatar-option-harry")[0]);
    expect(onSelect).toHaveBeenCalledWith("harry", "business");
  });

  it("selecting a photo tile calls onSelect with an empty style", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderGrid();
    await user.click(screen.getByTestId("avatar-option-adrian"));
    expect(onSelect).toHaveBeenCalledWith("adrian", "");
  });
});
