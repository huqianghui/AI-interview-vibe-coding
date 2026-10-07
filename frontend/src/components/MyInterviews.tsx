/**
 * "My interviews" (#187): the signed-in candidate's own history, under the start screen.
 *
 * Hidden while it has nothing to show (first visit, or the list could not be loaded), so the start
 * screen stays the hero for a new candidate; a returning candidate sees every earlier interview, in progress and abandoned ones
 * included, and opens any of them for its report and transcript.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Body1, Card, Title3, makeStyles, tokens } from "@fluentui/react-components";
import {
  fetchMySopDocument,
  getMyInterview,
  listMyInterviews,
  type InterviewDetail,
  type InterviewHistoryItem,
} from "../api/client";
import { InterviewDetailView, InterviewHistoryTable } from "./InterviewHistory";
import { layout } from "../theme";

const useStyles = makeStyles({
  wrap: {
    maxWidth: layout.contentWidth,
    marginInline: "auto",
    paddingInline: layout.gutter,
    paddingBottom: tokens.spacingVerticalXXXL,
    boxSizing: "border-box",
    [`@media (max-width: ${layout.stackBelow})`]: { paddingInline: layout.gutterNarrow },
  },
  card: { padding: tokens.spacingVerticalXL, display: "flex", flexDirection: "column", gap: "12px" },
});

export function MyInterviews() {
  const styles = useStyles();
  const { t } = useTranslation();
  const [items, setItems] = useState<InterviewHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<InterviewDetail | null>(null);

  useEffect(() => {
    let live = true;
    // The candidate session was minted at sign-in, so this is a plain read. A failure hides the
    // block rather than putting an error on the start screen: the history is secondary there.
    listMyInterviews().then(
      (list) => {
        if (live) setItems(list);
      },
      (e: unknown) => console.warn("[history] could not load the interview list", e),
    );
    return () => {
      live = false;
    };
  }, []);

  const open = useCallback(async (interviewId: string) => {
    setError(null);
    try {
      setDetail(await getMyInterview(interviewId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (!error && (items === null || items.length === 0)) return null;

  return (
    <div className={styles.wrap} data-testid="my-interviews">
      <Card className={styles.card}>
        <Title3 as="h2">{t("history.title")}</Title3>
        {error && (
          <Body1 role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
            {t("history.loadError", { message: error })}
          </Body1>
        )}
        {detail ? (
          <InterviewDetailView
            detail={detail}
            openSop={fetchMySopDocument}
            onClose={() => setDetail(null)}
          />
        ) : (
          items && <InterviewHistoryTable items={items} onOpen={(id) => void open(id)} />
        )}
      </Card>
    </div>
  );
}
