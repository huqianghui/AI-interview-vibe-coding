/** The admin "Jobs" tab: the background work the job process runs (scoring, SOP conversion and
 * summaries, citation runs, persona sync), newest first. A failed or cancelled job can be retried,
 * a queued or running one cancelled; the outcome of either is the one line above the table. */
import { useTranslation } from "react-i18next";
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  Select,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { JobItem, JobKind, JobSort, JobStatus } from "../../api/admin";
import { DataTable, type DataColumn } from "../../components/DataTable";
import { TablePager } from "../../components/TablePager";
import { useTableToolbarStyles } from "../../components/tableToolbar";
import { formatWhenShort } from "../../components/transcriptText";
import { useAdminStyles } from "./shared";
import { duration } from "./jobsTable";
import { DEFAULT_STATUSES, type JobsTabState } from "./useJobsTab";

const STATUSES: JobStatus[] = ["queued", "running", "failed", "succeeded", "cancelled"];
const KINDS: JobKind[] = [
  "score_interview",
  "sop_build",
  "sop_summary",
  "sop_backfill",
  "citation_run",
  "persona_sync",
];
const STATUS_COLOR: Record<JobStatus, "informative" | "brand" | "danger" | "success" | "subtle"> =
  {
    queued: "informative",
    running: "brand",
    failed: "danger",
    succeeded: "success",
    cancelled: "subtle",
  };

const useStyles = makeStyles({
  // One row: the job select, the status checkboxes and Reset, bottoms aligned (a select and a row
  // of checkboxes are the same height, so the labels line up too). Wraps only on a narrow screen.
  filterRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    columnGap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalL,
  },
  kindField: { width: "220px", maxWidth: "100%" },
  statuses: { display: "flex", flexWrap: "wrap", columnGap: tokens.spacingHorizontalS },
  statusField: { minWidth: 0 },
  checkboxBox: { borderRadius: "3px" },
  notice: { display: "block", marginBottom: tokens.spacingVerticalS },
});

export function JobsTab({ state }: { state: JobsTabState }) {
  const styles = useAdminStyles();
  const local = { ...useTableToolbarStyles(), ...useStyles() };
  const { t, i18n } = useTranslation();
  const when = (v: string | null) => formatWhenShort(v, i18n.language);
  const target = (j: JobItem) =>
    j.kind === "sop_backfill" ? t("admin.jobs.allDocuments") : j.target_label || j.target_id;
  const progress = (j: JobItem) => (j.total ? `${j.done ?? 0}/${j.total}` : "—");

  // Sorted on the server (it pages). Target and progress are worked out per row from other
  // tables and the job's progress record, so they have no column to sort by there.
  const sortOf = (key: JobSort): DataColumn<JobItem>["sort"] => ({
    direction:
      state.sort === key ? (state.order === "desc" ? "descending" : "ascending") : undefined,
    onToggle: () => state.toggleSort(key),
    testId: `jobs-sort-${key}`,
  });
  const columns: DataColumn<JobItem>[] = [
    {
      id: "kind",
      header: t("admin.jobs.kind"),
      sort: sortOf("kind"),
      text: (j) => t(`admin.jobs.kinds.${j.kind}`),
      cell: (j) => t(`admin.jobs.kinds.${j.kind}`),
    },
    { id: "target", header: t("admin.jobs.target"), text: target, cell: target, long: true },
    {
      id: "status",
      header: t("history.colStatus"),
      sort: sortOf("status"),
      text: (j) => t(`admin.jobs.status.${j.status}`),
      pad: 16,
      cell: (j) => (
        <Badge
          appearance="tint"
          color={STATUS_COLOR[j.status]}
          data-testid={`job-status-${j.job_id}`}
        >
          {j.cancel_requested && j.status === "running"
            ? t("admin.jobs.cancelling")
            : t(`admin.jobs.status.${j.status}`)}
        </Badge>
      ),
    },
    { id: "progress", header: t("admin.jobs.progress"), text: progress, cell: progress },
    {
      id: "attempts",
      header: t("admin.jobs.attempts"),
      sort: sortOf("attempts"),
      text: (j) => `${j.attempts}/${j.max_attempts}`,
      cell: (j) => `${j.attempts}/${j.max_attempts}`,
    },
    {
      id: "created",
      header: t("admin.jobs.created"),
      sort: sortOf("created_at"),
      text: (j) => when(j.created_at),
      cell: (j) => when(j.created_at),
    },
    {
      id: "duration",
      header: t("admin.jobs.duration"),
      sort: sortOf("duration"),
      text: (j) => duration(j),
      cell: (j) => duration(j),
    },
    {
      id: "by",
      header: t("admin.jobs.by"),
      sort: sortOf("created_by"),
      text: (j) => t(`admin.jobs.creators.${j.created_by}`, { defaultValue: j.created_by }),
      cell: (j) => t(`admin.jobs.creators.${j.created_by}`, { defaultValue: j.created_by }),
    },
    {
      id: "error",
      header: t("admin.jobs.error"),
      sort: sortOf("error"),
      text: (j) => j.error || "—",
      cell: (j) => j.error || "—",
      long: true,
      maxWidth: 320,
    },
    {
      id: "actions",
      header: "",
      width: 96,
      cell: (j) =>
        j.status === "failed" || j.status === "cancelled" ? (
          <Button
            size="small"
            disabled={state.busyId === j.job_id}
            onClick={() => void state.retry(j)}
            data-testid={`job-retry-${j.job_id}`}
          >
            {t("admin.jobs.retry")}
          </Button>
        ) : j.status === "queued" || j.status === "running" ? (
          <Button
            size="small"
            appearance="subtle"
            disabled={state.busyId === j.job_id || j.cancel_requested}
            onClick={() => void state.cancel(j)}
            data-testid={`job-cancel-${j.job_id}`}
          >
            {t("admin.jobs.cancel")}
          </Button>
        ) : null,
    },
  ];

  const toggleStatus = (s: JobStatus, on: boolean) =>
    state.setStatuses(on ? [...state.statuses, s] : state.statuses.filter((x) => x !== s));
  const isDefault =
    state.kind === "" &&
    state.statuses.length === DEFAULT_STATUSES.length &&
    DEFAULT_STATUSES.every((s) => state.statuses.includes(s));

  const notice = state.notice;
  const noticeText = !notice
    ? null
    : notice.kind === "failed"
      ? t("admin.jobs.actionFailed", { message: notice.message })
      : t(`admin.jobs.${notice.kind}`, {
          kind: t(`admin.jobs.kinds.${notice.job.kind}`),
          target: target(notice.job),
        });

  return (
    <Card className={styles.card} data-testid="jobs-tab">
      <CardHeader header={<Title3>{t("admin.jobs.tab")}</Title3>} />
      <div style={{ padding: "0 16px 16px" }}>
        <div className={local.filterRow} data-testid="jobs-filters">
          <Field label={t("admin.jobs.kind")} className={local.kindField}>
            <Select
              className={local.control}
              value={state.kind}
              onChange={(_, d) => state.setKind(d.value as JobKind | "")}
              data-testid="jobs-filter-kind"
            >
              <option value="">{t("admin.results.any")}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`admin.jobs.kinds.${k}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("history.colStatus")} className={local.statusField}>
            <div className={local.statuses}>
              {STATUSES.map((s) => (
                <Checkbox
                  key={s}
                  shape="square"
                  indicator={{ className: local.checkboxBox }}
                  label={t(`admin.jobs.status.${s}`)}
                  checked={state.statuses.includes(s)}
                  onChange={(_, d) => toggleStatus(s, Boolean(d.checked))}
                  data-testid={`jobs-filter-status-${s}`}
                />
              ))}
            </div>
          </Field>
          <Button
            appearance="subtle"
            disabled={isDefault}
            onClick={() => {
              state.setKind("");
              state.setStatuses(DEFAULT_STATUSES);
            }}
            data-testid="jobs-reset"
          >
            {t("admin.jobs.reset")}
          </Button>
        </div>

        {noticeText && (
          <Body1
            role={notice?.kind === "failed" ? "alert" : "status"}
            className={mergeClasses(local.notice, notice?.kind === "failed" && styles.errorText)}
            data-testid="jobs-notice"
          >
            {noticeText}
          </Body1>
        )}
        {state.error && (
          <Body1 role="alert" className={styles.errorText} data-testid="jobs-error">
            {t("history.loadError", { message: state.error })}
          </Body1>
        )}

        <DataTable
          testId="jobs-table"
          aria-busy={state.loading}
          items={state.items}
          getRowId={(j) => j.job_id}
          rowProps={(j) => ({ "data-testid": `job-row-${j.job_id}` })}
          columns={columns}
        />
        {!state.loading && state.items.length === 0 && !state.error && (
          <Body1 style={{ display: "block", padding: "16px 0" }} data-testid="jobs-empty">
            {t("admin.jobs.empty")}
          </Body1>
        )}

        <TablePager
          testId="jobs"
          loading={state.loading}
          total={state.total}
          page={state.page}
          pageSize={state.pageSize}
          onPage={state.setPage}
          onPageSize={state.setPageSize}
        />
      </div>
    </Card>
  );
}
