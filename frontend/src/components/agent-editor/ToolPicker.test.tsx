/** ToolPicker: tabs, filter, Preview cards disabled, supported add, MCP config gate. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { ToolPicker } from "./ToolPicker";

function renderPicker(props: Partial<Parameters<typeof ToolPicker>[0]> = {}) {
  const onAdd = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <ToolPicker
        open
        onOpenChange={onOpenChange}
        onAdd={onAdd}
        existingTypes={[]}
        {...props}
      />
    </FluentProvider>,
  );
  return { onAdd, onOpenChange };
}

describe("ToolPicker", () => {
  it("renders the three portal tabs", () => {
    renderPicker();
    expect(screen.getByTestId("tool-tab-configured")).toBeInTheDocument();
    expect(screen.getByTestId("tool-tab-catalog")).toBeInTheDocument();
    expect(screen.getByTestId("tool-tab-custom")).toBeInTheDocument();
  });

  it("shows supported + preview cards on the Configured tab", () => {
    renderPicker();
    // Supported.
    expect(screen.getByTestId("tool-card-code_interpreter")).toBeInTheDocument();
    expect(screen.getByTestId("tool-card-web_search")).toBeInTheDocument();
    // Preview card carries a Preview badge.
    const sharepoint = screen.getByTestId("tool-card-sharepoint");
    expect(within(sharepoint).getByText("Preview")).toBeInTheDocument();
  });

  it("adds a supported tool and closes", async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPicker();
    await user.click(screen.getByTestId("tool-card-code_interpreter"));
    await user.click(screen.getByTestId("tool-add"));
    expect(onAdd).toHaveBeenCalledWith({ type: "code_interpreter" });
  });

  it("a preview (unsupported) tool is not selectable and cannot be added", async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPicker();
    const card = screen.getByTestId("tool-card-sharepoint");
    expect(card).toHaveAttribute("aria-disabled", "true");
    await user.click(card);
    // Clicking a disabled card selects nothing → Add stays disabled, nothing added.
    expect(screen.getByTestId("tool-add")).toBeDisabled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("filters cards by the search box", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(screen.getByTestId("tool-search"), "code");
    expect(screen.getByTestId("tool-card-code_interpreter")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-card-web_search")).toBeNull();
  });

  it("Custom → MCP requires a server URL before it can be added", async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPicker();
    await user.click(screen.getByTestId("tool-tab-custom"));
    await user.click(await screen.findByTestId("tool-card-mcp"));
    // Config form appears; Add is disabled until a URL is entered.
    expect(screen.getByTestId("mcp-config-form")).toBeInTheDocument();
    expect(screen.getByTestId("tool-add")).toBeDisabled();

    // Set the value atomically via fireEvent.change rather than char-by-char user.type —
    // under parallel test workers, simulated keystrokes intermittently drop a trailing char.
    fireEvent.change(screen.getByTestId("mcp-server-url"), {
      target: { value: "https://my-mcp/mcp" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("mcp-server-url")).toHaveValue("https://my-mcp/mcp"),
    );
    await user.click(screen.getByTestId("tool-add"));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcp", server_url: "https://my-mcp/mcp" }),
    );
  });
});
