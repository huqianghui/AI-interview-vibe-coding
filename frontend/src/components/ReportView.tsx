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
  Body1,
  Button,
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
import { fonts, palette } from "../theme";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column" },
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
  narrative: { flex: "1 1 260px", minWidth: 0 },
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
  /** The evidence block, given the weight the credibility claim deserves. */
  evidenceHead: {
    fontFamily: fonts.display,
    fontWeight: 700,
    fontSize: tokens.fontSizeBase500,
    letterSpacing: "-0.02em",
    color: palette.ink,
    margin: `${tokens.spacingVerticalXXL} 0 ${tokens.spacingVerticalM}`,
  },
  evidenceList: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
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
  detailRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
    marginTop: tokens.spacingVerticalXL,
  },
  detailNote: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
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
  itemRow: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  itemHead: { display: "flex", gap: "8px", alignItems: "center" },
  quote: { color: tokens.colorNeutralForeground2, fontStyle: "italic" },
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

/** The backend tags an advisory (CONFLICT-001) disclosure with this stable English prefix so it can
 * be told apart from a hard critical-error warning regardless of the display locale. */
const ADVISORY_PREFIX = "Advisory item disclosed";

/**
 * The side-by-side proof that the RAG is real (P14), now a question's worth of it rather than one
 * pair. Returns the first question that has any item carrying BOTH quotes, with those items.
 *
 * Capped at three items: this block is the executive view's evidence, and a rubric with eight
 * items would turn the headline screen into the detail screen. The rest stays behind the existing
 * "show detailed breakdown" toggle, which is unchanged.
 *
 * NOTE: `QuestionScore` carries no question TEXT — the report payload has `question_id` only — so
 * this block can label itself "Question N" and nothing more. Showing the prompt here needs a
 * backend field; filed in TODOS.md rather than faked.
 */
const EVIDENCE_ITEM_CAP = 3;

function firstEvidenceGroup(
  report: Report,
): { index: number; question: QuestionScore; items: ScoredItem[] } | null {
  for (let i = 0; i < report.per_question.length; i++) {
    const q = report.per_question[i];
    const items = (q.items ?? []).filter((it) => it.source_quote && it.answer_quote);
    if (items.length > 0) {
      return { index: i, question: q, items: items.slice(0, EVIDENCE_ITEM_CAP) };
    }
  }
  return null;
}

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

export function ReportView({ report }: { report: Report }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [showDetail, setShowDetail] = useState(false);

  // Stub report (no checklist authored) → minimal list, pre-F4 shape.
  if (report.is_stub) {
    return (
      <Card>
        <CardHeader header={<Title3>{t("report.title")}</Title3>} />
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

  const evidence = firstEvidenceGroup(report);
  const grade = report.grade ?? "F";
  const score = report.total_score ?? 0;
  const outcome = report.outcome ?? null;

  // Separate the neutral CONFLICT-001 disclosure(s) from hard critical-error warnings so each gets
  // its own styling: a disclosure is transparency (does not cap), a warning is a failure to flag.
  const warnings = report.warnings ?? [];
  const disclosures = warnings.filter((w) => w.startsWith(ADVISORY_PREFIX));
  const criticalWarnings = warnings.filter((w) => !w.startsWith(ADVISORY_PREFIX));

  return (
    <div className={styles.root}>
      <p className={styles.kicker}>{t("report.title")}</p>

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
          </div>
        </div>
      </section>

      {/* The credibility claim, given room: every judgement beside the SOP sentence it was measured
          against AND the candidate's own words (P14). This used to be a single quote pair; it is
          now the first question's worth of them, capped at three.

          The heading can only say "Question N" — `QuestionScore` carries no question text, the
          report payload has `question_id` alone. Adding the prompt needs a backend field; it is in
          TODOS.md rather than invented here. */}
      {evidence && (
        <>
          <h3 className={styles.evidenceHead}>
            {t("report.questionN", { n: evidence.index + 1 })}
          </h3>
          <div className={styles.evidenceList} data-testid="report-evidence">
            {evidence.items.map((it, ii) => (
              <article key={ii} className={styles.itemCard}>
                <div className={styles.itemTop}>
                  <Badge
                    color={JUDGMENT_COLOR[it.judgment] ?? "subtle"}
                    appearance="tint"
                  >
                    {t(`report.judgment.${it.judgment}`)}
                  </Badge>
                  <Text size={200} className={styles.answerLabel}>
                    {t("report.weight")} {it.weight}
                  </Text>
                  <span className={styles.itemSpacer} />
                  <Text size={200}>
                    <SopSourceLink
                      interviewId={report.interview_session_id}
                      item={it}
                    />
                  </Text>
                </div>
                {it.rationale && <p className={styles.itemRationale}>{it.rationale}</p>}
                <div className={styles.pair}>
                  <div className={styles.sopPanel}>
                    <span className={mergeClasses(styles.panelLabel, styles.sopLabel)}>
                      {t("report.sopSource")}
                    </span>
                    <Text className={mergeClasses(styles.panelQuote, styles.sopQuote)}>
                      &ldquo;{it.source_quote}&rdquo;
                    </Text>
                  </div>
                  <div className={styles.answerPanel}>
                    <span className={mergeClasses(styles.panelLabel, styles.answerLabel)}>
                      {t("report.candidateAnswer")}
                    </span>
                    <Text className={styles.panelQuote}>
                      &ldquo;{it.answer_quote}&rdquo;
                    </Text>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {/* Detail view — progressively disclosed, behaviour unchanged. */}
      <div className={styles.detailRow}>
        <Button
          appearance="secondary"
          onClick={() => setShowDetail((v) => !v)}
          data-testid="toggle-detail"
        >
          {showDetail ? t("report.hideDetail") : t("report.showDetail")}
        </Button>
        {!showDetail && report.per_question.length > 1 && (
          <span className={styles.detailNote}>
            {t("report.moreQuestions", { count: report.per_question.length - 1 })}
          </span>
        )}
      </div>

      {showDetail && (
        <Accordion collapsible multiple data-testid="report-detail">
          {report.per_question.map((q: QuestionScore, qi) => (
            <AccordionItem value={q.question_id} key={q.question_id}>
              <AccordionHeader>
                {t("report.questionN", { n: qi + 1 })} —{" "}
                {q.outcome ? t(`report.outcome.${q.outcome}`) : (q.grade ?? "")} (
                {Math.round(q.score ?? 0)}
                /100){q.capped ? " ⚑" : ""}
              </AccordionHeader>
              <AccordionPanel>
                {(q.items ?? []).map((it, ii) => (
                  <div key={ii} className={styles.itemRow}>
                    <div className={styles.itemHead}>
                      <Badge color={JUDGMENT_COLOR[it.judgment] ?? "subtle"} appearance="tint">
                        {t(`report.judgment.${it.judgment}`)}
                      </Badge>
                      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        {it.kind} · {t("report.weight")} {it.weight}
                      </Text>
                    </div>
                    {it.rationale && <Text>{it.rationale}</Text>}
                    {it.answer_quote && (
                      <Text size={200} className={styles.quote}>
                        {t("report.candidateAnswer")}: "{it.answer_quote}"
                      </Text>
                    )}
                    {it.source_quote && (
                      <Text size={200} className={styles.quote}>
                        <SopSourceLink
                          interviewId={report.interview_session_id}
                          item={it}
                          suffix={`: "${it.source_quote}"`}
                        />
                      </Text>
                    )}
                  </div>
                ))}
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      )}

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
