/**
 * Interview history (#187): a list of interviews, and one interview's detail (its saved report and
 * full transcript).
 *
 * One component for both readers: the candidate sees their own list on the start screen, the admin
 * sees each user's list in the Users tab. They differ only in where the data comes from and in two
 * admin-only abilities, so those are props: `openSop` (which route a report citation is read
 * through) and `onGenerateReport` (score a finished interview the candidate never submitted).
 */
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Body1,
  Button,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type {
  HistoryStatus,
  InterviewDetail,
  InterviewHistoryItem,
  TranscriptTurn,
} from "../api/client";
import { ReportView } from "./ReportView";
import { SopOpenerContext } from "./sopOpener";
import { formatWhen, transcriptText } from "./transcriptText";
import { fonts, palette } from "../theme";

const useStyles = makeStyles({
  // A wide table on a phone scrolls inside its own box rather than widening the page.
  scroll: { overflowX: "auto" },
  detail: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  detailHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
  facts: { color: tokens.colorNeutralForeground3 },
  noReport: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  transcript: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  turn: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  speaker: {
    fontFamily: fonts.display,
    fontWeight: 700,
    fontSize: tokens.fontSizeBase200,
    color: palette.action,
    marginRight: tokens.spacingHorizontalS,
  },
  speakerCandidate: { color: palette.magenta },
});

const STATUS_COLOR: Record<HistoryStatus, "informative" | "brand" | "success" | "warning" | "subtle"> = {
  created: "subtle",
  in_progress: "brand",
  completed: "warning",
  scored: "success",
  abandoned: "subtle",
};

export function StatusBadge({ status }: { status: HistoryStatus }) {
  const { t } = useTranslation();
  return (
    <Badge appearance="tint" color={STATUS_COLOR[status] ?? "subtle"}>
      {t(`history.status.${status}`)}
    </Badge>
  );
}

export function InterviewHistoryTable({
  items,
  onOpen,
  testId = "history-table",
}: {
  items: InterviewHistoryItem[];
  onOpen: (interviewId: string) => void;
  testId?: string;
}) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  if (items.length === 0) {
    return <Body1 data-testid={`${testId}-empty`}>{t("history.empty")}</Body1>;
  }
  return (
    <div className={styles.scroll}>
      <Table data-testid={testId} size="small">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t("history.colStarted")}</TableHeaderCell>
            <TableHeaderCell>{t("history.colCompleted")}</TableHeaderCell>
            <TableHeaderCell>{t("history.colInterviewer")}</TableHeaderCell>
            <TableHeaderCell>{t("history.colBank")}</TableHeaderCell>
            <TableHeaderCell>{t("history.colStatus")}</TableHeaderCell>
            <TableHeaderCell>{t("history.colScore")}</TableHeaderCell>
            <TableHeaderCell />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={it.id} data-testid={`history-row-${it.id}`}>
              <TableCell>{formatWhen(it.started_at, i18n.language)}</TableCell>
              <TableCell>{formatWhen(it.completed_at, i18n.language)}</TableCell>
              <TableCell>{it.persona_name ?? t("history.notRecorded")}</TableCell>
              <TableCell>{it.bank_name ?? t("history.notRecorded")}</TableCell>
              <TableCell>
                <StatusBadge status={it.status} />
              </TableCell>
              <TableCell>{it.total_score == null ? "—" : `${it.total_score}/100`}</TableCell>
              <TableCell>
                <Button size="small" onClick={() => onOpen(it.id)} data-testid={`history-open-${it.id}`}>
                  {t("history.open")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function downloadTranscript(detail: InterviewDetail, t: TFunction, locale: string): void {
  const blob = new Blob([transcriptText(detail, t, locale)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `interview-transcript-${(detail.item.started_at ?? "").slice(0, 10) || detail.item.id}.txt`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TranscriptList({ turns }: { turns: TranscriptTurn[] }) {
  const styles = useStyles();
  const { t } = useTranslation();
  if (turns.length === 0) return <Body1>{t("history.transcriptEmpty")}</Body1>;
  return (
    <ol className={styles.transcript} data-testid="history-transcript">
      {turns.map((turn) => (
        <li key={`${turn.turn_index}-${turn.created_at}`} className={styles.turn}>
          <span
            className={
              turn.role === "candidate"
                ? `${styles.speaker} ${styles.speakerCandidate}`
                : styles.speaker
            }
          >
            {t(`history.speaker.${turn.role}`)}
            {turn.turn_kind === "follow_up" ? ` · ${t("history.followUp")}` : ""}
          </span>
          <Text>{turn.content}</Text>
        </li>
      ))}
    </ol>
  );
}

export function InterviewDetailView({
  detail,
  openSop,
  onClose,
  onGenerateReport,
}: {
  detail: InterviewDetail;
  openSop: (interviewId: string, documentId: string) => Promise<string>;
  onClose: () => void;
  /** Admin only: score a finished interview that has no report yet. */
  onGenerateReport?: () => Promise<void>;
}) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const { item, report } = detail;
  const canGenerate =
    onGenerateReport !== undefined && !report && (item.status === "completed" || item.status === "scored");

  const generate = async () => {
    if (!onGenerateReport) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      await onGenerateReport();
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className={styles.detail} data-testid="history-detail">
      <div className={styles.detailHead}>
        <div>
          <Title3 as="h3">
            {item.persona_name ?? t("history.notRecorded")} · {item.bank_name ?? t("history.notRecorded")}
          </Title3>
          <Text className={styles.facts} block>
            {formatWhen(item.started_at, i18n.language)} → {formatWhen(item.completed_at, i18n.language)} ·{" "}
            <StatusBadge status={item.status} />
          </Text>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            onClick={() => downloadTranscript(detail, t, i18n.language)}
            data-testid="history-download-transcript"
          >
            {t("history.downloadTranscript")}
          </Button>
          <Button appearance="subtle" onClick={onClose} data-testid="history-close">
            {t("history.close")}
          </Button>
        </div>
      </div>

      {report ? (
        <SopOpenerContext.Provider value={openSop}>
          <ReportView report={report} />
        </SopOpenerContext.Provider>
      ) : (
        <div className={styles.noReport} data-testid="history-no-report">
          <Body1>{t("history.noReport", { status: t(`history.status.${item.status}`) })}</Body1>
          {canGenerate && (
            <Button
              appearance="primary"
              disabled={generating}
              onClick={() => void generate()}
              data-testid="history-generate-report"
            >
              {t("history.generateReport")}
            </Button>
          )}
          {generating && <Spinner size="tiny" label={t("history.generating")} />}
          {generateError && (
            <Body1 role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
              {t("history.generateError", { message: generateError })}
            </Body1>
          )}
        </div>
      )}

      <div>
        <Title3 as="h3" style={{ display: "block", marginBottom: 8 }}>
          {t("history.transcript")}
        </Title3>
        <TranscriptList turns={detail.transcript} />
      </div>
    </section>
  );
}
