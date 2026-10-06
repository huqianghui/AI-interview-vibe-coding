/** reportPdf's less common shapes (minimal reports, partial items) and the download wiring: which
 * fonts it asks for, what it lets pdfmake fetch, and the file name. pdfmake itself is mocked here;
 * reportPdf.test.ts renders a real PDF. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Content } from "pdfmake/interfaces";
import i18n from "../i18n";
import type { Report } from "../api/client";

const pdf = vi.hoisted(() => {
  const download = vi.fn().mockResolvedValue(undefined);
  return {
    download,
    createPdf: vi.fn(() => ({ download })),
    setFonts: vi.fn(),
    setUrlAccessPolicy: vi.fn(),
  };
});
vi.mock("pdfmake/build/pdfmake", () => ({ default: pdf }));

import { PDF_DOWNLOAD_TIMEOUT_MS, buildReportPdf, downloadReportPdf } from "./reportPdf";

const t = i18n.getFixedT("en-US");

/** A node's inline text with its font runs joined back together, as the reader sees one line. */
function inlineText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(inlineText).join("");
  if (v && typeof v === "object") return inlineText((v as { text?: unknown }).text ?? "");
  return "";
}

/** Every line a document definition will print, in order (inline runs joined, blocks separate). */
function texts(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    const own = n.text === undefined ? [] : [inlineText(n.text)];
    const blocks = [n.stack, n.ul, n.table && (n.table as { body: unknown }).body];
    return [...own, ...blocks.flatMap((v) => (v === undefined ? [] : texts(v)))];
  }
  return [];
}
const allText = (r: Report) => texts(buildReportPdf(r, t).content as Content).join("\n");

const MINIMAL: Report = {
  interview_session_id: "iv9",
  status: "scored",
  coverage_pct: 0,
  is_stub: false,
  per_question: [],
};

describe("buildReportPdf, minimal and partial shapes", () => {
  it("heads a report without an outcome with its title, and prints 0/100 for a missing total", () => {
    const text = allText(MINIMAL);
    expect(text).toContain("0/100");
    expect(text).not.toContain(t("report.cappedNote"));
    expect(text).not.toContain(t("report.disclosureNote"));
    // The title is both the kicker and, with no outcome, the headline.
    expect(text.split(t("report.title")).length - 1).toBe(2);
  });

  it("uses the grade when a question has no outcome, and no flag when it is not capped", () => {
    const text = allText({
      ...MINIMAL,
      per_question: [{ question_id: "q1", prompt: "P?", score: 72.6, grade: "B", items: [] }],
    });
    expect(text).toContain("B · 73/100");
    expect(text).not.toContain(t("report.cappedShort"));
  });

  it("prints a bare score when a question has neither outcome nor grade", () => {
    expect(allText({ ...MINIMAL, per_question: [{ question_id: "q1", prompt: "P?", score: 50 }] })).toContain(
      "\n50/100",
    );
  });

  it("names a question by its ordinal ONCE when the report predates the prompt field", () => {
    // The page drops the eyebrow when the heading is the ordinal; printing both said it twice.
    const text = allText({ ...MINIMAL, per_question: [{ question_id: "q1", score: 50, items: [] }] });
    expect(text.split(t("report.questionN", { n: 1 })).length - 1).toBe(1);
  });

  it("shows the same fallback grade as the page's gauge when the report has none", () => {
    expect(allText(MINIMAL)).toContain("0/100  ·  F  ·");
  });

  it("notes a stub question inside a scored report", () => {
    const text = allText({
      ...MINIMAL,
      per_question: [{ question_id: "q1", prompt: "P?", is_stub: true }],
    });
    expect(text).toContain(t("stubNote"));
    expect(text).toContain(t("report.notScored"));
  });

  it("labels an SOP source with no document name or page plainly", () => {
    const text = allText({
      ...MINIMAL,
      per_question: [
        {
          question_id: "q1",
          prompt: "P?",
          score: 10,
          items: [
            {
              kind: "required",
              judgment: "met",
              weight: 10,
              rationale: "",
              answer_quote: "",
              source_quote: "SOP 1.1",
              source_page: null,
            },
          ],
        },
      ],
    });
    expect(text).toContain(`${t("report.sopSource")}\n“SOP 1.1”`);
    expect(text).not.toContain(t("report.candidateAnswer"));
  });

  it("counts unscored questions from the id list when no row is flagged", () => {
    expect(allText({ ...MINIMAL, unscored_question_ids: ["q1", "q2"] })).toContain(
      t("report.unscoredBanner", { count: 2 }),
    );
  });

  it("names a coverage group by ordinal when it has no question text, and skips missing evidence", () => {
    const text = allText({
      ...MINIMAL,
      per_question: [{ question_id: "q1", prompt: "P?", score: 1 }],
      sop_coverage: [{ question_id: "q1", question_text: "", missing: [{ point: "Gap A", sop_evidence: "" }] }],
    });
    expect(text).toContain(`${t("report.questionN", { n: 1 })}\nGap A`);
    expect(text).not.toContain(`${t("report.sopSource")}: “”`);
  });

  it("handles a stub report whose rows carry no judgment or rationale", () => {
    expect(
      allText({ ...MINIMAL, is_stub: true, per_question: [{ question_id: "q1" }] }),
    ).toContain(":  — "); // both fields absent: an empty judgment, then an empty rationale
  });

  it("numbers its pages in the footer", () => {
    const footer = buildReportPdf(MINIMAL, t).footer as (p: number, n: number) => { text: string };
    expect(footer(2, 5).text).toBe("2 / 5");
  });
});

describe("downloadReportPdf", () => {
  afterEach(() => vi.clearAllMocks());

  it("registers the self-hosted fonts by absolute URL and downloads a dated file", async () => {
    await downloadReportPdf(MINIMAL, t, "en-US");
    const origin = window.location.origin;
    const fonts = pdf.setFonts.mock.calls[0][0].NotoSansSC;
    expect(fonts.normal).toBe(`${origin}/fonts/noto-sans-sc-regular.otf`);
    expect(fonts.bold).toBe(`${origin}/fonts/noto-sans-sc-bold-gb2312.otf`);
    expect(fonts.italics).toBe(fonts.normal);
    expect(fonts.bolditalics).toBe(fonts.bold);
    const latin = pdf.setFonts.mock.calls[0][0].NotoSans;
    expect(latin.normal).toBe(`${origin}/fonts/noto-sans-regular.ttf`);
    expect(latin.bold).toBe(`${origin}/fonts/noto-sans-bold.ttf`);
    expect(pdf.createPdf).toHaveBeenCalledWith(expect.objectContaining({ pageSize: "A4" }));
    expect(pdf.download.mock.calls[0][0]).toMatch(/^interview-report-\d{4}-\d{2}-\d{2}\.pdf$/);
  });

  it("lets pdfmake fetch only our own font files", async () => {
    await downloadReportPdf(MINIMAL, t, "en-US");
    const allow = pdf.setUrlAccessPolicy.mock.calls[0][0] as (url: string) => boolean;
    const origin = window.location.origin;
    expect(allow(`${origin}/fonts/noto-sans-sc-regular.otf`)).toBe(true);
    expect(allow(`${origin}/api/candidate/interview/iv9/report`)).toBe(false);
    expect(allow("https://fonts.gstatic.com/s/x.ttf")).toBe(false);
    expect(allow(`https://evil.example${new URL(origin).pathname}fonts/x.otf`)).toBe(false);
  });

  it("gives up after the timeout instead of leaving the button busy for ever", async () => {
    vi.useFakeTimers();
    try {
      pdf.download.mockReturnValueOnce(new Promise(() => undefined)); // fonts never arrive
      const pending = downloadReportPdf(MINIMAL, t, "en-US");
      const outcome = expect(pending).rejects.toThrow(/not ready after 60s/);
      await vi.advanceTimersByTimeAsync(PDF_DOWNLOAD_TIMEOUT_MS);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats the timestamp in the language it is given", async () => {
    await downloadReportPdf(MINIMAL, t, "zh-CN");
    const [[def]] = pdf.createPdf.mock.calls as unknown as [[{ content: Array<{ text?: string }> }]];
    expect(def.content[1].text).toMatch(/年/);
  });

  it("surfaces a failure to the caller (the button turns it into a message)", async () => {
    pdf.download.mockRejectedValueOnce(new Error("font 404"));
    await expect(downloadReportPdf(MINIMAL, t, "en-US")).rejects.toThrow("font 404");
  });
});
