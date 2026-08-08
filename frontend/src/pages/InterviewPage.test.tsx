/**
 * InterviewPage render + flow test.
 *
 * Drives the full ask → answer → report loop with the API client mocked, proving the page wires
 * the state machine responses into the three phases (idle → interviewing → scored).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { InterviewPage } from "./InterviewPage";
import * as client from "../api/client";

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <InterviewPage />
    </FluentProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("InterviewPage", () => {
  it("renders the start button initially", () => {
    renderPage();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("runs the ask → answer → report loop", async () => {
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 1 },
    });
    vi.spyOn(client, "submitAnswer").mockResolvedValue({
      interview_session_id: "iv1",
      status: "completed",
      current_question: null,
    });
    vi.spyOn(client, "getReport").mockResolvedValue({
      interview_session_id: "iv1",
      status: "scored",
      coverage_pct: 100,
      per_question: [{ question_id: "q1", judgment: "met", rationale: "ok" }],
      is_stub: true,
    });

    renderPage();
    await user.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText("Question one?")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox"), "a sufficiently long answer");
    const submit = screen.getAllByRole("button").find((b) => !b.hasAttribute("disabled"))!;
    await user.click(submit);

    await waitFor(() => expect(screen.getByText(/100%/)).toBeInTheDocument());
    expect(screen.getByText(/met/)).toBeInTheDocument();
  });
});
