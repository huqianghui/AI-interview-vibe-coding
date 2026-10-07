/**
 * COMPOSITION tests, which is the class of test that was missing when v0.41.0.0 shipped the wrong
 * layout.
 *
 * Everything verified for that release was a token check — background colour, button colour, font
 * family, one `<h1>` — and every single one of them passes just as happily on a centred 440px card
 * as on the approved asymmetric split. The owner caught it by looking at the page. So these assert
 * the things that make this screen variant D-purple and not variant B: two columns, the tagline as
 * a display-size headline rather than a caption, and the interviewer's portrait actually on screen.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import "../i18n";
import { CandidateSignIn } from "./CandidateSignIn";
import { appTheme, palette } from "../theme";
import {
  DEFAULT_AVATAR_CHARACTER,
  DEFAULT_AVATAR_STYLE,
} from "../data/avatarCharacters";

function renderSignIn(props: Partial<React.ComponentProps<typeof CandidateSignIn>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  render(
    <FluentProvider theme={appTheme}>
      <CandidateSignIn error={null} busy={false} {...props} onSubmit={onSubmit} />
    </FluentProvider>,
  );
  return { onSubmit };
}

describe("CandidateSignIn composition", () => {
  it("lays out TWO asymmetric columns, not one centred card", () => {
    // The defect this guards: routing this screen through AppShell's `narrow` measure produced a
    // 440px card centred on a plain ground — variant B's layout wearing D's palette.
    renderSignIn();
    const split = screen.getByTestId("candidate-signin-split");
    const cs = getComputedStyle(split);
    expect(cs.display).toBe("grid");
    expect(cs.gridTemplateColumns).toBe("58fr 42fr");
  });

  it("caps the composition's height, so a tall monitor does not drop the portrait to the bottom", () => {
    // The portrait sits at the foot of the editorial column; with the column tied to the full
    // viewport height it fell ~700px below the headline on a 1470px-tall screen.
    renderSignIn();
    expect(getComputedStyle(screen.getByTestId("candidate-signin-split")).minHeight).toBe(
      "min(calc(100vh - 64px), 980px)",
    );
  });

  it("grows the portrait only on a screen that is both wide and tall", () => {
    // Growing with width alone overflowed a short wide screen (1920x800: 140px of scroll, the
    // portrait below the fold, measured in a browser). Height bounds the growth too.
    renderSignIn();
    const width = getComputedStyle(screen.getByTestId("candidate-signin-split").querySelector("figure")!).width;
    for (const term of ["310px", "21vw", "100vh - 900px", "420px"]) expect(width).toContain(term);
  });

  it("sets the tagline as a DISPLAY headline, not a caption", () => {
    // It shipped as a 12px grey line in the header band. The approved direction promotes it to the
    // page's visual hero, so the assertion is on the rendered size, not just the text.
    renderSignIn();
    const headline = screen.getByTestId("signin-headline");
    expect(headline.tagName).toBe("H2");
    // The formula: a 32px floor, the approved 4.4vw slope and 62px ceiling up to 1440px, then a
    // ceiling that grows to 84px. jsdom re-serialises nested clamp() into a mangled string, so
    // assert its terms rather than its spelling (a real browser at 1440px renders it pixel-identical
    // to the approved screenshot, checked when this was written).
    const size = getComputedStyle(headline).fontSize;
    for (const term of ["32px", "4.4vw", "62px", "84px", "1440px", "900px"]) expect(size).toContain(term);
    // All three clauses of the tagline are present and in order.
    expect(headline).toHaveTextContent(/SOP-traceable,\s*digital-human\s*interviewing/);
  });

  it("colours the middle clause of the headline with the action colour", () => {
    renderSignIn();
    const accent = screen.getByText("digital-human");
    // jsdom normalises every colour to `rgb(r, g, b)`, so the palette hex is converted rather than
    // string-matched — comparing against the raw hex passes nothing and proves nothing.
    const [r, g, b] = [1, 3, 5].map((i) =>
      parseInt(palette.action.slice(i, i + 2), 16),
    );
    expect(getComputedStyle(accent).color).toBe(`rgb(${r}, ${g}, ${b})`);
  });

  it("shows the interviewer's portrait — the element that was missing entirely", () => {
    renderSignIn();
    const figure = screen.getByTestId("signin-portrait");
    const img = figure.querySelector("img");
    expect(img).not.toBeNull();
    // Points at the deployment's DEFAULT interviewer, since the screen is pre-auth and no persona
    // is loaded yet. If the default character ever changes, this follows it.
    expect(img!.getAttribute("src")).toContain(
      `${DEFAULT_AVATAR_CHARACTER}-${DEFAULT_AVATAR_STYLE}.png`,
    );
    // Decorative: the caption names the interviewer, so the image must not repeat it to a screen
    // reader.
    expect(img!.getAttribute("alt")).toBe("");
  });

  it("aligns the portrait frame with the headline, not 40px off it", () => {
    // The <figure> UA margin is `1em 40px`. Overriding only the block sides left the inline ones in
    // place, and the portrait shipped 40px to the right of the headline it should line up with
    // (measured live: headline at 92px, frame at 132px). jsdom applies the UA sheet, so this is a
    // real guard rather than a restatement of the CSS.
    renderSignIn();
    const figure = screen.getByTestId("signin-portrait");
    const cs = getComputedStyle(figure);
    expect(cs.marginLeft).toBe("0px");
    expect(cs.marginRight).toBe("0px");
  });

  it("captions the portrait with the role and the interviewer's name", () => {
    renderSignIn();
    const figure = screen.getByTestId("signin-portrait");
    expect(figure).toHaveTextContent("Interviewer");
    expect(figure).toHaveTextContent("Lisa");
    expect(figure).toHaveTextContent("LIVE");
  });

  it("still renders the working sign-in form with its contract intact", () => {
    // The composition changed; the testids E2E and the login specs depend on must not.
    renderSignIn();
    expect(screen.getByTestId("candidate-username-input")).toBeInTheDocument();
    expect(screen.getByTestId("candidate-password-input")).toBeInTheDocument();
    expect(screen.getByTestId("candidate-login")).toBeInTheDocument();
  });

  it("keeps the reassurance copy in the editorial column", () => {
    renderSignIn();
    expect(
      screen.getByText(/take your time\. you can speak or type/i),
    ).toBeInTheDocument();
  });

  it("surfaces a login error with role=alert", () => {
    renderSignIn({ error: "Incorrect username or password." });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Incorrect username or password.",
    );
  });
});
