/** "My interviews" (#187) on the candidate's start screen. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import i18n from "../i18n";
import * as client from "../api/client";
import { MyInterviews } from "./MyInterviews";

const ITEM: client.InterviewHistoryItem = {
  id: "i1",
  status: "abandoned",
  started_at: "2026-10-07T09:00:00",
  completed_at: null,
  persona_name: "Ava",
  bank_name: "Safety bank",
  total_score: null,
  outcome: null,
  has_report: false,
};

function renderIt() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <MyInterviews />
    </FluentProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("MyInterviews", () => {
  it("is hidden for a first-time candidate", async () => {
    const list = vi.spyOn(client, "listMyInterviews").mockResolvedValue([]);
    renderIt();
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByTestId("my-interviews")).not.toBeInTheDocument();
  });

  it("is hidden, not an error, when the list cannot be loaded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = vi.spyOn(client, "listMyInterviews").mockRejectedValue(new Error("down"));
    renderIt();
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByTestId("my-interviews")).not.toBeInTheDocument();
  });

  it("lists earlier interviews and opens one, then goes back", async () => {
    await i18n.changeLanguage("en-US");
    vi.spyOn(client, "listMyInterviews").mockResolvedValue([ITEM]);
    const get = vi.spyOn(client, "getMyInterview").mockResolvedValue({
      item: ITEM,
      report: null,
      transcript: [],
    });
    renderIt();
    expect(await screen.findByText("My interviews")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("history-open-i1"));
    expect(get).toHaveBeenCalledWith("i1");
    expect(await screen.findByTestId("history-detail")).toBeInTheDocument();
    await user.click(screen.getByTestId("history-close"));
    expect(screen.getByTestId("history-row-i1")).toBeInTheDocument();
  });

  it("says why an interview could not be opened", async () => {
    await i18n.changeLanguage("en-US");
    vi.spyOn(client, "listMyInterviews").mockResolvedValue([ITEM]);
    vi.spyOn(client, "getMyInterview").mockRejectedValue(new Error("gone"));
    renderIt();
    await userEvent.setup().click(await screen.findByTestId("history-open-i1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("gone");
  });
});
