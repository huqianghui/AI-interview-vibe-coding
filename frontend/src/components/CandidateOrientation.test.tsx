/**
 * COMPOSITION tests for the orientation screen.
 *
 * The same class of test that was missing when v0.41.0.0 shipped the wrong sign-in layout: token
 * checks pass on any composition, so the things asserted here are the ones that make this screen
 * the approved design — two asymmetric columns, the question count as a display headline, the rail
 * previewing it, and the interviewer present.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider } from "@fluentui/react-components";
import "../i18n";
import { CandidateOrientation } from "./CandidateOrientation";
import { appTheme, palette } from "../theme";

function renderOrientation(
  props: Partial<React.ComponentProps<typeof CandidateOrientation>> = {},
) {
  const onBegin = props.onBegin ?? vi.fn();
  render(
    <FluentProvider theme={appTheme}>
      <CandidateOrientation total={9} isExternal={false} {...props} onBegin={onBegin} />
    </FluentProvider>,
  );
  return { onBegin };
}

const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

describe("CandidateOrientation composition", () => {
  it("lays out two asymmetric columns", () => {
    renderOrientation();
    const split = screen.getByTestId("candidate-orientation-split");
    expect(getComputedStyle(split).gridTemplateColumns).toBe("40fr 60fr");
  });

  it("makes the question COUNT the display headline", () => {
    // This screen's whole reason to exist is the count — it is the one thing idle could not know,
    // because the interview does not exist until startInterview() has run.
    renderOrientation({ total: 9 });
    const h = screen.getByTestId("orientation-headline");
    expect(h).toHaveTextContent("9 questions");
    expect(getComputedStyle(h).fontSize).toContain("clamp(30px");
  });

  it("previews the interview with one rail tick per question", () => {
    renderOrientation({ total: 9 });
    expect(screen.getByTestId("orientation-rail").children).toHaveLength(9);
  });

  it("marks the first tick as 'you are here' in the accent colour", () => {
    // This asserts intent, and it is NOT a guard against the bug that actually happened here —
    // stated plainly so nobody trusts it for more than it does.
    //
    // The first version used template-string class concatenation. Measured in a real browser, that
    // rendered the first tick rgb(207,195,177) — identical to its neighbours, with the magenta
    // marker gone, because griffel's atomic class for `tick`'s backgroundColor won over `tickNow`'s.
    // Measured in jsdom, the SAME broken code renders magenta and this test passes. jsdom does not
    // reproduce griffel's atomic-class ordering, so no jsdom test can catch this class of defect.
    // The real guard is the source-level assertion in `griffel-classnames.test.ts`.
    renderOrientation({ total: 9 });
    const ticks = screen.getByTestId("orientation-rail").children;
    const first = getComputedStyle(ticks[0] as HTMLElement).backgroundColor;
    const second = getComputedStyle(ticks[1] as HTMLElement).backgroundColor;
    expect(first).toBe(rgb(palette.magenta));
    expect(first).not.toBe(second);
  });

  it("caps the rail so a long bank does not render a block of noise", () => {
    renderOrientation({ total: 40 });
    expect(screen.getByTestId("orientation-rail").children).toHaveLength(12);
    // The headline still carries the true number.
    expect(screen.getByTestId("orientation-headline")).toHaveTextContent("40 questions");
  });

  it("shows the interviewer, carried over from the sign-in screen", () => {
    renderOrientation();
    const figure = screen.getByTestId("interviewer-portrait");
    expect(figure.querySelector("img")).not.toBeNull();
    expect(figure).toHaveTextContent("READY");
  });

  it("drops the count and the rail for an external-brain session", () => {
    // External sessions have no fixed total, so a count-based headline would read "0 questions".
    renderOrientation({ total: 0, isExternal: true });
    expect(screen.queryByTestId("orientation-rail")).toBeNull();
    expect(screen.getByTestId("orientation-headline")).toHaveTextContent(
      /interviewer will guide you/i,
    );
  });

  it("begins on the primary action", async () => {
    const user = userEvent.setup();
    const { onBegin } = renderOrientation();
    await user.click(screen.getByTestId("candidate-begin"));
    expect(onBegin).toHaveBeenCalledOnce();
  });
});
