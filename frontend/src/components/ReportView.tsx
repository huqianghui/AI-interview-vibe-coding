/**
 * ReportView (SPEC F8 / P14) — the scored interview report, executive + detail.
 *
 * Executive view (always visible): one headline grade + score gauge, the 1-2 sentence
 * strength/gap narrative, forbidden-item warnings, and the single most demo-legible proof that the
 * RAG is real — a rubric item's SOP source quote shown SIDE BY SIDE with the candidate's own words.
 *
 * Detail view (progressively disclosed): every question's per-item judgment (4-state colour chip,
 * weight, rationale, both quotes).
 *
 * Stub reports (no checklist authored) render the pre-F4 minimal list so the page still works.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Body1,
  Card,
  CardHeader,
  Link,
  Text,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { Report, QuestionScore, ScoredItem } from "../api/client";
import { fetchSopDocument } from "../api/client";
import { ScoreGauge } from "./ScoreGauge";
import { downloadReportPdf } from "./reportPdf";
import { splitWarnings, unscoredCount } from "./reportModel";
import { fonts, palette } from "../theme";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column" },
  // Kicker on the left, the PDF download on the right, on one line.
  topRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    margin: `0 0 ${tokens.spacingVerticalM}`,
  },
  // The download button with its failure message underneath, right-aligned with it.
  pdfAction: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: tokens.spacingVerticalXS,
  },
  pdfError: { color: tokens.colorPaletteRedForeground1 },
  kicker: {
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase300,
    fontWeight: 600,
    color: palette.action,
    margin: `0 0 ${tokens.spacingVerticalM}`,
  },
  /** Executive band: its own raised surface, so the one-glance verdict is not one paragraph in a
   *  wall of card. */
  execCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalXXL,
  },
  execRow: { display: "flex", gap: tokens.spacingHorizontalXXXL, alignItems: "center", flexWrap: "wrap" },
  // Capped at a reading measure: the report moved to the wide layout, and an uncapped narrative ran
  // ~1350px per line on a 2000px screen. The gauge and the cards still use the width.
  narrative: { flex: "1 1 260px", minWidth: 0, maxWidth: "88ch" },
  outcomeDisplay: {
    fontFamily: fonts.display,
    fontWeight: 800,
    fontSize: "clamp(26px, 2.8vw, 38px)",
    lineHeight: 1.08,
    letterSpacing: "-0.028em",
    color: palette.ink,
    margin: `${tokens.spacingVerticalXS} 0 ${tokens.spacingVerticalM}`,
  },
  facts: { display: "flex", gap: tokens.spacingHorizontalS, flexWrap: "wrap", marginBottom: tokens.spacingVerticalM },
  /** One question's accordion header: ordinal eyebrow, the question itself, then its verdict.
   *  Stacked rather than one run-on line — the prompt is a full sentence, and a verdict wedged
   *  after it reads as part of the question. */
  qHead: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
    paddingBlock: tokens.spacingVerticalXS,
  },
  qOrdinal: {
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase200,
    fontWeight: 700,
    color: palette.magenta,
    letterSpacing: "0.02em",
  },
  qPrompt: {
    fontFamily: fonts.display,
    fontWeight: 700,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    letterSpacing: "-0.015em",
    color: palette.ink,
  },
  qVerdict: {
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  /** The cards inside one question's panel. */
  /**
   * The scored items, as many columns as fit at 620px each: two on a laptop's wide measure, still
   * two (wider) on a big monitor, one when the screen is narrower than two. A single column on a
   * wide screen read as one long strip (owner, 2026-10-07); three would squeeze each card's own
   * SOP | answer pair below a readable width.
   */
  itemList: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 620px), 1fr))",
    alignItems: "start",
    gap: tokens.spacingVerticalL,
    paddingBlock: tokens.spacingVerticalM,
  },
  /** A question-level note (not scored, no rubric) spans the whole row rather than one card's cell. */
  itemListNote: { gridColumn: "1 / -1" },
  itemCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalXL,
  },
  itemTop: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    marginBottom: tokens.spacingVerticalM,
  },
  itemSpacer: { flexGrow: 1 },
  itemRationale: {
    fontFamily: fonts.display,
    fontWeight: 700,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase500,
    color: palette.ink,
    margin: `0 0 ${tokens.spacingVerticalL}`,
  },
  pair: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: tokens.spacingHorizontalL,
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  /** An item can be judged with only one usable span; the lone panel takes the full width rather
   *  than sitting stranded in half of a two-column grid. */
  pairOne: { gridTemplateColumns: "1fr" },
  sopPanel: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: palette.actionTint,
    borderLeft: `3px solid ${palette.action}`,
  },
  answerPanel: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
  },
  panelLabel: {
    display: "block",
    fontFamily: fonts.display,
    fontSize: tokens.fontSizeBase200,
    fontWeight: 600,
    marginBottom: tokens.spacingVerticalXS,
  },
  sopLabel: { color: palette.action },
  answerLabel: { color: tokens.colorNeutralForeground3 },
  panelQuote: {
    display: "block",
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase500,
    color: tokens.colorNeutralForeground1,
  },
  sopQuote: { fontStyle: "italic" },
  outcomeHead: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "4px" },
  outcomeLabel: { color: tokens.colorNeutralForeground3 },
  warning: {
    marginTop: "8px",
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground1,
  },
  // Capped-to-Needs-Improvement banner: a confirmed critical error, styled as a firm (red) note.
  cappedNote: {
    marginTop: "8px",
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  // CONFLICT-001 advisory disclosure: neutral (not a failure) — transparency, no score impact.
  disclosure: {
    marginTop: "8px",
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  disclosureLabel: { fontWeight: tokens.fontWeightSemibold, marginRight: "6px" },
  sideBySide: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    marginTop: "12px",
  },
  quoteCard: {
    padding: "12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  quoteLabel: { color: tokens.colorNeutralForeground3, display: "block", marginBottom: "4px" },
  // Feature D (opt-in): the advisory "SOP points the checklist may not cover" panel. Neutral
  // styling — it is reference-only and explicitly does NOT affect the score, so it must not read as
  // a failure. Sits below the scored detail.
  coverage: {
    marginTop: "20px",
    padding: "12px 16px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  coverageHint: { color: tokens.colorNeutralForeground3, display: "block", marginBottom: "8px" },
  coverageGroup: { marginTop: "12px" },
  coverageQuestion: { display: "block", marginBottom: "4px" },
  coveragePoint: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "6px 0",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  coverageEvidence: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
});

const JUDGMENT_COLOR: Record<string, "success" | "warning" | "danger" | "subtle"> = {
  met: "success",
  partially_met: "warning",
  not_met: "subtle",
  violated: "danger",
};

/**
 * The report's SOP-source label. When the cited item carries a ``source_document_id`` we render the
 * label as a clickable link that fetches the source file (with the anon-session header) and opens it
 * in a new tab so the candidate can preview the original document; otherwise it's plain text.
 *
 * We can't use a naked ``<a href>`` because the candidate auth is a header, not a cookie — a raw
 * navigation would 401. So the click fetches bytes → blob object URL → new tab. The blob URL is
 * revoked shortly after opening (long enough for the tab to load) to avoid leaking object URLs.
 */
function SopSourceLink({
  interviewId,
  item,
  suffix,
}: {
  interviewId: string;
  item: ScoredItem;
  suffix?: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");
  const label = `${t("report.sopSource")}${item.source_page ? ` · ${item.source_page}` : ""}`;

  if (!item.source_document_id) {
    return (
      <>
        {label}
        {suffix}
      </>
    );
  }

  const docId = item.source_document_id;
  const open = async () => {
    if (state === "opening") return;
    setState("opening");
    try {
      const url = await fetchSopDocument(interviewId, docId);
      window.open(url, "_blank", "noopener,noreferrer");
      // Give the new tab time to load before releasing the object URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  return (
    <>
      <Link
        as="button"
        type="button"
        onClick={open}
        disabled={state === "opening"}
        title={item.source_document_name ?? t("report.openSource")}
        data-testid="sop-source-link"
      >
        {label}
        {state === "opening" ? ` · ${t("report.openingSource")}` : ""}
      </Link>
      {suffix}
      {state === "failed" && (
        <Text size={200} style={{ color: tokens.colorPaletteRedForeground1, marginLeft: 6 }}>
          {t("report.openSourceFailed")}
        </Text>
      )}
    </>
  );
}

/**
 * One judged checklist item, rendered as the side-by-side proof the whole report is built on: the
 * SOP sentence it was measured against beside the candidate's own words (P14).
 *
 * ONE renderer, used for every question. Until v0.45.0.0 this shape was reserved for a single
 * "evidence" question above the fold while the other eight got a plain italic-grey text list — so
 * the product's entire credibility claim landed on question 1 only, and question 1 was also the
 * only one drawn twice (once here, once in the accordion). Both oddities were the same defect:
 * two renderers for one kind of content.
 *
 * A panel is omitted when its quote is absent (an item can be judged with no usable span), and the
 * grid collapses to one column so the remaining panel is not stranded at half width.
 */
function ScoredItemCard({
  interviewId,
  item,
}: {
  interviewId: string;
  item: ScoredItem;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const both = Boolean(item.source_quote) && Boolean(item.answer_quote);
  const any = Boolean(item.source_quote) || Boolean(item.answer_quote);

  return (
    <article className={styles.itemCard} data-testid="report-item">
      <div className={styles.itemTop}>
        <Badge color={JUDGMENT_COLOR[item.judgment] ?? "subtle"} appearance="tint">
          {t(`report.judgment.${item.judgment}`)}
        </Badge>
        <Text size={200} className={styles.answerLabel}>
          {t(`report.itemKind.${item.kind}`, { defaultValue: item.kind })} ·{" "}
          {t("report.weight")} {item.weight}
        </Text>
        <span className={styles.itemSpacer} />
        <Text size={200}>
          <SopSourceLink interviewId={interviewId} item={item} />
        </Text>
      </div>
      {item.rationale && <p className={styles.itemRationale}>{item.rationale}</p>}
      {any && (
        <div className={both ? styles.pair : mergeClasses(styles.pair, styles.pairOne)}>
          {item.source_quote && (
            <div className={styles.sopPanel}>
              <span className={mergeClasses(styles.panelLabel, styles.sopLabel)}>
                {t("report.sopSource")}
              </span>
              <Text className={mergeClasses(styles.panelQuote, styles.sopQuote)}>
                &ldquo;{item.source_quote}&rdquo;
              </Text>
            </div>
          )}
          {item.answer_quote && (
            <div className={styles.answerPanel}>
              <span className={mergeClasses(styles.panelLabel, styles.answerLabel)}>
                {t("report.candidateAnswer")}
              </span>
              <Text className={styles.panelQuote}>&ldquo;{item.answer_quote}&rdquo;</Text>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Download the report on screen as a PDF (see reportPdf.ts). The first click loads the PDF library
 *  and the CJK font, so it shows its own busy state; a failure is said beside the button rather
 *  than silently doing nothing. */
function ReportPdfButton({ report }: { report: Report }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const onClick = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await downloadReportPdf(report, t, i18n.language);
    } catch (e) {
      // Said to the candidate beside the button; logged so a production failure (a font 404, a
      // timeout) can be diagnosed without reproducing it.
      console.error("Report PDF download failed", e);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.pdfAction}>
      <Button
        appearance="secondary"
        disabled={busy}
        aria-busy={busy}
        onClick={onClick}
        data-testid="report-download-pdf"
      >
        {busy ? t("report.downloadingPdf") : t("report.downloadPdf")}
      </Button>
      {failed && (
        <Text role="alert" size={200} className={styles.pdfError} data-testid="report-download-pdf-error">
          {t("report.downloadPdfFailed")}
        </Text>
      )}
    </div>
  );
}

export function ReportView({ report }: { report: Report }) {
  const styles = useStyles();
  const { t } = useTranslation();

  // Stub report (no checklist authored) → minimal list, pre-F4 shape.
  if (report.is_stub) {
    return (
      <Card>
        <CardHeader
          header={<Title3>{t("report.title")}</Title3>}
          action={<ReportPdfButton report={report} />}
        />
        <Body1 style={{ display: "block" }}>
          {t("coverage")}: {report.coverage_pct}%
        </Body1>
        <ul>
          {report.per_question.map((s) => (
            <li key={s.question_id}>
              <Text weight="semibold">{s.question_id}</Text>: {s.judgment} — {s.rationale}
            </li>
          ))}
        </ul>
        <Body1 style={{ display: "block", opacity: 0.6 }}>{t("stubNote")}</Body1>
      </Card>
    );
  }

  // The first question's section opens by default: the report's whole claim is that a judgement is
  // traceable to an SOP sentence, and a reader should see one without hunting for the control.
  const firstQuestionId = report.per_question[0]?.question_id;
  const unscored = unscoredCount(report);
  const grade = report.grade ?? "F";
  const score = report.total_score ?? 0;
  const outcome = report.outcome ?? null;

  // The neutral CONFLICT-001 disclosure(s) and the hard critical-error warnings get their own styling.
  const { critical: criticalWarnings, disclosures } = splitWarnings(report);

  return (
    <div className={styles.root} data-testid="report">
      <div className={styles.topRow}>
        <p className={styles.kicker} style={{ margin: 0 }}>
          {t("report.title")}
        </p>
        <ReportPdfButton report={report} />
      </div>

      {/* Executive band: the one-glance verdict on its own raised surface. */}
      <section className={styles.execCard}>
        <div className={styles.execRow} data-testid="report-exec">
          <ScoreGauge score={score} grade={grade} outcome={outcome} />
          <div className={styles.narrative}>
            {outcome ? (
              <div data-testid="report-outcome">
                <Text size={200} className={styles.outcomeLabel}>
                  {t("report.outcomeLabel")}
                </Text>
                {/* The rating as display type rather than a chip: it is the single thing a reader
                    takes away, and a 12px badge was not carrying that. */}
                <h2 className={styles.outcomeDisplay}>
                  {t(`report.outcome.${outcome}`)}
                </h2>
              </div>
            ) : (
              <h2 className={styles.outcomeDisplay}>{t("report.title")}</h2>
            )}
            <div className={styles.facts}>
              <Badge color="informative" appearance="tint">
                {t("coverage")} {report.coverage_pct}%
              </Badge>
              <Badge color="brand" appearance="tint">
                {t("report.questionsScored", { count: report.per_question.length })}
              </Badge>
            </div>
          {report.narrative && (
            <Body1 style={{ display: "block", marginTop: 8 }}>{report.narrative}</Body1>
          )}
          {report.capped && (
            <div className={styles.cappedNote} data-testid="report-capped">
              {t("report.cappedNote")}
            </div>
          )}
          {criticalWarnings.map((w, i) => (
            <div key={i} className={styles.warning} data-testid="report-warning">
              {w}
            </div>
          ))}
          {disclosures.map((_w, i) => (
            <div key={i} className={styles.disclosure} data-testid="report-disclosure">
              <Text className={styles.disclosureLabel}>{t("report.disclosure")}:</Text>
              {t("report.disclosureNote")}
            </div>
          ))}
          {/* "N questions could not be scored." The backend has sent `unscored_question_ids` since
              it learned to isolate a failed question, with a comment saying the report could now
              say this instead of quietly averaging fewer questions than the candidate answered —
              but no screen ever read the field, so the only trace was a silent "0/100" row. */}
          {unscored > 0 && (
            <div className={styles.disclosure} data-testid="report-unscored">
              {t("report.unscoredBanner", { count: unscored })}
            </div>
          )}
          </div>
        </div>
      </section>

      {/* Every question, one renderer: each judgement beside the SOP sentence it was measured
          against AND the candidate's own words (P14). Collapsible per question so a nine-question
          report stays navigable, with the FIRST question open so that proof is on screen without a
          click — the job the separate "evidence" block used to do by drawing question 1 twice.

          There is deliberately no "show detailed breakdown" gate any more. Its only job was to hide
          a wall of plain-text items; the items are now cards inside collapsed sections, and keeping
          the gate would have pushed the evidence below the fold, losing the one-glance proof. */}
      <Accordion
        collapsible
        multiple
        defaultOpenItems={firstQuestionId ? [firstQuestionId] : []}
        data-testid="report-detail"
      >
        {report.per_question.map((q: QuestionScore, qi) => {
          const ordinal = t("report.questionN", { n: qi + 1 });
          const verdict = q.outcome ? t(`report.outcome.${q.outcome}`) : (q.grade ?? "");
          // `Math.round(q.score ?? 0)` printed "0/100" for a question that HAS no score — one whose
          // grading failed, or a stub with no checklist. The backend excludes both from the total
          // rather than scoring them zero (P7), so showing a zero contradicted the number above it.
          const hasScore = typeof q.score === "number";
          return (
            <AccordionItem value={q.question_id} key={q.question_id}>
              <AccordionHeader>
                <span className={styles.qHead}>
                  {/* The ordinal is an eyebrow ONLY when the heading carries the question text.
                      Without a prompt (an older report) the heading IS the ordinal, and rendering
                      both would print "Question 1" twice. */}
                  {q.prompt && <span className={styles.qOrdinal}>{ordinal}</span>}
                  <span className={styles.qPrompt}>{q.prompt || ordinal}</span>
                  <span className={styles.qVerdict}>
                    {hasScore ? (
                      <>
                        {verdict ? `${verdict} · ` : ""}
                        {Math.round(q.score as number)}/100
                        {q.capped ? " ⚑" : ""}
                      </>
                    ) : (
                      t("report.notScored")
                    )}
                  </span>
                </span>
              </AccordionHeader>
              <AccordionPanel>
                <div className={styles.itemList}>
                  {/* A failed or stub question has no items, and an empty panel says nothing. The
                      note is styled as a neutral disclosure, not a warning: grading failing is the
                      system's problem, never the candidate's. */}
                  {q.scoring_failed && (
                    <div
                      className={mergeClasses(styles.disclosure, styles.itemListNote)}
                      data-testid="question-not-scored"
                    >
                      {t("report.notScoredNote")}
                    </div>
                  )}
                  {q.is_stub && !q.scoring_failed && (
                    <div className={mergeClasses(styles.disclosure, styles.itemListNote)}>
                      {t("stubNote")}
                    </div>
                  )}
                  {(q.items ?? []).map((it, ii) => (
                    <ScoredItemCard
                      key={ii}
                      interviewId={report.interview_session_id}
                      item={it}
                    />
                  ))}
                </div>
              </AccordionPanel>
            </AccordionItem>
          );
        })}
      </Accordion>

      {/* Feature D (opt-in): advisory SOP-coverage findings. Rendered only when the candidate ran
          the check AND it surfaced something. Reference-only — it never affected the score above. */}
      {report.sop_coverage && report.sop_coverage.length > 0 && (
        <div className={styles.coverage} data-testid="report-sop-coverage">
          <Title3 as="h3">{t("report.sopCoverage.title")}</Title3>
          <Text size={200} className={styles.coverageHint}>
            {t("report.sopCoverage.hint")}
          </Text>
          {report.sop_coverage.map((group, gi) => (
            <div key={group.question_id ?? gi} className={styles.coverageGroup}>
              <Text weight="semibold" className={styles.coverageQuestion}>
                {group.question_text ||
                  t("report.questionN", {
                    n:
                      report.per_question.findIndex(
                        (q) => q.question_id === group.question_id,
                      ) + 1,
                  })}
              </Text>
              {group.missing.map((m, mi) => (
                <div key={mi} className={styles.coveragePoint}>
                  <Text>{m.point}</Text>
                  {m.sop_evidence && (
                    <Text size={200} className={styles.coverageEvidence}>
                      {t("report.sopSource")}: "{m.sop_evidence}"
                    </Text>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
