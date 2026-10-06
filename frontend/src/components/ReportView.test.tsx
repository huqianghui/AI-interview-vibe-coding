/** ReportView (SPEC F8): executive view, side-by-side SOP/answer evidence, detail toggle, stub. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import i18n from "../i18n";
import { ReportView } from "./ReportView";
import type { Report } from "../api/client";

// The citation link fetches the source document via the client (auth header path); mock it so the
// component test stays a pure render + click test with no network.
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, fetchSopDocument: vi.fn() };
});
import { fetchSopDocument } from "../api/client";

// The PDF itself is tested in reportPdf.test.ts; here only the button's behaviour.
vi.mock("./reportPdf", () => ({ downloadReportPdf: vi.fn() }));
import { downloadReportPdf } from "./reportPdf";

function renderReport(report: Report) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ReportView report={report} />
    </FluentProvider>,
  );
}

const SCORED: Report = {
  interview_session_id: "iv1",
  status: "scored",
  coverage_pct: 80,
  total_score: 80,
  grade: "B",
  narrative: "Demonstrated 2 of the expected points, including following the steps. Main gap: safety.",
  warnings: ["Forbidden item triggered: skipped the safety check"],
  is_stub: false,
  per_question: [
    {
      question_id: "q1",
      prompt: "Describe your deployment safety habit.",
      score: 80,
      grade: "B",
      is_stub: false,
      items: [
        {
          kind: "required",
          judgment: "met",
          weight: 60,
          rationale: "followed the steps",
          answer_quote: "I followed each documented step",
          source_quote: "Follow the documented steps in order.",
          source_page: "p.1",
        },
        {
          kind: "forbidden",
          judgment: "violated",
          weight: 0,
          rationale: "skipped safety",
          answer_quote: "I skipped the check",
          source_quote: "Never bypass the safety check.",
          source_page: "p.2",
        },
      ],
    },
  ],
};

/** Two scored questions. The single-question fixture above cannot catch the defect this file's
 *  newest assertions exist for: the report used to give the side-by-side treatment to the FIRST
 *  question only, and draw that question twice. */
const TWO_QUESTIONS: Report = {
  ...SCORED,
  per_question: [
    SCORED.per_question[0],
    {
      question_id: "q2",
      prompt: "How do you handle a regulatory difference?",
      score: 40,
      grade: "D",
      is_stub: false,
      items: [
        {
          kind: "required",
          judgment: "partially_met",
          weight: 50,
          rationale: "named the regulator but not the escalation",
          answer_quote: "I check the local regulator",
          source_quote: "Escalate country-level divergence to the regional lead.",
          source_page: "p.7",
        },
      ],
    },
  ],
};

describe("ReportView", () => {
  beforeEach(() => {
    vi.mocked(fetchSopDocument).mockReset();
  });

  it("renders the executive view: grade, narrative, warning, side-by-side evidence", async () => {
    await i18n.changeLanguage("en-US");
    renderReport(SCORED);
    expect(screen.getByTestId("gauge-grade")).toHaveTextContent("B");
    expect(screen.getByText(/Main gap: safety/)).toBeInTheDocument();
    expect(screen.getByTestId("report-warning")).toHaveTextContent(/forbidden item triggered/i);
    // The SOP-source-vs-answer proof is on screen with NO click: the first question's section is
    // open by default. It used to live in a separate "evidence" block that drew question 1 twice.
    const detail = screen.getByTestId("report-detail");
    expect(detail).toHaveTextContent("Follow the documented steps in order.");
    expect(detail).toHaveTextContent("I followed each documented step");
  });

  it("renders the classification outcome headline and a critical-error cap note", async () => {
    await i18n.changeLanguage("en-US");
    renderReport({
      ...SCORED,
      outcome: "Needs Improvement",
      capped: true,
    });
    expect(screen.getByTestId("report-outcome")).toHaveTextContent("Needs Improvement");
    expect(screen.getByTestId("score-gauge")).toHaveAttribute("data-outcome", "Needs Improvement");
    // The cap explanation is shown; a critical-error warning stays as a (red) warning.
    expect(screen.getByTestId("report-capped")).toHaveTextContent(/critical error/i);
    expect(screen.getByTestId("report-warning")).toBeInTheDocument();
    // No advisory disclosure was raised here.
    expect(screen.queryByTestId("report-disclosure")).not.toBeInTheDocument();
  });

  it("renders a CONFLICT-001 advisory disclosure neutrally (not as a failure, no cap)", async () => {
    await i18n.changeLanguage("en-US");
    renderReport({
      ...SCORED,
      outcome: "Meets Expectations",
      capped: false,
      warnings: ["Advisory item disclosed (does not cap): PD review timeline conflict"],
    });
    expect(screen.getByTestId("report-outcome")).toHaveTextContent("Meets Expectations");
    // A disclosure note is shown; it is NOT a red warning and there is NO cap note.
    expect(screen.getByTestId("report-disclosure")).toHaveTextContent(/disclosed for transparency/i);
    expect(screen.queryByTestId("report-warning")).not.toBeInTheDocument();
    expect(screen.queryByTestId("report-capped")).not.toBeInTheDocument();
  });

  it("opens the first question by default and leaves the rest collapsed", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    renderReport(TWO_QUESTIONS);
    // Q1's items are rendered; Q2's are not, until its header is clicked. There is no longer a
    // "show detailed breakdown" gate — it would have pushed the proof below the fold.
    expect(screen.queryByTestId("toggle-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("report-detail")).toHaveTextContent("followed the steps");
    expect(screen.getByTestId("report-detail")).not.toHaveTextContent("named the regulator");

    await user.click(screen.getByText("How do you handle a regulatory difference?"));
    expect(screen.getByTestId("report-detail")).toHaveTextContent("named the regulator");
  });

  it("renders the SOP source as a clickable link when the item cites a document", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.mocked(fetchSopDocument).mockResolvedValue("blob:mock-url");
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    renderReport({
      ...SCORED,
      per_question: [
        {
          ...SCORED.per_question[0],
          items: [
            {
              ...SCORED.per_question[0].items![0],
              source_document_id: "doc-1",
              source_document_name: "SOP.pdf",
            },
          ],
        },
      ],
    });

    // Exec-view evidence renders the source as a link (not plain text) and clicking it fetches +
    // opens the document.
    const link = screen.getAllByTestId("sop-source-link")[0];
    await user.click(link);
    expect(fetchSopDocument).toHaveBeenCalledWith("iv1", "doc-1");
    expect(openSpy).toHaveBeenCalledWith("blob:mock-url", "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("renders the SOP source as plain text when the item has no cited document", async () => {
    await i18n.changeLanguage("en-US");
    renderReport(SCORED); // SCORED items carry no source_document_id
    expect(screen.queryByTestId("sop-source-link")).not.toBeInTheDocument();
    // The source label text is still present on the item card.
    expect(screen.getAllByTestId("report-item")[0]).toHaveTextContent(/SOP source/i);
  });

  it("renders a stub report as a minimal list", async () => {
    await i18n.changeLanguage("en-US");
    renderReport({
      interview_session_id: "iv1",
      status: "scored",
      coverage_pct: 100,
      is_stub: true,
      per_question: [{ question_id: "q1", judgment: "met", rationale: "ok" }],
    });
    expect(screen.getByText(/100%/)).toBeInTheDocument();
    expect(screen.getByText(/met/)).toBeInTheDocument();
    expect(screen.queryByTestId("score-gauge")).not.toBeInTheDocument();
  });
});

/**
 * COMPOSITION additions (2026-10-04). The report carries the product's whole credibility claim —
 * every judgement beside the SOP sentence it was measured against and the candidate's own words —
 * so these assert that claim is on screen with real weight, not that the colours are right.
 */
describe("ReportView composition", () => {
  it("sets the overall rating as display type, not a 12px chip", () => {
    // The base fixture carries no classification outcome, so this one supplies it: the rating is
    // the single thing a reader takes away from the report, and a tint badge was not carrying it.
    renderReport({ ...SCORED, outcome: "Meets Expectations" });
    const outcome = screen.getByTestId("report-outcome");
    const heading = outcome.querySelector("h2")!;
    expect(heading).toHaveTextContent(/meets expectations/i);
    expect(getComputedStyle(heading).fontSize).toContain("clamp(26px");
  });

  it("states coverage and the question count as facts beside the rating", () => {
    renderReport(SCORED);
    const exec = screen.getByTestId("report-exec");
    expect(exec.textContent).toMatch(/\d+%/);
    expect(exec.textContent).toMatch(/questions scored/i);
  });

  it("gives EVERY question the side-by-side card, not just the first", async () => {
    // The defect this replaces: one renderer drew question 1 as colour-panelled cards above the
    // fold and every other question as a plain italic-grey text list, so the product's whole
    // credibility claim rested on question 1 alone.
    const user = userEvent.setup();
    renderReport(TWO_QUESTIONS);
    await user.click(screen.getByText("How do you handle a regulatory difference?"));

    const cards = screen.getAllByTestId("report-item");
    expect(cards).toHaveLength(3); // 2 items on q1 + 1 on q2
    for (const card of cards) {
      expect(card.textContent).toMatch(/sop source/i);
      expect(card.textContent).toMatch(/candidate answer/i);
    }
    // Specifically q2's own quotes, in the same shape — not a grey one-liner.
    const q2 = cards[2];
    expect(q2.textContent).toContain("Escalate country-level divergence to the regional lead.");
    expect(q2.textContent).toContain("I check the local regulator");
  });

  it("puts the SOP panel and the answer panel in two columns", () => {
    // The side-by-side IS the claim. One column would make it a list of quotes.
    renderReport(SCORED);
    const grids = Array.from(
      screen.getByTestId("report-detail").querySelectorAll("div"),
    ).filter((d) => getComputedStyle(d).gridTemplateColumns === "1fr 1fr");
    expect(grids.length).toBeGreaterThanOrEqual(1);
  });

  it("renders each question exactly once", async () => {
    // The owner's report (2026-10-05): question 1 appeared twice — once as the "evidence" block and
    // again in the accordion below it — in two different visual languages, which read as a bug.
    const user = userEvent.setup();
    renderReport(TWO_QUESTIONS);
    await user.click(screen.getByText("How do you handle a regulatory difference?"));
    for (const prompt of [
      "Describe your deployment safety habit.",
      "How do you handle a regulatory difference?",
    ]) {
      expect(screen.getAllByText(prompt)).toHaveLength(1);
    }
    // And each question's quotes appear once, not duplicated across two renderers.
    expect(screen.getAllByText(/Follow the documented steps in order\./)).toHaveLength(1);
  });
});


describe("an item with only one usable quote", () => {
  it("gives the lone panel the full width instead of stranding it in half a grid", () => {
    // A judgement can land with only one usable span (no quotable answer, or no linked SOP line).
    // Rendering it in a 1fr 1fr grid left it floating in the left half with dead space beside it.
    renderReport({
      ...SCORED,
      per_question: [
        {
          ...SCORED.per_question[0],
          items: [
            {
              kind: "required",
              judgment: "not_met",
              weight: 100,
              rationale: "nothing in the answer to quote",
              source_quote: "Follow the documented steps in order.",
              // The backend always SENDS these fields; an unusable span arrives as "", not as a
              // missing key (`str(raw.get("answer_quote", "")).strip()` in the scoring engine).
              answer_quote: "",
              source_page: null,
            },
          ],
        },
      ],
    });
    const card = screen.getAllByTestId("report-item")[0];
    expect(card).toHaveTextContent(/sop source/i);
    expect(card).not.toHaveTextContent(/candidate answer/i);
    const oneColumn = Array.from(card.querySelectorAll("div")).filter(
      (d) => getComputedStyle(d).gridTemplateColumns === "1fr",
    );
    expect(oneColumn.length).toBeGreaterThanOrEqual(1);
  });

  it("drops the pair block entirely when the item has neither quote", () => {
    renderReport({
      ...SCORED,
      per_question: [
        {
          ...SCORED.per_question[0],
          items: [
            {
              kind: "required",
              judgment: "not_met",
              weight: 100,
              rationale: "judged with no quotable span on either side",
              answer_quote: "",
              source_quote: "",
              source_page: null,
            },
          ],
        },
      ],
    });
    const card = screen.getAllByTestId("report-item")[0];
    expect(card).toHaveTextContent("judged with no quotable span on either side");
    expect(card).not.toHaveTextContent(/sop source:/i);
    expect(card).not.toHaveTextContent(/candidate answer/i);
  });
});

describe("a question nobody could score is not a question scored zero", () => {
  /** A report where question 2's grading failed — the shape the backend emits (P7): no score, no
   *  grade, no items, `scoring_failed` true, and the id echoed in `unscored_question_ids`. */
  const WITH_FAILURE: Report = {
    ...SCORED,
    total_score: 80, // the surviving question only — the failed one is out of the denominator
    unscored_question_ids: ["q2"],
    per_question: [
      SCORED.per_question[0],
      {
        question_id: "q2",
        prompt: "How do you handle a regulatory difference?",
        is_stub: false,
        scoring_failed: true,
        scoring_error: "ScoringIncomplete",
        items: [],
      },
    ],
  };

  it("labels it 'Not scored' instead of 0/100", () => {
    renderReport(WITH_FAILURE);
    // Assert on the FAILED question's own header, not the whole accordion: a sibling scored 80 and
    // "80/100" contains "0/100", so a whole-tree assertion cannot tell the two apart.
    const failedHeader = screen
      .getByText("How do you handle a regulatory difference?")
      .closest("button")!;
    expect(failedHeader).toHaveTextContent(/not scored/i);
    // The specific regression: `Math.round(q.score ?? 0)` fabricated a zero for a question that has
    // no score, which reads as "answered badly" — the one meaning the backend refuses to imply.
    expect(failedHeader.textContent).not.toMatch(/\d+\s*\/\s*100/);

    // The question that DID score still shows its number.
    const scoredHeader = screen
      .getByText("Describe your deployment safety habit.")
      .closest("button")!;
    expect(scoredHeader).toHaveTextContent("80/100");
  });

  it("says so at report level too, and says it is not a zero", () => {
    renderReport(WITH_FAILURE);
    const banner = screen.getByTestId("report-unscored");
    expect(banner).toHaveTextContent(/1 question/i);
    expect(banner).toHaveTextContent(/not counted as zero/i);
  });

  it("explains it inside the question, as a neutral note rather than a warning", async () => {
    const user = userEvent.setup();
    renderReport(WITH_FAILURE);
    await user.click(screen.getByText("How do you handle a regulatory difference?"));
    expect(screen.getByTestId("question-not-scored")).toHaveTextContent(/not counted as zero/i);
    // Not a red warning: the grading failing is the system's problem, not the candidate's.
    expect(screen.queryByTestId("report-warning")).not.toHaveTextContent(/not scored/i);
  });

  it("shows no banner when every question scored", () => {
    renderReport(SCORED);
    expect(screen.queryByTestId("report-unscored")).not.toBeInTheDocument();
  });
});

describe("the report names the question it is judging", () => {
  it("leads the evidence block with the question text, not just an ordinal", () => {
    // The report is the one screen whose entire claim is traceability, and until v0.42.6.0 it could
    // only say "Question 1" — a reader had to carry the question in their head from the interview to
    // make sense of the finding beside it.
    renderReport(SCORED);
    expect(screen.getByText("Describe your deployment safety habit.")).toBeInTheDocument();
    // The ordinal survives as a small label above it, so the position is still readable.
    expect(screen.getAllByText("Question 1").length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to the ordinal when a report predates the field", () => {
    // An older scored interview has no `prompt`, and an empty heading would be worse than a number.
    const noPrompt: Report = {
      ...SCORED,
      per_question: SCORED.per_question.map(({ prompt, ...rest }) => {
        void prompt; // dropped on purpose: this is what an older scored report looks like
        return rest;
      }),
    };
    renderReport(noPrompt);
    // Exactly once: without a prompt the heading IS the ordinal, so the eyebrow is not rendered on
    // top of it. Two "Question 1"s in a row was a defect this change introduced and then fixed.
    expect(screen.getAllByText("Question 1")).toHaveLength(1);
    expect(screen.queryByText("Describe your deployment safety habit.")).not.toBeInTheDocument();
  });
});

describe("ReportView PDF download", () => {
  beforeEach(() => vi.mocked(downloadReportPdf).mockReset());

  it("downloads the report on screen, showing a busy label while the PDF is prepared", async () => {
    const user = userEvent.setup();
    // Resolved by a timer rather than by hand: a test-held resolver left the NEXT test's setup
    // hanging (reproduced, cause not established). Long enough that a slow runner still sees the busy
    // state right after the click; the wait below allows for it.
    vi.mocked(downloadReportPdf).mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
    );
    renderReport(SCORED);
    const button = screen.getByTestId("report-download-pdf");
    expect(button).toHaveTextContent(i18n.t("report.downloadPdf"));

    await user.click(button);
    expect(downloadReportPdf).toHaveBeenCalledWith(SCORED, expect.any(Function), i18n.language);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent(i18n.t("report.downloadingPdf"));

    await waitFor(() => expect(button).not.toBeDisabled(), { timeout: 3000 });
    expect(button).toHaveTextContent(i18n.t("report.downloadPdf"));
    expect(screen.queryByTestId("report-download-pdf-error")).not.toBeInTheDocument();
  });

  it("says so when the PDF cannot be made, and lets the candidate try again", async () => {
    const user = userEvent.setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(downloadReportPdf).mockRejectedValueOnce(new Error("font fetch failed"));
    renderReport(SCORED);
    await user.click(screen.getByTestId("report-download-pdf"));
    expect(await screen.findByTestId("report-download-pdf-error")).toHaveTextContent(
      i18n.t("report.downloadPdfFailed"),
    );
    // Logged, so a production failure can be diagnosed without reproducing it.
    expect(logged).toHaveBeenCalledWith("Report PDF download failed", expect.any(Error));
    logged.mockRestore();

    vi.mocked(downloadReportPdf).mockResolvedValueOnce(undefined);
    await user.click(screen.getByTestId("report-download-pdf"));
    await waitFor(() =>
      expect(screen.queryByTestId("report-download-pdf-error")).not.toBeInTheDocument(),
    );
    expect(downloadReportPdf).toHaveBeenCalledTimes(2);
  });

  it("offers the download on a stub report too", () => {
    renderReport({
      interview_session_id: "iv1",
      status: "scored",
      coverage_pct: 50,
      is_stub: true,
      per_question: [{ question_id: "q1", judgment: "partial", rationale: "short" }],
    });
    expect(screen.getByTestId("report-download-pdf")).toBeInTheDocument();
  });
});
