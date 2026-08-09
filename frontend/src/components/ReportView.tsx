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
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { Report, QuestionScore, ScoredItem } from "../api/client";
import { ScoreGauge } from "./ScoreGauge";

const useStyles = makeStyles({
  execRow: { display: "flex", gap: "24px", alignItems: "center", flexWrap: "wrap" },
  narrative: { flex: "1 1 260px" },
  warning: {
    marginTop: "8px",
    padding: "8px 12px",
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground1,
  },
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

/** First scored item with both a SOP quote and an answer quote — the side-by-side proof (P14). */
function firstEvidence(report: Report): ScoredItem | null {
  for (const q of report.per_question) {
    for (const it of q.items ?? []) {
      if (it.source_quote && it.answer_quote) return it;
    }
  }
  return null;
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
        <ScoreGauge score={score} grade={grade} />
        <div className={styles.narrative}>
          <Title3 as="h2">{t("report.title")}</Title3>
          {report.narrative && (
            <Body1 style={{ display: "block", marginTop: 8 }}>{report.narrative}</Body1>
          )}
          {(report.warnings ?? []).map((w, i) => (
            <div key={i} className={styles.warning} data-testid="report-warning">
              {w}
            </div>
          ))}
        </div>
      </div>

      {/* SOP-vs-answer side-by-side — the proof RAG is real (P14). */}
      {evidence && (
        <div className={styles.sideBySide} data-testid="report-evidence">
          <div className={styles.quoteCard}>
            <Text size={200} weight="semibold" className={styles.quoteLabel}>
              {t("report.sopSource")}
              {evidence.source_page ? ` · ${evidence.source_page}` : ""}
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
                {t("report.questionN", { n: qi + 1 })} — {q.grade ?? ""} ({Math.round(q.score ?? 0)}
                /100)
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
                        {t("report.sopSource")}
                        {it.source_page ? ` · ${it.source_page}` : ""}: "{it.source_quote}"
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
