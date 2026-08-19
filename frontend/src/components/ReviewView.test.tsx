/**
 * ReviewView test (requirement 4 — the pre-scoring review screen).
 *
 * Proves the candidate can read back every question + their own finalized answer in bank order,
 * and that scoring only starts on an explicit "Submit & evaluate" click (never auto-scored on the
 * last answer). The submit button is disabled while a submit is in flight.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import i18n from "../i18n";
import { ReviewView } from "./ReviewView";
import type { AnsweredQuestion } from "../api/client";

const answers: AnsweredQuestion[] = [
  { question_id: "q1", prompt: "Tell me about yourself.", index: 0, answer_text: "I am a candidate." },
  { question_id: "q2", prompt: "Why this role?", index: 1, answer_text: "It fits my strengths." },
  { question_id: "q3", prompt: "A hard problem you solved?", index: 2, answer_text: "I debugged a race." },
];

function renderReview(props: { busy?: boolean; onSubmit?: () => void } = {}) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ReviewView answers={answers} busy={false} onSubmit={() => undefined} {...props} />
    </FluentProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ReviewView", () => {
  it("renders one card per answer, in bank order, with prompt + answer text", async () => {
    await i18n.changeLanguage("en-US");
    renderReview();

    const rendered = screen.getAllByTestId("review-answer");
    expect(rendered).toHaveLength(3);
    // Bank order (requirement 2): the answers render in the order they were given.
    expect(rendered[0]).toHaveTextContent("I am a candidate.");
    expect(rendered[1]).toHaveTextContent("It fits my strengths.");
    expect(rendered[2]).toHaveTextContent("I debugged a race.");
    // Prompts are shown so the candidate can hold the whole thing in view.
    expect(screen.getByText("Tell me about yourself.")).toBeInTheDocument();
    expect(screen.getByText("A hard problem you solved?")).toBeInTheDocument();
  });

  it("calls onSubmit when the candidate clicks Submit & evaluate (requirement 4)", async () => {
    await i18n.changeLanguage("en-US");
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderReview({ onSubmit });

    await user.click(screen.getByTestId("submit-and-evaluate"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button while a submit is in flight (no double-submit)", async () => {
    await i18n.changeLanguage("en-US");
    renderReview({ busy: true });
    expect(screen.getByTestId("submit-and-evaluate")).toBeDisabled();
  });
});
