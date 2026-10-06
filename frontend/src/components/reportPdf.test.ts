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
import { palette } from "../theme";
import { LATIN_FACE_RUNS, REGULAR_FACE_RUNS } from "./pdfGlyphs";
import {
  MISSING_GLYPH,
  buildReportPdf,
  fontRuns,
  formatGeneratedAt,
  printableBlocks,
  printable,
  reportPdfFilename,
} from "./reportPdf";

const t = i18n.getFixedT("en-US");

const MINIMAL_STUB: Report = {
  interview_session_id: "iv1",
  status: "scored",
  coverage_pct: 0,
  is_stub: true,
  per_question: [],
};
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
    NotoSans: {
      normal: `${fonts}/noto-sans-regular.ttf`,
      bold: `${fonts}/noto-sans-bold.ttf`,
      italics: `${fonts}/noto-sans-regular.ttf`,
      bolditalics: `${fonts}/noto-sans-bold.ttf`,
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

  it("has a glyph for every character it prints, in the exact face and weight that prints it", () => {
    // Bold Noto Sans SC is a GB2312 subset; a label character outside it would print as nothing.
    const fontkit = createRequire(import.meta.url)("fontkit");
    const dir = resolve(__dirname, "../../public/fonts");
    const files: Record<string, Record<"normal" | "bold", string>> = {
      NotoSansSC: { normal: "noto-sans-sc-regular.otf", bold: "noto-sans-sc-bold-gb2312.otf" },
      NotoSans: { normal: "noto-sans-regular.ttf", bold: "noto-sans-bold.ttf" },
    };
    const faces = new Map<string, { hasGlyphForCodePoint(cp: number): boolean }>();
    const face = (font: string, bold: boolean) => {
      const file = files[font][bold ? "bold" : "normal"];
      if (!faces.has(file)) faces.set(file, fontkit.openSync(`${dir}/${file}`));
      return faces.get(file)!;
    };
    const missing: string[] = [];
    // Walk the definition carrying the inherited font and weight, the way pdfmake resolves them.
    const walk = (node: unknown, font: string, bold: boolean, styleBold: Record<string, boolean>) => {
      if (typeof node === "string") {
        for (const ch of node.replace(/\s/g, "")) {
          if (!face(font, bold).hasGlyphForCodePoint(ch.codePointAt(0) as number)) {
            missing.push(`${ch} (${font} ${bold ? "bold" : "regular"})`);
          }
        }
        return;
      }
      if (Array.isArray(node)) return node.forEach((c) => walk(c, font, bold, styleBold));
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      const f = typeof n.font === "string" ? n.font : font;
      const fromStyle = typeof n.style === "string" ? styleBold[n.style] : undefined;
      const b = typeof n.bold === "boolean" ? n.bold : (fromStyle ?? bold);
      for (const key of ["text", "stack", "ul"]) if (n[key] !== undefined) walk(n[key], f, b, styleBold);
      const table = n.table as { body?: unknown } | undefined;
      if (table?.body) walk(table.body, f, b, styleBold);
    };
    // 龘 is in the regular SC face but NOT the GB2312 bold subset: bold client text would lose it.
    const names = "Łukasz Dvořák, Erdoğan, București, Győr, Ελλάδα, Москва, ≤ 25 °C 😀 龘";
    const withNames: Report = {
      ...REPORT,
      narrative: names,
      per_question: [
        { ...REPORT.per_question[0], prompt: `Q about ${names}` },
        REPORT.per_question[1],
      ],
    };
    const stub: Report = {
      ...MINIMAL_STUB,
      per_question: [{ question_id: `id ${names}`, judgment: names, rationale: names }],
    };
    for (const [tr, report] of [
      [t, withNames],
      [tZh, withNames],
      [t, stub],
    ] as const) {
      const def = buildReportPdf(report, tr);
      const styleBold = Object.fromEntries(
        Object.entries(def.styles as Record<string, { bold?: boolean }>).map(([k, v]) => [k, !!v.bold]),
      );
      walk(def.content, "NotoSansSC", false, styleBold);
    }
    expect(missing).toEqual([]);
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

describe("European letters fall back to Noto Sans", () => {
  const fonts = resolve(__dirname, "../../public/fonts");
  const expand = (runs: ReadonlyArray<readonly [number, number]>) =>
    runs.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i));

  it("pdfGlyphs.ts lists exactly Noto Sans's characters, in both weights (regenerate if this fails)", () => {
    const fontkit = createRequire(import.meta.url)("fontkit");
    for (const file of ["noto-sans-regular.ttf", "noto-sans-bold.ttf"]) {
      const set = [...(fontkit.openSync(`${fonts}/${file}`).characterSet as number[])].sort((a, b) => a - b);
      expect(expand(LATIN_FACE_RUNS), file).toEqual(set);
    }
  });

  it("sets only what Noto Sans SC lacks in Noto Sans, keeping words whole otherwise", () => {
    expect(fontRuns("Müller, François, Kraków")).toEqual(["Müller, François, Kraków"]);
    expect(fontRuns("Łukasz")).toEqual([{ text: "Ł", font: "NotoSans" }, "ukasz"]);
    expect(fontRuns("Dvořák 说")).toEqual(["Dvo", { text: "ř", font: "NotoSans" }, "ák 说"]);
    // A line break between two fallback characters stays inside their run.
    expect(fontRuns("ő\nő")).toEqual([{ text: "ő\nő", font: "NotoSans" }]);
  });

  it("prints European names and Greek in full, and only what no face has as □", () => {
    const names = "Łukasz Dvořák, Erdoğan, București, Győr, Ελλάδα";
    expect(printable(names)).toBe(names);
    expect(printable("Ł 😀")).toBe(`Ł ${MISSING_GLYPH}`);
  });

  it("keeps a styled part's bold and colour on every run it splits into (never a nested array)", () => {
    // pdfmake drops a part's own bold/colour when its text is itself an array; flatten instead.
    expect(
      printableBlocks([{ text: ["A: ", { text: "bold Ł red", bold: true, color: "red" }] }]),
    ).toEqual([
      {
        text: [
          "A: ",
          { text: "bold ", bold: true, color: "red" },
          { text: "Ł", font: "NotoSans", bold: true, color: "red" },
          { text: " red", bold: true, color: "red" },
        ],
      },
    ]);
  });

  it("merges nested styles onto each run, and drops parts with nothing to print", () => {
    expect(
      printableBlocks([
        { text: [null, { text: ["x", { text: "Ł", color: "red" }], bold: true }, { bold: true }] },
      ]),
    ).toEqual([
      {
        text: [
          null,
          { bold: true, text: "x" },
          { bold: true, color: "red", text: "Ł", font: "NotoSans" },
        ],
      },
    ]);
  });

  it("keeps the muted colour of an item's kind label when the kind needs Noto Sans", () => {
    const item = { ...REPORT.per_question[0].items![0], kind: "Ł-kind" };
    const def = buildReportPdf({ ...REPORT, per_question: [{ ...REPORT.per_question[0], items: [item] }] }, t);
    const parts = nodes(def.content).filter(
      (n) => typeof n.text === "string" && (n.text === "Ł" || (n.text as string).includes("-kind")),
    );
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.color).toBe(palette.textMuted);
  });

  it("composes a letter and its combining accent so both land in one face", () => {
    expect(fontRuns("Bucures\u0326ti")).toEqual(["Bucure", { text: "ș", font: "NotoSans" }, "ti"]);
  });

  it("prints one box per emoji, not one per invisible joiner or variation selector", () => {
    expect(printable("love ❤️ end")).toBe(`love ${MISSING_GLYPH} end`);
    // A ZWJ family is three people joined: three boxes, no stray joiner glyphs between them.
    expect(printable("👨\u200D👩\u200D👧")).toBe(MISSING_GLYPH.repeat(3));
  });

  it("leaves an empty string empty, so a blank paragraph keeps its height", () => {
    expect(printableBlocks([{ text: "" }, ""])).toEqual([{ text: "" }, ""]);
  });

  it("uses no pdfmake block the font-run walk does not visit", () => {
    // fontRuns is applied to text, stack, ul and table bodies only; a node of another kind would
    // print its strings in the default face without the fallback. Fail loudly if one appears.
    const unwalked = ["ol", "columns", "toc", "canvas", "header", "qr", "image", "svg"];
    for (const report of [REPORT, { ...REPORT, is_stub: true }]) {
      const def = buildReportPdf(report, t) as unknown as Record<string, unknown>;
      expect(def.header).toBeUndefined();
      for (const n of nodes(def.content)) for (const k of unwalked) expect(n[k], k).toBeUndefined();
    }
  });

  it("turns a bare-string paragraph that needs Noto Sans into a paragraph of runs", () => {
    // No block is a bare string today; this keeps a future one from printing Ł as nothing.
    expect(printableBlocks(["plain", "Łukasz", ["nested Ł"], null, 3])).toEqual([
      "plain",
      { text: [{ text: "Ł", font: "NotoSans" }, "ukasz"] },
      [{ text: ["nested ", { text: "Ł", font: "NotoSans" }] }],
      null, // anything that is not text or a node passes through untouched
      3,
    ]);
  });

  it("does not set the client's SOP document name in the bold subset", () => {
    const label = nodes(buildReportPdf(REPORT, t).content).find(
      (n) => Array.isArray(n.text) && (n.text as unknown[]).includes(" · CSM SOP.pdf · p.12"),
    );
    // Our word bold; the client's document name a plain (non-bold) run beside it.
    expect(label?.bold).toBe(false);
    expect(label?.text).toEqual([{ text: "SOP source", bold: true }, " · CSM SOP.pdf · p.12"]);
  });

  it("embeds Noto Sans in the real PDF only alongside Noto Sans SC", async () => {
    const withName: Report = { ...REPORT, narrative: "Interviewed by Łukasz Dvořák" };
    const raw = (await renderPdf(buildReportPdf(withName, t))).toString("latin1");
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansSC-Regular/);
  }, 30_000);
});
