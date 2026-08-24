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
  tokens,
} from "@fluentui/react-components";
import type { Report, QuestionScore, ScoredItem, Outcome } from "../api/client";
import { fetchSopDocument } from "../api/client";
import { ScoreGauge } from "./ScoreGauge";

const useStyles = makeStyles({
  execRow: { display: "flex", gap: "24px", alignItems: "center", flexWrap: "wrap" },
  narrative: { flex: "1 1 260px" },
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
});

const JUDGMENT_COLOR: Record<string, "success" | "warning" | "danger" | "subtle"> = {
  met: "success",
  partially_met: "warning",
  not_met: "subtle",
  violated: "danger",
};

const OUTCOME_COLOR: Record<Outcome, "success" | "warning" | "danger"> = {
  "Meets Expectations": "success",
  "Needs Improvement": "warning",
  "Does Not Meet": "danger",
};

/** The backend tags an advisory (CONFLICT-001) disclosure with this stable English prefix so it can
 * be told apart from a hard critical-error warning regardless of the display locale. */
const ADVISORY_PREFIX = "Advisory item disclosed";

/** First scored item with both a SOP quote and an answer quote — the side-by-side proof (P14). */
function firstEvidence(report: Report): ScoredItem | null {
  for (const q of report.per_question) {
    for (const it of q.items ?? []) {
      if (it.source_quote && it.answer_quote) return it;
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

  const evidence = firstEvidence(report);
  const grade = report.grade ?? "F";
  const score = report.total_score ?? 0;
  const outcome = report.outcome ?? null;

  // Separate the neutral CONFLICT-001 disclosure(s) from hard critical-error warnings so each gets
  // its own styling: a disclosure is transparency (does not cap), a warning is a failure to flag.
  const warnings = report.warnings ?? [];
  const disclosures = warnings.filter((w) => w.startsWith(ADVISORY_PREFIX));
  const criticalWarnings = warnings.filter((w) => !w.startsWith(ADVISORY_PREFIX));

  return (
    <Card>
      <CardHeader
        header={
          <Text weight="semibold" style={{ color: tokens.colorPaletteGreenForeground1 }}>
            {t("transition.reportReady")}
          </Text>
        }
      />

      {/* Executive view */}
      <div className={styles.execRow} data-testid="report-exec">
        <ScoreGauge score={score} grade={grade} outcome={outcome} />
        <div className={styles.narrative}>
          <Title3 as="h2">{t("report.title")}</Title3>
          {outcome && (
            <div className={styles.outcomeHead} data-testid="report-outcome">
              <Text size={200} className={styles.outcomeLabel}>
                {t("report.outcomeLabel")}:
              </Text>
              <Badge color={OUTCOME_COLOR[outcome]} appearance="filled" size="large">
                {t(`report.outcome.${outcome}`)}
              </Badge>
            </div>
          )}
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

      {/* SOP-vs-answer side-by-side — the proof RAG is real (P14). */}
      {evidence && (
        <div className={styles.sideBySide} data-testid="report-evidence">
          <div className={styles.quoteCard}>
            <Text size={200} weight="semibold" className={styles.quoteLabel}>
              <SopSourceLink interviewId={report.interview_session_id} item={evidence} />
            </Text>
            <Text className={styles.quote}>"{evidence.source_quote}"</Text>
          </div>
          <div className={styles.quoteCard}>
            <Text size={200} weight="semibold" className={styles.quoteLabel}>
              {t("report.candidateAnswer")}
            </Text>
            <Text className={styles.quote}>"{evidence.answer_quote}"</Text>
          </div>
        </div>
      )}

      {/* Detail view — progressively disclosed */}
      <div style={{ marginTop: 16 }}>
        <Button
          appearance="subtle"
          onClick={() => setShowDetail((v) => !v)}
          data-testid="toggle-detail"
        >
          {showDetail ? t("report.hideDetail") : t("report.showDetail")}
        </Button>
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
    </Card>
  );
}
