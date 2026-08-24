/** ReportView (SPEC F8): executive view, side-by-side SOP/answer evidence, detail toggle, stub. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
    // The SOP-source-vs-answer proof is present in the exec view (P14).
    const evidence = screen.getByTestId("report-evidence");
    expect(evidence).toHaveTextContent("Follow the documented steps in order.");
    expect(evidence).toHaveTextContent("I followed each documented step");
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

  it("progressively discloses the per-item detail", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    renderReport(SCORED);
    expect(screen.queryByTestId("report-detail")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("toggle-detail"));
    expect(screen.getByTestId("report-detail")).toBeInTheDocument();
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
    // The source label text is still present in the evidence card.
    expect(screen.getByTestId("report-evidence")).toHaveTextContent(/SOP source/i);
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
