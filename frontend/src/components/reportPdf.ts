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
 * Fonts are self-hosted (candidates may sit in mainland China, where a font CDN is unreachable; see
 * public/fonts/README.md). A PDF cannot fall back to another font the way a browser does: a glyph
 * the font lacks silently drops the character. So every string is split into runs by face:
 *
 * - Noto Sans SC sets everything it has: all Chinese, plus Latin and punctuation. Everything that is
 *   not our own copy (answers, SOP quotes, rationales, question prompts) uses its complete Regular
 *   face. Bold is a GB2312 subset used only for our own labels, which a test checks glyph by glyph.
 * - Noto Sans (Latin, Greek, Cyrillic) sets what Noto Sans SC lacks: the Ł ř ğ ș ő of European
 *   names, Greek with accents. The EMEA interviews meet these in candidates' answers.
 * - A character neither face has (an emoji, Hangul, a rare CJK extension) prints as a visible □.
 */
import type { TFunction } from "i18next";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import type { QuestionScore, Report, ScoredItem } from "../api/client";
import { citationText } from "../api/client";
import { palette } from "../theme";
import { LATIN_FACE_RUNS, REGULAR_FACE_RUNS } from "./pdfGlyphs";
import { splitWarnings, unscoredCount } from "./reportModel";

const FONT = "NotoSansSC";
const LATIN_FONT = "NotoSans";
const FONT_FILES = {
  normal: "/fonts/noto-sans-sc-regular.otf",
  bold: "/fonts/noto-sans-sc-bold-gb2312.otf",
};
const LATIN_FONT_FILES = {
  normal: "/fonts/noto-sans-regular.ttf",
  bold: "/fonts/noto-sans-bold.ttf",
};

/** How long the first download may take (library + fonts over a slow network) before the button
 *  says it failed, instead of staying on "Preparing PDF…" for ever. */
export const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Printed in place of a character neither face can draw. Noto Sans SC has this glyph. */
export const MISSING_GLYPH = "\u25A1";

function covers(runs: ReadonlyArray<readonly [number, number]>, codePoint: number): boolean {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last] = runs[mid];
    if (codePoint < first) hi = mid - 1;
    else if (codePoint > last) lo = mid + 1;
    else return true;
  }
  return false;
}

/** A piece of text in one face: a bare string is the default face (Noto Sans SC). */
export type FontRun = string | { text: string; font: string };

/** Invisible characters that only shape an emoji (variation selectors, zero-width joiner). Neither
 *  face draws emoji, so they would each print a box of their own: "❤️" as two, a family as five. */
const EMOJI_JOINERS = /[\uFE0E\uFE0F\u200D]/g;

/**
 * `text` split into runs by the face that can draw each character: Noto Sans SC first, Noto Sans for
 * what only it has, □ for what neither has. Line breaks and tabs are layout, not glyphs, and stay
 * with the surrounding run. A run inherits everything else (bold, colour, size) from its node.
 *
 * Composed first (NFC), so a letter typed as base + combining accent ("s" + U+0326) becomes the one
 * character ("ș") a face draws whole, rather than a base in one face and a stray mark in another.
 */
export function fontRuns(text: string): FontRun[] {
  const runs: FontRun[] = [];
  let latin = false;
  let buf = "";
  const flush = () => {
    if (buf) runs.push(latin ? { text: buf, font: LATIN_FONT } : buf);
    buf = "";
  };
  for (const ch of text.normalize("NFC").replace(EMOJI_JOINERS, "")) {
    const cp = ch.codePointAt(0) as number;
    let isLatin = false;
    let out = ch;
    if (cp === 0x0a || cp === 0x09 || cp === 0x0d) isLatin = latin;
    else if (covers(REGULAR_FACE_RUNS, cp)) isLatin = false;
    else if (covers(LATIN_FACE_RUNS, cp)) isLatin = true;
    else out = MISSING_GLYPH;
    if (isLatin !== latin) {
      flush();
      latin = isLatin;
    }
    buf += out;
  }
  flush();
  return runs;
}

/** What the reader sees of `text`: every character either face can draw, □ for the rest. */
export function printable(text: string): string {
  return fontRuns(text)
    .map((r) => (typeof r === "string" ? r : r.text))
    .join("");
}

/** A string as inline text: itself when it needs only the default face (an empty string stays
 *  empty, so a blank paragraph keeps its height), else its runs. */
function inline(text: string): string | FontRun[] {
  const runs = fontRuns(text);
  if (runs.length === 0) return "";
  return runs.length === 1 && typeof runs[0] === "string" ? runs[0] : runs;
}

/**
 * One part of an inline text array, as flat styled pieces. A styled part (`{text, bold, color}`)
 * that needs two faces becomes one copy of its style PER RUN — never a nested array: pdfmake drops
 * a part's own bold and colour when its text is itself an array (reproduced: a bold red part with a
 * "Ł" in it printed plain black).
 */
function inlineParts(part: unknown): unknown[] {
  if (typeof part === "string") return fontRuns(part);
  if (!part || typeof part !== "object" || Array.isArray(part)) return [part];
  const { text, ...style } = part as Record<string, unknown>;
  const inner = typeof text === "string" ? fontRuns(text) : Array.isArray(text) ? text.flatMap(inlineParts) : [];
  return inner.map((run) =>
    typeof run === "string" ? { ...style, text: run } : { ...style, ...(run as object) },
  );
}

/** A node's own text, and every node below it, split into font runs (in place). */
function printableNode(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const n = node as Record<string, unknown>;
  if (typeof n.text === "string") n.text = inline(n.text);
  else if (Array.isArray(n.text)) n.text = n.text.flatMap(inlineParts);
  if (Array.isArray(n.stack)) n.stack = printableBlocks(n.stack);
  if (Array.isArray(n.ul)) n.ul = printableBlocks(n.ul);
  const table = n.table as { body?: unknown[] } | undefined;
  if (table && Array.isArray(table.body)) table.body = printableBlocks(table.body);
  return n;
}

/** A list of blocks (content, a stack, list items, table rows and cells). A bare string here is a
 *  paragraph, so a string that needs more than one face becomes a paragraph of runs. */
export function printableBlocks(blocks: unknown[]): unknown[] {
  return blocks.map((b) => {
    if (typeof b === "string") {
      const runs = inline(b);
      return typeof runs === "string" ? runs : { text: runs };
    }
    return Array.isArray(b) ? printableBlocks(b) : printableNode(b);
  });
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

/** "SOP source · <document> · <section> · <page>". Only our own word is bold: the document name and
 *  section title come from the client's SOP library and may hold characters outside the bold
 *  face's GB2312 subset. */
function sourceLabel(item: ScoredItem, t: TFunction): Content[] {
  const cited = item.source_sections?.length
    ? ` · ${citationText(item)}`
    : `${item.source_document_name ? ` · ${item.source_document_name}` : ""}${
        item.source_page ? ` · ${item.source_page}` : ""
      }`;
  return [{ text: t("report.sopSource"), bold: true }, ...(cited ? [cited] : [])];
}

/** A tinted panel with a small label over a quoted passage: the SOP source, or the candidate's words. */
function quoteBox(
  label: string | Content[],
  labelColor: string,
  fill: string,
  quote: string,
): Content {
  return {
    table: {
      widths: ["*"],
      body: [
        [
          {
            stack: [
              // A plain-string label is all ours and bold; a composed one marks its own bold parts.
              { text: label, fontSize: 8, color: labelColor, bold: typeof label === "string" },
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
        // Ink, not bold: the id is not our copy, and bold is a subset that covers only our labels.
        text: [{ text: q.question_id, color: palette.ink }, `: ${q.judgment ?? ""} — ${q.rationale ?? ""}`],
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
    content: printableBlocks([
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
  const face = (files: { normal: string; bold: string }) => ({
    normal: `${origin}${files.normal}`,
    bold: `${origin}${files.bold}`,
    italics: `${origin}${files.normal}`,
    bolditalics: `${origin}${files.bold}`,
  });
  pdfMake.setFonts({ [FONT]: face(FONT_FILES), [LATIN_FONT]: face(LATIN_FONT_FILES) });
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
