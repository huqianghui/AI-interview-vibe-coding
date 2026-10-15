/** The admin "Performance" tab (spec-admin-performance-tab): an Operation id lookup with the
 * network that interview ran on (graded A to D, docs/network-grades.md) and its links into
 * Application Insights; a live network check from this browser; and the workbook. Every interview
 * is one operation, whose id is the interview id without the dashes. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
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
import type { CurrentConfig, InterviewNetwork } from "../../api/admin";
import { formatWhenShort } from "../../components/transcriptText";
import { adviseConfig } from "./gradeAdvice";
import type { Grade, GradeReason, GradeResult } from "./networkGrade";
import { formatRate, percentile } from "./performanceProbe";
import { RttChart } from "./RttChart";
import { useAdminStyles } from "./shared";
import {
  LIVE_CHECK,
  interviewGrade,
  isVideoAvatar,
  liveGrade,
  okRtts,
  type PerformanceTabState,
} from "./usePerformanceTab";

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
  grade: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalXS },
  // The grade on the left, the A-to-D legend on the right; stacked when narrow.
  gradeLayout: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: tokens.spacingHorizontalXXL,
    rowGap: tokens.spacingVerticalM,
    alignItems: "flex-start",
  },
  gradeMain: { flex: "1 1 360px", minWidth: 0 },
  legend: {
    flex: "0 1 340px",
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
  },
  legendRow: { color: tokens.colorNeutralForeground3 },
  legendCurrent: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
  advice: { margin: 0, paddingLeft: tokens.spacingHorizontalL },
  topLine: { color: tokens.colorNeutralForeground3 },
  ops: { margin: 0, paddingLeft: tokens.spacingHorizontalL },
});

// A grade is a state, so it wears a status colour, always with its letter as the label.
const GRADE_COLOR: Record<Grade, "success" | "warning" | "danger"> = {
  A: "success",
  B: "success",
  C: "warning",
  D: "danger",
};

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

const GRADES: Grade[] = ["A", "B", "C", "D"];

/** The four grades in one line each, the current one highlighted. */
function GradeLegend({ current }: { current: Grade | null }) {
  const local = useStyles();
  const { t } = useTranslation();
  return (
    <div className={local.legend} data-testid="performance-grade-legend">
      <Text weight="semibold" style={{ gridColumn: "1 / -1" }}>
        {t("admin.performance.legendTitle")}
      </Text>
      {GRADES.map((g) => (
        <span key={g} style={{ display: "contents" }}>
          <Badge
            appearance={g === current ? "filled" : "tint"}
            color={GRADE_COLOR[g]}
            size="small"
            data-testid={g === current ? "performance-legend-current" : undefined}
          >
            {g}
          </Badge>
          <Text className={g === current ? local.legendCurrent : local.legendRow}>
            {t(`admin.performance.legend.${g}`)}
          </Text>
        </span>
      ))}
    </div>
  );
}

type T = (key: string, o?: Record<string, unknown>) => string;

function reasonText(t: T, r: GradeReason): string {
  if (r.metric === "udp") return t("admin.performance.reason.udp");
  const raw = r.value ?? 0;
  // One more decimal where rounding would print the limit itself ("RTT 150 ms > 150 ms").
  const digits = r.metric === "loss" ? 1 : 0;
  const atLimit = raw.toFixed(digits) === (r.limit ?? 0).toFixed(digits);
  const shown = raw.toFixed(atLimit ? digits + 1 : digits);
  const value = r.metric === "down" ? formatRate(raw) : shown;
  const limit = r.metric === "down" ? formatRate(r.limit ?? 0) : r.limit;
  // C's own triggers read "≥ limit"; the others read against the better grade's limit.
  const key = r.row === "C" ? `${r.metric}C` : r.metric;
  return t(`admin.performance.reason.${key}`, { value, limit, row: r.row });
}

/** A grade: why, the starting form it recommends, what to change compared with the current
 * settings (and with whose), when it updates, and the four grades beside it. */
function GradeView({
  result,
  notes,
  config,
  cadence,
  testId,
}: {
  result: GradeResult | null;
  notes: string[];
  config: CurrentConfig | null;
  cadence: string;
  testId: string;
}) {
  const local = useStyles();
  const { t } = useTranslation();
  if (!result) {
    return (
      <span className={local.gradeLayout}>
        <span className={local.gradeMain}>
          <Text className={local.hint} data-testid={testId}>
            {t("admin.performance.gradeNone")}
          </Text>
        </span>
        <GradeLegend current={null} />
      </span>
    );
  }
  const all = [
    ...(result.downlinkOnly && result.withoutDownlink
      ? [t("admin.performance.noteDownlinkOnly", { grade: result.withoutDownlink })]
      : []),
    ...(result.estimated ? [t("admin.performance.noteEstimated")] : []),
    ...(result.boundary ? [t("admin.performance.noteBoundary")] : []),
    ...notes,
  ];
  // A D from the browser's downlink alone (a reading that underestimates distant links) advises
  // from what the other numbers give, so a slow probe never demands voice-only.
  const fromRest = result.downlinkOnly && result.withoutDownlink !== undefined;
  const adviceGrade = fromRest ? (result.withoutDownlink as Grade) : result.grade;
  const autoBitrate = fromRest ? Boolean(result.withoutDownlinkAutoBitrate) : result.autoBitrate;
  const advice = config ? adviseConfig(adviceGrade, config, { autoBitrate }) : [];
  return (
    <span className={local.gradeLayout}>
      <span className={`${local.grade} ${local.gradeMain}`} data-testid={testId}>
        <span className={local.linkRow}>
          <Badge
            appearance="tint"
            color={GRADE_COLOR[result.grade]}
            data-testid={`${testId}-badge`}
          >
            {t("admin.performance.gradeLabel", { grade: result.grade })}
          </Badge>
          <Text>{t(`admin.performance.rec.${result.grade}`)}</Text>
        </span>
        {result.reasons.length > 0 && (
          <Text data-testid={`${testId}-why`}>
            {t("admin.performance.why", {
              grade: result.grade,
              reasons: result.reasons.map((r) => reasonText(t, r)).join(" · "),
            })}
          </Text>
        )}
        {all.map((note) => (
          <Text key={note} className={local.hint}>
            {note}
          </Text>
        ))}
        {config && (
          <span className={local.grade} data-testid={`${testId}-advice`}>
            <Text weight="semibold">
              {config.interviewer
                ? t(`admin.performance.compare.${config.source}`, { name: config.interviewer.name })
                : t("admin.performance.advice.noInterviewer")}
            </Text>
            {config.interviewer && (
              <ul className={local.advice}>
                {advice.length === 0 ? (
                  <li>
                    <Text>{t("admin.performance.advice.matches")}</Text>
                  </li>
                ) : (
                  advice.map((a) => (
                    <li key={a.key}>
                      <Text weight={a.change ? "semibold" : "regular"}>
                        {t(`admin.performance.advice.${a.key}`, a.params)}
                      </Text>
                    </li>
                  ))
                )}
              </ul>
            )}
            <Text className={local.hint}>
              {t("admin.performance.compareSettings", {
                bitrate:
                  config.avatar_video_bitrate === null
                    ? t("admin.performance.bitrateUnset")
                    : formatRate(config.avatar_video_bitrate / 1000),
                rate: config.input_sampling_rate,
              })}
            </Text>
          </span>
        )}
        <Text className={local.hint}>{cadence}</Text>
      </span>
      <GradeLegend current={result.grade} />
    </span>
  );
}

function fmt(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined ? "—" : v.toFixed(digits);
}

/** What the interview's own telemetry says about its network. */
function InterviewNetworkView({
  network,
  config,
}: {
  network: InterviewNetwork;
  config: CurrentConfig | null;
}) {
  const local = useStyles();
  const { t } = useTranslation();
  const media = network.media;
  const notes: string[] = [];
  if (media && media.samples > 0 && !isVideoAvatar(media.resolution)) {
    notes.push(t("admin.performance.noteDownNotGraded"));
  }
  if (network.avatar && network.avatar.via_relay > 0) notes.push(t("admin.performance.noteRelay"));
  return (
    <span className={local.grade} data-testid="performance-interview-network">
      {media && media.samples > 0 ? (
        <Text data-testid="performance-interview-metrics">
          {t("admin.performance.networkMetrics", {
            rtt: fmt(media.rtt_p95_ms),
            loss: fmt(media.audio_loss_pct, 1),
            down: fmt(media.available_in_p50_kbps),
            samples: media.samples,
            avatar: isVideoAvatar(media.resolution)
              ? t("admin.performance.avatarVideo")
              : t("admin.performance.avatarPhoto"),
          })}
        </Text>
      ) : (
        <Text className={local.hint}>{t("admin.performance.noMedia")}</Text>
      )}
      <GradeView
        result={interviewGrade(network)}
        notes={notes}
        config={config}
        cadence={t("admin.performance.interviewCadence")}
        testId="performance-interview-grade"
      />
    </span>
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
  const { live, result, transaction, links, interviewNetwork } = state;
  const external = { target: "_blank", rel: "noreferrer" } as const;
  // One notice for a deployment with no App Insights links at all, not one per row.
  const nothingConfigured =
    links !== null && !links.logs && !links.transaction && !links.workbook_url;
  const none = <Text className={local.hint}>—</Text>;
  const legacy =
    interviewNetwork.kind === "done" && interviewNetwork.network.legacy
      ? (interviewNetwork.network.operations ?? [])
      : null;
  const rtts = okRtts(live.rtt);
  const lastRtt = live.rtt.length ? live.rtt[live.rtt.length - 1].ms : null;
  const net = interviewNetwork.kind === "done" ? interviewNetwork.network : null;

  return (
    <div className={local.stack} data-testid="performance-tab">
      {links?.workbook_url && (
        <Text className={local.topLine} data-testid="performance-workbook-across">
          <Link href={links.workbook_url} {...external}>
            {t("admin.performance.workbookTop")}
          </Link>
        </Text>
      )}
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

              <Text className={local.label}>{t("admin.performance.interviewNetwork")}</Text>
              <span data-testid="performance-network-state">
                {interviewNetwork.kind === "loading" && (
                  <Text className={local.hint}>{t("admin.performance.networkLoading")}</Text>
                )}
                {net?.status === "found" && (
                  <InterviewNetworkView network={net} config={state.interviewConfig} />
                )}
                {net?.status === "not_found" && (
                  <Text className={local.hint}>{t("admin.performance.networkNotFound")}</Text>
                )}
                {net?.status === "unavailable" && (
                  <Text className={local.hint}>
                    {t("admin.performance.networkUnavailable", { reason: net.reason ?? "" })}
                  </Text>
                )}
                {interviewNetwork.kind === "failed" && (
                  <Text className={local.hint}>
                    {t("admin.performance.networkUnavailable", {
                      reason: interviewNetwork.message,
                    })}
                  </Text>
                )}
              </span>

              <Text className={local.label}>{t("admin.performance.logs")}</Text>
              {legacy ? (
                <span className={local.grade} data-testid="performance-legacy">
                  <Text className={local.hint}>
                    {t("admin.performance.legacyNote", { count: legacy.length })}
                  </Text>
                  <ul className={local.ops}>
                    {legacy.map((op) => (
                      <li key={op.operation_id}>
                        <span className={local.linkRow}>
                          <Text className={local.mono}>{op.operation_id}</Text>
                          {op.seen && (
                            <Text className={local.hint}>
                              {formatWhenShort(op.seen, i18n.language)}
                            </Text>
                          )}
                          {op.logs_url && (
                            <Link href={op.logs_url} {...external}>
                              {t("admin.performance.openLogs")}
                            </Link>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </span>
              ) : result.logs_url ? (
                <Link href={result.logs_url} {...external} data-testid="performance-logs">
                  {t("admin.performance.openLogs")}
                </Link>
              ) : (
                none
              )}

              {result.workbook_url && (
                <>
                  <Text className={local.label}>{t("admin.performance.workbookRow")}</Text>
                  <span className={local.linkRow}>
                    <Link
                      href={result.workbook_url}
                      {...external}
                      data-testid="performance-workbook"
                    >
                      {t("admin.performance.openWorkbook")}
                    </Link>
                    <Text className={local.hint}>{t("admin.performance.workbookRowHint")}</Text>
                  </span>
                </>
              )}

              {!legacy && (
                <>
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
                      <Text className={local.hint}>
                        {t("admin.performance.transactionNotFound")}
                      </Text>
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
                        {t("admin.performance.transactionUnavailable", {
                          reason: transaction.message,
                        })}
                      </Text>
                    )}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className={styles.card}>
        <CardHeader header={<Title3>{t("admin.performance.networkTitle")}</Title3>} />
        <div className={local.body}>
          <Body1 className={local.hint}>{t("admin.performance.networkHint")}</Body1>
          <Text className={local.hint} data-testid="performance-live-state">
            {state.running ? t("admin.performance.live") : t("admin.performance.paused")}
          </Text>
          <Text className={local.label}>{t("admin.performance.rttChart")}</Text>
          <RttChart samples={live.rtt} capacity={LIVE_CHECK.samples} />
          <div className={local.rows} data-testid="performance-network">
            <Text className={local.label}>{t("admin.performance.apiRtt")}</Text>
            <Text data-testid="performance-api">
              {rtts.length
                ? t("admin.performance.rttNow", {
                    now: lastRtt === null ? "—" : Math.round(lastRtt),
                    median: Math.round(percentile(rtts, 50)),
                    p95: Math.round(percentile(rtts, 95)),
                    failed: live.rtt.length - rtts.length,
                  })
                : t("admin.performance.rttWaiting")}
            </Text>
            <Text className={local.label}>{t("admin.performance.ws")}</Text>
            <Text data-testid="performance-ws">
              {live.ws === null
                ? t("admin.performance.rttWaiting")
                : live.ws.ok
                  ? t("admin.performance.wsOk", { ms: live.ws.ms })
                  : t("admin.performance.wsFailed", { reason: live.ws.reason })}
            </Text>
            <Text className={local.label}>{t("admin.performance.stun")}</Text>
            <Text data-testid="performance-stun">
              {live.stun === null
                ? t("admin.performance.rttWaiting")
                : live.stun.ok
                  ? t("admin.performance.stunOk", { ms: live.stun.ms })
                  : t("admin.performance.stunFailed", { reason: live.stun.reason })}
            </Text>
            <Text className={local.label}>{t("admin.performance.downlink")}</Text>
            <Text data-testid="performance-downlink">
              {live.downKbps === null
                ? t("admin.performance.rttWaiting")
                : t("admin.performance.downlinkValue", { value: formatRate(live.downKbps) })}
            </Text>
            <Text className={local.label}>{t("admin.performance.browserNet")}</Text>
            <Text data-testid="performance-browser">
              {live.browser
                ? t("admin.performance.browserNetValue", {
                    type: live.browser.type,
                    rtt: live.browser.rtt ?? "?",
                    downlink: live.browser.downlink ?? "?",
                  })
                : t("admin.performance.notAvailable")}
            </Text>
            <Text className={local.label}>{t("admin.performance.gradeLive")}</Text>
            <GradeView
              result={liveGrade(live)}
              notes={[]}
              config={state.defaultConfig}
              cadence={t("admin.performance.liveCadence")}
              testId="performance-live-grade"
            />
          </div>
          <Text className={local.hint}>{t("admin.performance.gradesDoc")}</Text>
        </div>
      </Card>
    </div>
  );
}
