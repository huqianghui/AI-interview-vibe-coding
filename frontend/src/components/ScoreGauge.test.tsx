/** ScoreGauge (SPEC F8): renders the grade + rounded score. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { ScoreGauge } from "./ScoreGauge";
import type { Outcome } from "../api/client";

function renderGauge(score: number, grade: string, outcome?: Outcome) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ScoreGauge score={score} grade={grade} outcome={outcome} />
    </FluentProvider>,
  );
}

describe("ScoreGauge", () => {
  it("shows the grade and rounded score", () => {
    renderGauge(87.4, "A");
    expect(screen.getByTestId("gauge-grade")).toHaveTextContent("A");
    expect(screen.getByTestId("gauge-score")).toHaveTextContent("87/100");
  });

  it("clamps out-of-range scores", () => {
    renderGauge(140, "A");
    expect(screen.getByTestId("gauge-score")).toHaveTextContent("100/100");
  });

  it("reflects the classification outcome tier when supplied", () => {
    renderGauge(72, "B", "Meets Expectations");
    expect(screen.getByTestId("score-gauge")).toHaveAttribute(
      "data-outcome",
      "Meets Expectations",
    );
    // Center still shows the letter grade + numeric detail.
    expect(screen.getByTestId("gauge-grade")).toHaveTextContent("B");
    expect(screen.getByTestId("gauge-score")).toHaveTextContent("72/100");
  });
});
