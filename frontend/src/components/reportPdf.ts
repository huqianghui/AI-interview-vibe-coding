/**
 * The interview report as a downloadable PDF, built in the browser from the report already on
 * screen.
 *
 * Why in the browser: the backend does not store a report. Every report request re-runs the model
 * grading, so a server-side PDF would cost a full re-score per download and could disagree with
 * the page the candidate just read. Building it from the `Report` object the page holds makes the
 * PDF exactly what was shown, with no new route and no new access rule.
 *
 * Two parts, so the content can be tested without rendering a PDF: `buildReportPdf` is a pure
 * function from a report to a pdfmake document definition, and `downloadReportPdf` lazy-loads
 * pdfmake (about 1 MB) and the CJK font only when the candidate clicks.
 *
 * Fonts are Noto Sans SC, self-hosted (candidates may sit in mainland China, where a font CDN is
 * unreachable; see public/fonts/README.md). Everything that is not our own copy (answers, SOP
 * quotes, rationales, question prompts) is set in the complete Regular face, because a PDF cannot
 * fall back to another font and a missing glyph silently drops the character; a character even that
 * face lacks (an emoji, a rare CJK extension) prints as a visible □ instead. Bold is a GB2312 subset
 * used only for our own labels, which a test checks glyph by glyph.
 */
import type { TFunction } from "i18next";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import type { QuestionScore, Report, ScoredItem } from "../api/client";
import { palette } from "../theme";
import { REGULAR_FACE_RUNS } from "./pdfGlyphs";
import { splitWarnings, unscoredCount } from "./reportModel";

const FONT = "NotoSansSC";
const FONT_FILES = {
  normal: "/fonts/noto-sans-sc-regular.otf",
  bold: "/fonts/noto-sans-sc-bold-gb2312.otf",
};

/** How long the first download may take (library + fonts over a slow network) before the button
 *  says it failed, instead of staying on "Preparing PDF…" for ever. */
export const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Printed in place of a character the regular face cannot draw. The face has this glyph. */
export const MISSING_GLYPH = "\u25A1";

function regularFaceHas(codePoint: number): boolean {
  let lo = 0;
  let hi = REGULAR_FACE_RUNS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last] = REGULAR_FACE_RUNS[mid];
    if (codePoint < first) hi = mid - 1;
    else if (codePoint > last) lo = mid + 1;
    else return true;
  }
  return false;
}

/** `text` with every character the regular face cannot draw replaced by □ (line breaks and tabs are
 *  layout, not glyphs, and pass through). A visible box is wrong; a silently missing character in a
 *  candidate's record is worse. */
export function printable(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    out += cp === 0x0a || cp === 0x09 || cp === 0x0d || regularFaceHas(cp) ? ch : MISSING_GLYPH;
  }
  return out;
}

/** Apply `printable` to every string a document definition will print, in place. */
function makePrintable(node: unknown): unknown {
  if (typeof node === "string") return printable(node);
  if (Array.isArray(node)) return node.map(makePrintable);
  if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    for (const key of ["text", "stack", "ul", "body"]) {
      if (key in n) n[key] = makePrintable(n[key]);
    }
    if (n.table && typeof n.table === "object") makePrintable(n.table);
  }
  return node;
}

// The page's own colours (theme.ts), so a capped or critical result reads the same on paper.
const WARN = palette.warn;
const DANGER = palette.danger;
const MUTED = palette.textMuted;

function questionVerdict(q: QuestionScore, t: TFunction): string {
  if (typeof q.score !== "number") return t("report.notScored");
  const verdict = q.outcome ? t(`report.outcome.${q.outcome}`) : (q.grade ?? "");
  // A word, not the page's ⚑: Noto Sans SC has no glyph for it, and a PDF cannot fall back to
  // another font the way the browser does, so the flag would print as nothing.
  const capped = q.capped ? ` · ${t("report.cappedShort")}` : "";
  return `${verdict ? `${verdict} · ` : ""}${Math.round(q.score)}/100${capped}`;
}

function sourceLabel(item: ScoredItem, t: TFunction): string {
  const doc = item.source_document_name ? ` · ${item.source_document_name}` : "";
  const page = item.source_page ? ` · ${item.source_page}` : "";
  return `${t("report.sopSource")}${doc}${page}`;
}

/** A tinted panel with a small label over a quoted passage: the SOP source, or the candidate's words. */
function quoteBox(label: string, labelColor: string, fill: string, quote: string): Content {
  return {
    table: {
      widths: ["*"],
      body: [
        [
          {
            stack: [
              { text: label, fontSize: 8, color: labelColor, bold: true },
              { text: `“${quote}”`, margin: [0, 2, 0, 0] },
            ],
            fillColor: fill,
            margin: [8, 5, 8, 5],
          },
        ],
      ],
    },
    layout: "noBorders",
    margin: [0, 4, 0, 0],
  };
}

function itemBlock(item: ScoredItem, t: TFunction): Content {
  const kind = t(`report.itemKind.${item.kind}`, { defaultValue: item.kind });
  const block: Content[] = [
    {
      text: [
        { text: t(`report.judgment.${item.judgment}`), bold: true },
        { text: `   ${kind} · ${t("report.weight")} ${item.weight}`, color: MUTED },
      ],
      fontSize: 9,
    },
  ];
  if (item.rationale) block.push({ text: item.rationale, margin: [0, 3, 0, 0] });
  if (item.source_quote) {
    block.push(quoteBox(sourceLabel(item, t), palette.action, palette.actionTint, item.source_quote));
  }
  if (item.answer_quote) {
    block.push(quoteBox(t("report.candidateAnswer"), MUTED, palette.inset, item.answer_quote));
  }
  // NOT unbreakable: pdfmake silently drops an unbreakable block taller than a page, and one long
  // answer is enough to make an item that tall (reproduced: a 10,000-character answer vanished
  // from the PDF with no error). Long quotes break across pages instead.
  return { stack: block, margin: [0, 6, 0, 6] };
}

function questionBlock(q: QuestionScore, index: number, t: TFunction): Content {
  const ordinal = t("report.questionN", { n: index + 1 });
  const body: Content[] = [
    // The ordinal is an eyebrow only when the heading carries the question text; without a prompt
    // (an older report) the heading IS the ordinal, as on the page.
    ...(q.prompt ? [{ text: ordinal, fontSize: 9, color: palette.action, bold: true }] : []),
    // Regular face, not bold: the prompt is client-authored and may carry characters outside the
    // bold face's GB2312 subset, which a PDF would print as nothing.
    { text: q.prompt || ordinal, style: "question" },
    { text: questionVerdict(q, t), color: MUTED, margin: [0, 2, 0, 4] },
  ];
  if (q.scoring_failed) {
    body.push({ text: t("report.notScoredNote"), color: MUTED });
  } else if (q.is_stub) {
    body.push({ text: t("stubNote"), color: MUTED });
  }
  for (const item of q.items ?? []) body.push(itemBlock(item, t));
  return { stack: body, margin: [0, 10, 0, 4] };
}

/** The stub report (no rubric authored): the page shows a plain list, so the PDF does too. */
function stubContent(report: Report, t: TFunction): Content[] {
  return [
    { text: `${t("coverage")}: ${report.coverage_pct}%`, margin: [0, 0, 0, 8] },
    {
      ul: report.per_question.map((q) => ({
        text: [{ text: q.question_id, bold: true }, `: ${q.judgment ?? ""} — ${q.rationale ?? ""}`],
      })),
    },
    { text: t("stubNote"), color: MUTED, margin: [0, 8, 0, 0] },
  ];
}

function summaryContent(report: Report, t: TFunction): Content[] {
  const out: Content[] = [];
  const headline = report.outcome ? t(`report.outcome.${report.outcome}`) : t("report.title");
  out.push({ text: headline, style: "headline" });
  out.push({
    text: [
      { text: `${Math.round(report.total_score ?? 0)}/100`, bold: true },
      // Same fallback as the page's score gauge, so paper and screen show the same grade.
      `  ·  ${report.grade ?? "F"}`,
      `  ·  ${t("coverage")} ${report.coverage_pct}%`,
      `  ·  ${t("report.questionsScored", { count: report.per_question.length })}`,
    ],
    margin: [0, 2, 0, 6],
  });
  if (report.narrative) out.push({ text: report.narrative, margin: [0, 0, 0, 6] });
  if (report.capped) out.push({ text: t("report.cappedNote"), color: WARN, margin: [0, 0, 0, 4] });

  const { critical, disclosures } = splitWarnings(report);
  for (const w of critical) out.push({ text: w, color: DANGER, margin: [0, 0, 0, 4] });
  if (disclosures.length > 0) {
    out.push({
      text: [{ text: `${t("report.disclosure")}: `, bold: true }, t("report.disclosureNote")],
      color: MUTED,
      margin: [0, 0, 0, 4],
    });
  }
  const unscored = unscoredCount(report);
  if (unscored > 0) {
    out.push({ text: t("report.unscoredBanner", { count: unscored }), color: MUTED });
  }
  return out;
}

function coverageContent(report: Report, t: TFunction): Content[] {
  const groups = report.sop_coverage ?? [];
  if (groups.length === 0) return [];
  const out: Content[] = [
    { text: t("report.sopCoverage.title"), style: "section", pageBreak: "before" },
    { text: t("report.sopCoverage.hint"), color: MUTED, margin: [0, 0, 0, 6] },
  ];
  for (const group of groups) {
    const n = report.per_question.findIndex((q) => q.question_id === group.question_id) + 1;
    // Client-authored text, so the full-CJK regular face (see questionBlock); ink marks it instead.
    out.push({
      text: group.question_text || t("report.questionN", { n }),
      color: palette.ink,
      margin: [0, 6, 0, 2],
    });
    for (const m of group.missing) {
      out.push({
        stack: [
          { text: m.point },
          ...(m.sop_evidence
            ? [{ text: `${t("report.sopSource")}: “${m.sop_evidence}”`, color: MUTED, fontSize: 9 }]
            : []),
        ],
        margin: [8, 0, 0, 4],
      });
    }
  }
  return out;
}

/** When the PDF was made, in the interface language rather than the browser's locale (a Chinese
 *  report from an English-locale browser would otherwise print "06/10/2026, 9:47:15 pm"). */
export function formatGeneratedAt(at: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/** The report as a pdfmake document: summary, then every question with its scored items (all
 *  expanded — paper has no accordion), then the opt-in SOP coverage findings. `locale` is the
 *  interface language, used for the timestamp; `t` already speaks it for every label. */
export function buildReportPdf(
  report: Report,
  t: TFunction,
  { generatedAt = new Date(), locale = "en-US" }: { generatedAt?: Date; locale?: string } = {},
): TDocumentDefinitions {
  const body = report.is_stub
    ? stubContent(report, t)
    : [
        ...summaryContent(report, t),
        ...report.per_question.map((q, i) => questionBlock(q, i, t)),
        ...coverageContent(report, t),
      ];
  return {
    info: { title: t("report.title") },
    pageSize: "A4",
    pageMargins: [48, 56, 48, 56],
    defaultStyle: { font: FONT, fontSize: 10, lineHeight: 1.25 },
    styles: {
      kicker: { fontSize: 9, color: palette.action, bold: true },
      headline: { fontSize: 20, bold: true, color: palette.ink },
      section: { fontSize: 14, bold: true, color: palette.ink, margin: [0, 0, 0, 4] },
      question: { fontSize: 12, color: palette.ink },
    },
    content: makePrintable([
      { text: t("report.title"), style: "kicker" },
      { text: formatGeneratedAt(generatedAt, locale), fontSize: 8, color: MUTED, margin: [0, 0, 0, 10] },
      ...body,
    ]) as Content,
    footer: (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: "center",
      fontSize: 8,
      color: MUTED,
    }),
  };
}

/** `interview-report-YYYY-MM-DD.pdf`, in the candidate's local date. */
export function reportPdfFilename(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `interview-report-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.pdf`;
}

/** Build the PDF and hand it to the browser as a download. Loads pdfmake and the fonts on first
 *  use; the browser caches both, so a second download is immediate. */
export async function downloadReportPdf(report: Report, t: TFunction, locale: string): Promise<void> {
  const { default: pdfMake } = await import("pdfmake/build/pdfmake");
  // pdfmake fetches fonts by absolute URL; only our own font files may be fetched. The app is served
  // from the origin root (vite.config.ts sets no `base`), so /fonts/ is where nginx serves them.
  const origin = window.location.origin;
  pdfMake.setUrlAccessPolicy((u) => u.startsWith(`${origin}/fonts/`));
  pdfMake.setFonts({
    [FONT]: {
      normal: `${origin}${FONT_FILES.normal}`,
      bold: `${origin}${FONT_FILES.bold}`,
      italics: `${origin}${FONT_FILES.normal}`,
      bolditalics: `${origin}${FONT_FILES.bold}`,
    },
  });
  const now = new Date();
  const download = pdfMake
    .createPdf(buildReportPdf(report, t, { generatedAt: now, locale }))
    .download(reportPdfFilename(now));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`PDF not ready after ${PDF_DOWNLOAD_TIMEOUT_MS / 1000}s`)),
      PDF_DOWNLOAD_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([download, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
