/** QuestionProgress dot-stepper (SPEC F9 / P11): answered / active / remaining states. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { QuestionProgress } from "./QuestionProgress";

function renderAt(current: number, total: number) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <QuestionProgress current={current} total={total} />
    </FluentProvider>,
  );
}

describe("QuestionProgress", () => {
  it("marks past dots answered, current active, future remaining", () => {
    renderAt(1, 3);
    const dots = screen.getAllByRole("listitem");
    expect(dots).toHaveLength(3);
    expect(dots[0]).toHaveAttribute("data-state", "answered");
    expect(dots[1]).toHaveAttribute("data-state", "active");
    expect(dots[2]).toHaveAttribute("data-state", "remaining");
  });

  it("flags the active dot with aria-current", () => {
    renderAt(0, 2);
    expect(screen.getAllByRole("listitem")[0]).toHaveAttribute("aria-current", "step");
  });
});
