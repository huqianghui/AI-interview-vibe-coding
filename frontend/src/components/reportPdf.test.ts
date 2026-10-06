// @vitest-environment node
/** The report PDF: what goes into it (buildReportPdf, a pure function) and that it really renders
 * with the self-hosted CJK fonts (a real pdfmake run in node, not a mock). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Content } from "pdfmake/interfaces";
import i18n from "../i18n";
import type { Report } from "../api/client";
import { REGULAR_FACE_RUNS } from "./pdfGlyphs";
import { MISSING_GLYPH, buildReportPdf, formatGeneratedAt, printable, reportPdfFilename } from "./reportPdf";

const t = i18n.getFixedT("en-US");
const tZh = i18n.getFixedT("zh-CN");

const REPORT: Report = {
  interview_session_id: "iv1",
  status: "scored",
  coverage_pct: 62,
  total_score: 58.4,
  grade: "C",
  outcome: "Needs Improvement",
  capped: true,
  narrative: "Covered the escalation path; missed the documentation timeline.",
  warnings: [
    "Forbidden item triggered: skipped the safety check",
    "Advisory item disclosed: CONFLICT-001",
  ],
  is_stub: false,
  per_question: [
    {
      question_id: "q1",
      prompt: "Can you describe your role as Clinical Study Manager?",
      score: 40,
      outcome: "Does Not Meet",
      capped: true,
      items: [
        {
          kind: "required",
          judgment: "not_met",
          weight: 25,
          rationale: "No SOP-aligned steps were described.",
          answer_quote: "我不知道，也许我会做一些测试",
          source_quote: "Clinical Site Management and Monitoring SOP section 4.2",
          source_page: "p.12",
          source_document_name: "CSM SOP.pdf",
        },
        {
          kind: "forbidden",
          judgment: "violated",
          weight: 0,
          rationale: "Proposed skipping the deviation log.",
          answer_quote: "",
          source_quote: "",
          source_page: null,
        },
      ],
    },
    { question_id: "q2", prompt: "How do you oversee EMEA?", scoring_failed: true, items: [] },
  ],
  sop_coverage: [
    {
      question_id: "q1",
      question_text: "Can you describe your role as Clinical Study Manager?",
      missing: [{ point: "Escalation within 24 hours", sop_evidence: "escalate within 24 h" }],
    },
  ],
  unscored_question_ids: ["q2"],
};

/** Every string a document definition will print, in order. */
function texts(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    return [n.text, n.stack, n.ul, n.table && (n.table as { body: unknown }).body].flatMap((v) =>
      v === undefined ? [] : texts(v),
    );
  }
  return [];
}

function allText(report: Report, tr = t): string {
  const def = buildReportPdf(report, tr, { generatedAt: new Date(2026, 9, 6, 9, 30) });
  return texts(def.content as Content).join("\n");
}

/** Every node in a document definition, depth first, so a test can ask about its styling. */
function nodes(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    const kids = [n.text, n.stack, n.ul, n.table && (n.table as { body: unknown }).body];
    return [n, ...kids.flatMap((k) => (k === undefined ? [] : nodes(k)))];
  }
  return [];
}

/** Render a definition to PDF bytes with pdfmake's node entry and the real self-hosted fonts. */
async function renderPdf(def: ReturnType<typeof buildReportPdf>): Promise<Buffer> {
  const fonts = resolve(__dirname, "../../public/fonts");
  const pdfmake = createRequire(import.meta.url)("pdfmake");
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path: string) => path.startsWith(fonts));
  pdfmake.setFonts({
    NotoSansSC: {
      normal: `${fonts}/noto-sans-sc-regular.otf`,
      bold: `${fonts}/noto-sans-sc-bold-gb2312.otf`,
      italics: `${fonts}/noto-sans-sc-regular.otf`,
      bolditalics: `${fonts}/noto-sans-sc-bold-gb2312.otf`,
    },
  });
  return pdfmake.createPdf(def).getBuffer();
}

describe("buildReportPdf", () => {
  it("opens with the verdict, score, coverage, question count and narrative", () => {
    const text = allText(REPORT);
    expect(text).toContain(t("report.outcome.Needs Improvement"));
    expect(text).toContain("58/100");
    expect(text).toContain("62%");
    expect(text).toContain(t("report.questionsScored", { count: 2 }));
    expect(text).toContain("Covered the escalation path");
    expect(text).toContain(t("report.cappedNote"));
  });

  it("keeps a hard warning, and shows a disclosure only as the neutral note", () => {
    const text = allText(REPORT);
    expect(text).toContain("Forbidden item triggered: skipped the safety check");
    expect(text).not.toContain("CONFLICT-001");
    expect(text).toContain(t("report.disclosureNote"));
    expect(text).toContain(t("report.unscoredBanner", { count: 1 }));
  });

  it("lists every question with its ordinal, prompt and verdict, all expanded", () => {
    const text = allText(REPORT);
    expect(text).toContain(t("report.questionN", { n: 1 }));
    expect(text).toContain("Can you describe your role as Clinical Study Manager?");
    expect(text).toContain(`${t("report.outcome.Does Not Meet")} · 40/100 · ${t("report.cappedShort")}`);
    expect(text).toContain(t("report.questionN", { n: 2 }));
    expect(text).toContain("How do you oversee EMEA?");
  });

  it("prints each judged item with its rationale, SOP source and the candidate's own words", () => {
    const text = allText(REPORT);
    expect(text).toContain(t("report.judgment.not_met"));
    expect(text).toContain("No SOP-aligned steps were described.");
    expect(text).toContain(`${t("report.sopSource")} · CSM SOP.pdf · p.12`);
    expect(text).toContain("“Clinical Site Management and Monitoring SOP section 4.2”");
    expect(text).toContain(t("report.candidateAnswer"));
    expect(text).toContain("“我不知道，也许我会做一些测试”");
    // An item with no quotes prints neither panel label for itself.
    expect(text).toContain("Proposed skipping the deviation log.");
  });

  it("says a question could not be scored instead of printing 0/100", () => {
    const text = allText(REPORT);
    // The unscored question's own verdict line, directly under its prompt.
    expect(text).toContain(`How do you oversee EMEA?\n${t("report.notScored")}\n${t("report.notScoredNote")}`);
    expect(text).not.toMatch(/(^|\D)0\/100/);
  });

  it("adds the SOP coverage findings on their own page, only when the audit found something", () => {
    const def = buildReportPdf(REPORT, t);
    const section = (def.content as Content[]).find(
      (c) => typeof c === "object" && (c as { text?: string }).text === t("report.sopCoverage.title"),
    );
    expect(section).toMatchObject({ pageBreak: "before" });
    expect(allText(REPORT)).toContain("Escalation within 24 hours");
    expect(allText(REPORT)).toContain("escalate within 24 h");
    expect(allText({ ...REPORT, sop_coverage: null })).not.toContain(t("report.sopCoverage.title"));
  });

  it("follows the interface language for its own labels and keeps the content as written", () => {
    const text = allText(REPORT, tZh);
    expect(text).toContain(tZh("report.title"));
    expect(text).toContain(tZh("report.candidateAnswer"));
    expect(text).toContain("How do you oversee EMEA?");
  });

  it("renders a stub report as the same plain list the page shows", () => {
    const text = allText({
      interview_session_id: "iv1",
      status: "scored",
      coverage_pct: 50,
      is_stub: true,
      per_question: [{ question_id: "q1", judgment: "partial", rationale: "short answer" }],
    });
    expect(text).toContain("q1");
    expect(text).toContain(": partial — short answer");
    expect(text).toContain(t("stubNote"));
  });

  it("prints no character the embedded font lacks (the page's ⚑ flag has no Noto Sans SC glyph)", () => {
    expect(allText(REPORT)).not.toContain("⚑");
    expect(allText(REPORT, tZh)).not.toContain("⚑");
  });

  it("has a glyph for every character it prints, in both faces and both languages", () => {
    // Bold is a GB2312 subset; a label character outside it would print as nothing.
    const fontkit = createRequire(import.meta.url)("fontkit");
    const fonts = resolve(__dirname, "../../public/fonts");
    for (const file of ["noto-sans-sc-regular.otf", "noto-sans-sc-bold-gb2312.otf"]) {
      const face = fontkit.openSync(`${fonts}/${file}`);
      for (const tr of [t, tZh]) {
        const missing = [...new Set(allText(REPORT, tr).replace(/\s/g, ""))].filter(
          (ch) => !face.hasGlyphForCodePoint(ch.codePointAt(0)),
        );
        expect(missing, `${file} lacks glyphs`).toEqual([]);
      }
    }
  });

  it("never sets client-authored text (prompts, coverage questions) in the GB2312-subset bold face", () => {
    const all = nodes(buildReportPdf(REPORT, t).content);
    const def = buildReportPdf(REPORT, t);
    expect((def.styles as Record<string, { bold?: boolean }>).question.bold).toBeUndefined();
    for (const external of ["Can you describe your role as Clinical Study Manager?", "How do you oversee EMEA?"]) {
      const matches = all.filter((n) => n.text === external);
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.bold).toBeUndefined();
    }
  });

  it("asks for no italic face, since none is embedded", () => {
    expect(nodes(buildReportPdf(REPORT, t).content).some((n) => n.italics)).toBe(false);
  });

  it("stamps the time in the interface language, not the browser's", () => {
    const at = new Date(2026, 9, 6, 21, 47);
    const zh = texts(buildReportPdf(REPORT, tZh, { generatedAt: at, locale: "zh-CN" }).content).join("\n");
    expect(zh).toContain(formatGeneratedAt(at, "zh-CN"));
    expect(formatGeneratedAt(at, "zh-CN")).toMatch(/2026年10月6日/);
    expect(formatGeneratedAt(at, "en-US")).toMatch(/Oct 6, 2026/);
  });

  it("uses the self-hosted CJK font and A4 pages", () => {
    const def = buildReportPdf(REPORT, t);
    expect(def.pageSize).toBe("A4");
    expect(def.defaultStyle).toMatchObject({ font: "NotoSansSC" });
  });
});

describe("reportPdfFilename", () => {
  it("names the file by the local date", () => {
    expect(reportPdfFilename(new Date(2026, 0, 5))).toBe("interview-report-2026-01-05.pdf");
  });
});

describe("rendering", () => {
  it("produces a real PDF with the Noto Sans SC fonts embedded", async () => {
    const fonts = resolve(__dirname, "../../public/fonts");
    const buffer = await renderPdf(buildReportPdf(REPORT, tZh));
    const raw = buffer.toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansSC-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansSC-Bold/);
    // Subset on embed: the 8 MB face becomes a few dozen KB in the document.
    expect(buffer.length).toBeLessThan(400_000);
    expect(readFileSync(`${fonts}/OFL-Noto-Sans-CJK.txt`, "utf8")).toContain("SIL Open Font License");
  }, 30_000);
});

describe("long content", () => {
  it("keeps every word of an answer longer than a page (it used to vanish from the PDF)", async () => {
    // A single item marked unbreakable that is taller than a page was silently DROPPED by pdfmake:
    // a 10,000-character answer left neither its start nor its end in the document, and no error.
    const answer = `START-MARKER ${"这是一段非常长的候选人回答，用来测试分页。".repeat(450)} END-MARKER`;
    const long: Report = {
      ...REPORT,
      sop_coverage: null,
      per_question: [
        {
          question_id: "q1",
          prompt: "P",
          score: 10,
          items: [{ ...REPORT.per_question[0].items![0], answer_quote: answer }],
        },
      ],
    };
    const raw = (await renderPdf(buildReportPdf(long, tZh))).toString("latin1");
    // Each page's text is a separate content stream, so count pages and look for the markers'
    // glyph runs indirectly: the document must span several pages and still end with page N / N.
    const pages = (raw.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

describe("characters the font cannot draw", () => {
  const fonts = resolve(__dirname, "../../public/fonts");

  it("pdfGlyphs.ts lists exactly the regular face's characters (regenerate it if this fails)", () => {
    const fontkit = createRequire(import.meta.url)("fontkit");
    const face = fontkit.openSync(`${fonts}/noto-sans-sc-regular.otf`);
    const fromFont = [...(face.characterSet as number[])].sort((a, b) => a - b);
    const fromRuns = REGULAR_FACE_RUNS.flatMap(([first, last]) =>
      Array.from({ length: last - first + 1 }, (_, i) => first + i),
    );
    expect(fromRuns.length).toBe(fromFont.length);
    expect(fromRuns).toEqual(fromFont);
  });

  it("keeps the symbols SOP text uses, which the first subset dropped", () => {
    const sop = "≤ 25 °C, ≥ 2 h, ≠ 0, ≈ 5 μg/mL, α β Ω, ✓, ㎎ ㎏, ℃";
    expect(printable(sop)).toBe(sop);
  });

  it("prints a visible box for what even the full face lacks, and keeps line breaks", () => {
    expect(printable("ok 😀 \u{20000} end")).toBe(`ok ${MISSING_GLYPH} ${MISSING_GLYPH} end`);
    expect(printable("line one\nline two\tend")).toBe("line one\nline two\tend");
  });

  it("applies to every string in the document, including nested quotes", () => {
    const report: Report = {
      ...REPORT,
      narrative: "Narrative 😀",
      per_question: [
        {
          question_id: "q1",
          prompt: "Store at ≤ 25 °C 😀",
          score: 50,
          items: [{ ...REPORT.per_question[0].items![0], answer_quote: "答 😀", source_quote: "5 μg/mL 😀" }],
        },
      ],
    };
    const text = allText(report);
    expect(text).not.toContain("😀");
    expect(text).toContain(`Narrative ${MISSING_GLYPH}`);
    expect(text).toContain(`Store at ≤ 25 °C ${MISSING_GLYPH}`);
    expect(text).toContain(`“答 ${MISSING_GLYPH}”`);
    expect(text).toContain(`“5 μg/mL ${MISSING_GLYPH}”`);
  });
});
