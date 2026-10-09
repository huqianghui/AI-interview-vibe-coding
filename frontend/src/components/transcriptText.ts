/** Plain-text rendering of an interview's transcript, for the "Download transcript" button (#187). */
import type { TFunction } from "i18next";
import type { InterviewDetail } from "../api/client";

export function formatWhen(iso: string | null, locale: string): string {
  return iso ? new Date(iso).toLocaleString(locale) : "—";
}

/** The same moment for a table cell: to the minute, 24-hour, so a row stays one short line. */
export function formatWhenShort(iso: string | null, locale: string): string {
  return iso
    ? new Date(iso).toLocaleString(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
}

/** The transcript as plain text: a short header, then one turn per line, `[time] Speaker: text`. */
export function transcriptText(detail: InterviewDetail, t: TFunction, locale: string): string {
  const head = [
    `${t("history.colStarted")}: ${formatWhen(detail.item.started_at, locale)}`,
    `${t("history.colInterviewer")}: ${detail.item.persona_name ?? t("history.notRecorded")}`,
    `${t("history.colBank")}: ${detail.item.bank_name ?? t("history.notRecorded")}`,
    `${t("history.colStatus")}: ${t(`history.status.${detail.item.status}`)}`,
    "",
  ];
  const lines = detail.transcript.map((turn) => {
    const kind = turn.turn_kind === "follow_up" ? ` (${t("history.followUp")})` : "";
    return `[${formatWhen(turn.created_at, locale)}] ${t(`history.speaker.${turn.role}`)}${kind}: ${turn.content}`;
  });
  return [...head, ...lines].join("\n") + "\n";
}
