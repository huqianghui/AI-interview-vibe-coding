/**
 * InterviewPage render + flow test (SPEC F9).
 *
 * Drives the full start → orientation → ask → answer → scoring → report loop with the API client
 * mocked, proving the page wires the state-machine responses through the F9 phases, including the
 * new demo-critical beats (orientation, scoring-in-progress, report-ready) and the text channel.
 * Voice is exercised via the P5/503 fallback path (no live WebRTC in jsdom).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import i18n from "../i18n";
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

  it("runs start → orientation → ask → answer → scoring → report", async () => {
    await i18n.changeLanguage("en-US");
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
    // Start → orientation beat.
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await waitFor(() => expect(screen.getByText(/before we begin/i)).toBeInTheDocument());

    // Orientation → interviewing.
    await user.click(screen.getByRole("button", { name: /i'm ready/i }));
    await waitFor(() => expect(screen.getByText("Question one?")).toBeInTheDocument());

    // Progress stepper + text channel are present.
    expect(screen.getByTestId("question-progress")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "a sufficiently long answer");
    await user.click(screen.getByRole("button", { name: /submit answer/i }));

    // Report-ready reveal.
    await waitFor(() => expect(screen.getByText(/100%/)).toBeInTheDocument());
    expect(screen.getByText(/met/)).toBeInTheDocument();
  });

  it("falls back to text when voice brokering is rejected (P5/P6b)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    // Agent not synced → 409.
    vi.spyOn(client, "fetchVoiceSession").mockRejectedValue(
      new client.VoiceSessionError("409 Conflict", 409),
    );

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");

    await user.click(screen.getByRole("button", { name: /answer by voice/i }));

    // Voice-unavailable notice shows and the page is back on the text channel.
    await waitFor(() =>
      expect(screen.getByText(/voice unavailable/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
