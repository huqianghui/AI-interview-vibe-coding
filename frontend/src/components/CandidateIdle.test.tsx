/**
 * COMPOSITION tests for the idle screen.
 *
 * What this replaced was one full-width "Start interview" button at the top of an otherwise empty
 * 900px page — full-width by accident, from the `align-items: stretch` that also blew up the
 * orientation button. So the assertions are: the interviewer is present and dominant, the three
 * facts are on screen, and the primary action has an intentional width.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider } from "@fluentui/react-components";
import "../i18n";
import { CandidateIdle } from "./CandidateIdle";
import { appTheme, palette } from "../theme";

function renderIdle(props: Partial<React.ComponentProps<typeof CandidateIdle>> = {}) {
  const onStart = props.onStart ?? vi.fn();
  render(
    <FluentProvider theme={appTheme}>
      <CandidateIdle busy={false} {...props} onStart={onStart} />
    </FluentProvider>,
  );
  return { onStart };
}

const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

describe("CandidateIdle composition", () => {
  it("lays out two asymmetric columns with the portrait first", () => {
    renderIdle();
    const split = screen.getByTestId("candidate-idle-split");
    expect(getComputedStyle(split).gridTemplateColumns).toBe("46fr 54fr");
    // Portrait precedes the briefing in DOM order, so it is the left column and the first thing a
    // screen reader reaches.
    expect(
      split.firstElementChild?.getAttribute("data-testid"),
    ).toBe("interviewer-portrait");
  });

  it("shows the interviewer as the hero, in the tall framing", () => {
    renderIdle();
    const figure = screen.getByTestId("interviewer-portrait");
    expect(figure.querySelector("img")).not.toBeNull();
    expect(figure).toHaveTextContent("READY");
    expect(figure).toHaveTextContent("Your interviewer");
  });

  it("states the three facts that hold without an interview existing yet", () => {
    // This screen runs BEFORE startInterview(), so it has no question count and no persona. These
    // three are what it can say honestly.
    renderIdle();
    const facts = screen.getByTestId("idle-facts");
    expect(facts.children).toHaveLength(3);
    expect(facts).toHaveTextContent(/speak or type/i);
    expect(facts).toHaveTextContent(/you decide when an answer is finished/i);
    expect(facts).toHaveTextContent(/no timer/i);
  });

  it("walks the purple ramp across the three fact markers", () => {
    // The markers are where the palette does work rather than only tinting a button — and they are
    // merged with mergeClasses, which is the thing that silently failed on the orientation rail.
    renderIdle();
    const markers = Array.from(screen.getByTestId("idle-facts").children).map(
      (f) => getComputedStyle(f.firstElementChild as HTMLElement).backgroundColor,
    );
    expect(markers).toEqual([
      rgb(palette.action),
      rgb(palette.violet),
      rgb(palette.magenta),
    ]);
  });

  it("points forward for the question count instead of inventing one", () => {
    renderIdle();
    expect(
      screen.getByText(/how many questions there are on the next screen/i),
    ).toBeInTheDocument();
    // And states no number of its own.
    expect(screen.queryByText(/\d+ questions/)).toBeNull();
  });

  it("gives the primary action an intentional width, not the page's", () => {
    renderIdle();
    const btn = screen.getByTestId("candidate-start");
    const cs = getComputedStyle(btn);
    expect(cs.width).not.toBe("100%");
    expect(cs.height).toBe("50px");
  });

  it("starts on the primary action, and is disabled while busy", async () => {
    const user = userEvent.setup();
    const { onStart } = renderIdle();
    await user.click(screen.getByTestId("candidate-start"));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("disables the action and shows the pending label while busy", () => {
    renderIdle({ busy: true });
    const btn = screen.getByTestId("candidate-start");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/starting/i);
  });
});
