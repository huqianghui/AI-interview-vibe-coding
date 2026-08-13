/** PlaygroundPanel: text chat sends to the agent; not-yet-saved persona shows a hint. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import { PlaygroundPanel } from "./PlaygroundPanel";
import * as pk from "../../api/personaKnowledge";

function renderPanel(personaId: string | null) {
  render(
    <FluentProvider theme={webLightTheme}>
      <PlaygroundPanel personaId={personaId} character="lisa" style="casual-sitting" locale="zh-CN" />
    </FluentProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("PlaygroundPanel", () => {
  it("prompts to save when the persona has no id yet", () => {
    renderPanel(null);
    expect(screen.getByTestId("playground-needs-save")).toBeInTheDocument();
  });

  it("sends a text message to the agent and shows the reply", async () => {
    const spy = vi
      .spyOn(pk, "testChat")
      .mockResolvedValue({ response_text: "Hello from the agent", response_id: "resp-1" });
    renderPanel("p1");

    fireEvent.change(screen.getByTestId("playground-input"), { target: { value: "hi there" } });
    fireEvent.click(screen.getByTestId("playground-send"));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("p1", "hi there", undefined));
    await waitFor(() => expect(screen.getByText("Hello from the agent")).toBeInTheDocument());
    // The user's message is also shown.
    expect(screen.getByText("hi there")).toBeInTheDocument();
  });

  it("shows an error when the agent chat fails", async () => {
    vi.spyOn(pk, "testChat").mockRejectedValue(new Error("409 Conflict: no synced agent"));
    renderPanel("p1");
    fireEvent.change(screen.getByTestId("playground-input"), { target: { value: "test" } });
    fireEvent.click(screen.getByTestId("playground-send"));
    await waitFor(() =>
      expect(screen.getByTestId("playground-chat-error")).toHaveTextContent(/no synced agent/),
    );
  });

  it("switches to the voice tab and shows a Start button", async () => {
    renderPanel("p1");
    fireEvent.click(screen.getByTestId("playground-tab-voice"));
    await waitFor(() =>
      expect(screen.getByTestId("playground-voice-start")).toBeInTheDocument(),
    );
  });
});
