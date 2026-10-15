/** The admin "Performance" tab (spec-admin-performance-tab): a network check from this browser, an
 * Operation id lookup with its links into Application Insights, and the workbook for numbers across
 * interviews. Every interview is one operation, whose id is the interview id without the dashes. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Link,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { formatWhenShort } from "../../components/transcriptText";
import { useAdminStyles } from "./shared";
import type { PerformanceTabState } from "./usePerformanceTab";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalL },
  body: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalM,
    padding: `0 ${tokens.spacingHorizontalL} ${tokens.spacingVerticalL}`,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  rows: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
    alignItems: "baseline",
  },
  label: { color: tokens.colorNeutralForeground2 },
  lookupRow: { display: "flex", columnGap: tokens.spacingHorizontalS, alignItems: "end" },
  input: { flexGrow: 1, maxWidth: "36em" },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  linkRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: tokens.spacingHorizontalS,
  },
});

function CopyButton({ value, testId }: { value: string; testId: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="small"
      appearance="subtle"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? t("admin.performance.copied") : t("admin.performance.copy")}
    </Button>
  );
}

export function PerformanceTab({
  state,
  onLookup,
  onOpenInterview,
}: {
  state: PerformanceTabState;
  /** Look an id up (the page also puts it into the URL). */
  onLookup: (raw: string) => void;
  /** Open the interview's result (the Interview results drawer). */
  onOpenInterview: (interviewId: string) => void;
}) {
  const styles = useAdminStyles();
  const local = useStyles();
  const { t, i18n } = useTranslation();
  const { network, result, transaction, links } = state;
  const external = { target: "_blank", rel: "noreferrer" } as const;
  // One notice for a deployment with no App Insights links at all, not one per row.
  const nothingConfigured =
    links !== null && !links.logs && !links.transaction && !links.workbook_url;
  const none = <Text className={local.hint}>—</Text>;

  return (
    <div className={local.stack} data-testid="performance-tab">
      <Card className={styles.card}>
        <CardHeader header={<Title3>{t("admin.performance.lookupTitle")}</Title3>} />
        <div className={local.body}>
          <Body1 className={local.hint}>{t("admin.performance.lookupHint")}</Body1>
          {nothingConfigured && (
            <Body1 className={local.hint} data-testid="performance-not-configured">
              {t("admin.performance.notConfigured")}
            </Body1>
          )}
          <form
            className={local.lookupRow}
            onSubmit={(e) => {
              e.preventDefault();
              onLookup(state.input);
            }}
          >
            <Field
              label={t("admin.performance.operationId")}
              className={local.input}
              validationState={state.invalid ? "error" : "none"}
              validationMessage={state.invalid ? t("admin.performance.invalid") : undefined}
            >
              <Input
                className={local.mono}
                value={state.input}
                onChange={(_, d) => state.setInput(d.value)}
                data-testid="performance-operation-input"
              />
            </Field>
            <Button
              appearance="primary"
              type="submit"
              // Not disabled while a lookup is pending: a newer one supersedes it.
              disabled={!state.input.trim()}
              data-testid="performance-lookup"
            >
              {t("admin.performance.lookup")}
            </Button>
          </form>

          {state.error && (
            <Body1 role="alert" className={styles.errorText} data-testid="performance-error">
              {t("admin.performance.lookupFailed", { message: state.error })}
            </Body1>
          )}

          {result && (
            <div className={local.rows} data-testid="performance-result">
              <Text className={local.label}>{t("admin.performance.operationId")}</Text>
              <span className={local.linkRow}>
                <Text className={local.mono} data-testid="performance-result-id">
                  {result.operation_id}
                </Text>
                <CopyButton value={result.operation_id} testId="performance-copy" />
              </span>

              <Text className={local.label}>{t("admin.performance.interview")}</Text>
              {result.interview ? (
                <span className={local.linkRow} data-testid="performance-interview">
                  <Text>
                    {[
                      result.interview.username ?? t("admin.results.anonymous"),
                      formatWhenShort(result.interview.started_at, i18n.language),
                      t(`history.status.${result.interview.status}`),
                    ].join(" · ")}
                  </Text>
                  <Link
                    as="button"
                    onClick={() => onOpenInterview(result.interview!.id)}
                    data-testid="performance-open-result"
                  >
                    {t("admin.performance.openResult")}
                  </Link>
                </span>
              ) : (
                <Text data-testid="performance-no-interview">
                  {t("admin.performance.noInterview")}
                </Text>
              )}

              <Text className={local.label}>{t("admin.performance.logs")}</Text>
              {result.logs_url ? (
                <Link href={result.logs_url} {...external} data-testid="performance-logs">
                  {t("admin.performance.openLogs")}
                </Link>
              ) : (
                none
              )}

              <Text className={local.label}>{t("admin.performance.transaction")}</Text>
              <span className={local.linkRow} data-testid="performance-transaction">
                {transaction.kind === "idle" && links?.transaction === false && none}
                {transaction.kind === "idle" && links?.transaction !== false && (
                  <Button
                    size="small"
                    onClick={() => void state.findTransaction()}
                    data-testid="performance-transaction-find"
                  >
                    {t("admin.performance.transactionFind")}
                  </Button>
                )}
                {transaction.kind === "finding" && (
                  <Text>{t("admin.performance.transactionFinding")}</Text>
                )}
                {transaction.kind === "done" && transaction.link.status === "found" && (
                  <Link
                    href={transaction.link.url ?? undefined}
                    {...external}
                    data-testid="performance-transaction-link"
                  >
                    {t("admin.performance.openTransaction")}
                  </Link>
                )}
                {transaction.kind === "done" && transaction.link.status === "not_found" && (
                  <Text className={local.hint}>{t("admin.performance.transactionNotFound")}</Text>
                )}
                {transaction.kind === "done" && transaction.link.status === "unavailable" && (
                  <Text className={local.hint}>
                    {t("admin.performance.transactionUnavailable", {
                      reason: transaction.link.reason ?? "",
                    })}
                  </Text>
                )}
                {transaction.kind === "failed" && (
                  <Text className={local.hint}>
                    {t("admin.performance.transactionUnavailable", { reason: transaction.message })}
                  </Text>
                )}
              </span>

              <Text className={local.label}>{t("admin.performance.workbook")}</Text>
              {result.workbook_url ? (
                <span className={local.linkRow}>
                  <Link href={result.workbook_url} {...external} data-testid="performance-workbook">
                    {t("admin.performance.openWorkbook")}
                  </Link>
                  <Text className={local.hint}>{t("admin.performance.workbookHint")}</Text>
                </span>
              ) : (
                none
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className={styles.card}>
        <CardHeader header={<Title3>{t("admin.performance.networkTitle")}</Title3>} />
        <div className={local.body}>
          <Body1 className={local.hint}>{t("admin.performance.networkHint")}</Body1>
          <div>
            <Button
              onClick={() => void state.runCheck()}
              disabled={state.checking}
              data-testid="performance-run-check"
            >
              {state.checking ? t("admin.performance.running") : t("admin.performance.run")}
            </Button>
          </div>
          {network && (
            <div className={local.rows} data-testid="performance-network">
              <Text className={local.label}>{t("admin.performance.apiRtt")}</Text>
              <Text data-testid="performance-api">
                {t("admin.performance.apiRttValue", { ...network.api })}
              </Text>
              <Text className={local.label}>{t("admin.performance.ws")}</Text>
              <Text data-testid="performance-ws">
                {network.ws.ok
                  ? t("admin.performance.wsOk", { ms: network.ws.ms })
                  : t("admin.performance.wsFailed", { reason: network.ws.reason })}
              </Text>
              <Text className={local.label}>{t("admin.performance.browserNet")}</Text>
              <Text data-testid="performance-browser">
                {network.browser
                  ? t("admin.performance.browserNetValue", {
                      type: network.browser.type,
                      rtt: network.browser.rtt ?? "?",
                      downlink: network.browser.downlink ?? "?",
                    })
                  : t("admin.performance.notAvailable")}
              </Text>
            </div>
          )}
        </div>
      </Card>

      <Card className={styles.card}>
        <CardHeader header={<Title3>{t("admin.performance.acrossTitle")}</Title3>} />
        <div className={local.body}>
          <Body1 className={local.hint}>{t("admin.performance.acrossHint")}</Body1>
          {links?.workbook_url && (
            <Link href={links.workbook_url} {...external} data-testid="performance-across-workbook">
              {t("admin.performance.openWorkbook")}
            </Link>
          )}
        </div>
      </Card>
    </div>
  );
}
