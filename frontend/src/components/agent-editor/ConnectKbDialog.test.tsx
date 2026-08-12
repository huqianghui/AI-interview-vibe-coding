/** ConnectKbDialog: loads connections, cascades to KBs, and calls onAdd with the picked KB. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { ConnectKbDialog } from "./ConnectKbDialog";
import * as personaKnowledge from "../../api/personaKnowledge";

function renderDialog(onAdd = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <ConnectKbDialog open onOpenChange={() => {}} onAdd={onAdd} />
    </FluentProvider>,
  );
  return onAdd;
}

afterEach(() => vi.restoreAllMocks());

describe("ConnectKbDialog", () => {
  it("loads connections, cascades to knowledge bases, and confirms the pick", async () => {
    vi.spyOn(personaKnowledge, "listKbConnections").mockResolvedValue([
      { name: "search-conn", target: "https://s.search.windows.net", is_default: true },
    ]);
    const kbSpy = vi
      .spyOn(personaKnowledge, "listKnowledgeBases")
      .mockResolvedValue([{ value: "sop-kb", label: "SOP KB" }]);

    const onAdd = renderDialog();

    // Open the connection dropdown and pick the option. We use fireEvent (synchronous) rather than
    // userEvent: userEvent's async pointer sequence gets starved under full-suite parallel load and
    // intermittently drops the portal-rendered option click, whereas fireEvent is deterministic.
    await waitFor(() => expect(screen.getByTestId("kb-connection-dropdown")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("kb-connection-dropdown"));
    fireEvent.click(await screen.findByRole("option", { name: /search-conn/ }));

    // Picking a connection loads its knowledge bases (proves onOptionSelect fired).
    await waitFor(() => expect(kbSpy).toHaveBeenCalledWith("search-conn"));
    await waitFor(() =>
      expect(screen.getByTestId("kb-index-dropdown")).not.toHaveAttribute("disabled"),
    );
    fireEvent.click(screen.getByTestId("kb-index-dropdown"));
    fireEvent.click(await screen.findByRole("option", { name: "SOP KB" }));

    // Add fires with the connection target + index name.
    fireEvent.click(screen.getByTestId("kb-add"));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith({
        connection_name: "search-conn",
        connection_target: "https://s.search.windows.net",
        index_name: "sop-kb",
      }),
    );
  });

  it("disables Add until both a connection and a KB are chosen", async () => {
    vi.spyOn(personaKnowledge, "listKbConnections").mockResolvedValue([
      { name: "search-conn", target: "https://s", is_default: false },
    ]);
    vi.spyOn(personaKnowledge, "listKnowledgeBases").mockResolvedValue([]);

    renderDialog();
    await waitFor(() => expect(screen.getByTestId("kb-connection-dropdown")).toBeInTheDocument());
    expect(screen.getByTestId("kb-add")).toBeDisabled();
  });
});
