/** The admin "Interview results" tab: every candidate's interviews in one table, filterable on
 * every dimension, sortable, paged on the server; a row opens the interview in a side drawer. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Checkbox,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  OverlayDrawer,
  Select,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { fetchInterviewSopDocument } from "../../api/admin";
import type { HistoryStatus } from "../../api/client";
import { InterviewDetailView, StatusBadge } from "../../components/InterviewHistory";
import { InterviewRecordings } from "./InterviewRecordings";
import { DataTable, type DataColumn } from "../../components/DataTable";
import type { InterviewResultItem } from "../../api/admin";
import { formatWhenShort } from "../../components/transcriptText";
import { useAdminStyles } from "./shared";
import { TablePager } from "../../components/TablePager";
import { useTableToolbarStyles } from "../../components/tableToolbar";
import type { InterviewsTabState, SortKey } from "./useInterviewsTab";

const STATUSES: HistoryStatus[] = ["in_progress", "completed", "scored", "abandoned", "created"];
const OUTCOMES = ["Meets Expectations", "Needs Improvement", "Does Not Meet"] as const;

const useStyles = makeStyles({
  statuses: { display: "flex", flexWrap: "wrap", columnGap: tokens.spacingHorizontalS },
  statusField: { gridColumn: "span 2" },
  scroll: { overflowX: "auto" },
  row: { cursor: "pointer" },
  // The app theme's 8px small radius turns a 16px checkbox into a circle, which reads as a radio
  // ("pick one"); these are multi-select, so they keep a square-ish box.
  checkboxBox: { borderRadius: "3px" },
});

/** A score bound typed as text: applied when the field is left or Enter is pressed, so typing
 * "75" does not query for 7 first. */
function ScoreInput({
  label,
  value,
  onCommit,
  testId,
}: {
  label: string;
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  testId: string;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    const n = text.trim() === "" ? undefined : Number(text);
    if (n === undefined || (Number.isFinite(n) && n >= 0 && n <= 100)) onCommit(n);
    else setText(value === undefined ? "" : String(value)); // out of range: put the old value back
  };
  return (
    <Field label={label} style={{ minWidth: 0 }}>
      <Input
        style={{ minWidth: 0, width: "100%" }}
        type="number"
        min={0}
        max={100}
        value={text}
        onChange={(_, d) => setText(d.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        data-testid={testId}
      />
    </Field>
  );
}

function sortOf(state: InterviewsTabState, column: SortKey): DataColumn<unknown>["sort"] {
  return {
    direction:
      state.sort === column ? (state.order === "desc" ? "descending" : "ascending") : undefined,
    onToggle: () => state.toggleSort(column),
    testId: `results-sort-${column}`,
  };
}

export function InterviewsTab({ state }: { state: InterviewsTabState }) {
  const styles = useAdminStyles();
  const local = { ...useTableToolbarStyles(), ...useStyles() };
  const { t, i18n } = useTranslation();
  const { filters } = state;
  const candidates = state.users.filter((u) => u.role === "user");
  const hasFilters = Object.keys(filters).length > 0;
  const when = (v: string | null) => formatWhenShort(v, i18n.language);
  const columns: DataColumn<InterviewResultItem>[] = [
    {
      id: "candidate",
      header: t("admin.results.candidate"),
      text: (it) => it.username ?? t("admin.results.anonymous"),
      cell: (it) => it.username ?? t("admin.results.anonymous"),
    },
    {
      id: "started",
      header: t("history.colStarted"),
      sort: sortOf(state, "started_at"),
      text: (it) => when(it.started_at),
      cell: (it) => when(it.started_at),
    },
    {
      id: "completed",
      header: t("history.colCompleted"),
      text: (it) => when(it.completed_at),
      cell: (it) => when(it.completed_at),
    },
    {
      id: "interviewer",
      header: t("history.colInterviewer"),
      text: (it) => it.persona_name ?? t("history.notRecorded"),
      cell: (it) => it.persona_name ?? t("history.notRecorded"),
    },
    {
      id: "bank",
      header: t("history.colBank"),
      text: (it) => it.bank_name ?? t("history.notRecorded"),
      cell: (it) => it.bank_name ?? t("history.notRecorded"),
    },
    {
      // The bank's version in its own column, as in the Users tab (owner, 2026-10-09).
      id: "version",
      header: t("admin.users.bankVersion"),
      text: (it) => (it.bank_version_no != null ? `v${it.bank_version_no}` : "—"),
      cell: (it) =>
        it.bank_version_no != null ? (
          <span data-testid={`result-bank-version-${it.id}`}>{`v${it.bank_version_no}`}</span>
        ) : (
          "—"
        ),
    },
    {
      id: "status",
      header: t("history.colStatus"),
      text: (it) => t(`history.status.${it.status}`),
      pad: 24, // the badge's own padding
      cell: (it) => <StatusBadge status={it.status} />,
    },
    {
      id: "score",
      header: t("history.colScore"),
      sort: sortOf(state, "total_score"),
      text: (it) => (it.total_score == null ? "—" : `${it.total_score}/100`),
      cell: (it) => (it.total_score == null ? "—" : `${it.total_score}/100`),
    },
    {
      id: "outcome",
      header: t("admin.results.outcome"),
      text: (it) => (it.outcome ? t(`report.outcome.${it.outcome}`) : "—"),
      cell: (it) => (it.outcome ? t(`report.outcome.${it.outcome}`) : "—"),
    },
  ];

  const toggleStatus = (s: HistoryStatus, on: boolean) => {
    const current = filters.status ?? [];
    state.setFilters({ status: on ? [...current, s] : current.filter((x) => x !== s) });
  };

  return (
    <Card className={styles.card} data-testid="results-tab">
      <CardHeader header={<Title3>{t("admin.results.tab")}</Title3>} />
      <div style={{ padding: "0 16px 16px" }}>
        <div className={local.filters} data-testid="results-filters">
          <Field label={t("admin.results.candidate")} className={local.filter}>
            <Select
              className={local.control}
              value={filters.user_id ?? ""}
              onChange={(_, d) => state.setFilters({ user_id: d.value || undefined })}
              data-testid="results-filter-user"
            >
              <option value="">{t("admin.results.any")}</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("history.colInterviewer")} className={local.filter}>
            <Select
              className={local.control}
              value={filters.persona_id ?? ""}
              onChange={(_, d) => state.setFilters({ persona_id: d.value || undefined })}
              data-testid="results-filter-persona"
            >
              <option value="">{t("admin.results.any")}</option>
              {state.personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("history.colBank")} className={local.filter}>
            <Select
              className={local.control}
              value={filters.bank_id ?? ""}
              onChange={(_, d) => state.setFilters({ bank_id: d.value || undefined })}
              data-testid="results-filter-bank"
            >
              <option value="">{t("admin.results.any")}</option>
              {state.banks.map((b) => (
                <option key={b.bank_id} value={b.bank_id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("admin.results.outcome")} className={local.filter}>
            <Select
              className={local.control}
              value={filters.outcome ?? ""}
              onChange={(_, d) => state.setFilters({ outcome: d.value || undefined })}
              data-testid="results-filter-outcome"
            >
              <option value="">{t("admin.results.any")}</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {t(`report.outcome.${o}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("admin.results.startedFrom")} className={local.filter}>
            <Input
              className={local.control}
              type="date"
              value={filters.started_from ?? ""}
              max={filters.started_to}
              onChange={(_, d) => state.setFilters({ started_from: d.value || undefined })}
              data-testid="results-filter-from"
            />
          </Field>
          <Field label={t("admin.results.startedTo")} className={local.filter}>
            <Input
              className={local.control}
              type="date"
              value={filters.started_to ?? ""}
              min={filters.started_from}
              onChange={(_, d) => state.setFilters({ started_to: d.value || undefined })}
              data-testid="results-filter-to"
            />
          </Field>
          <ScoreInput
            label={t("admin.results.scoreMin")}
            value={filters.score_min}
            onCommit={(v) => state.setFilters({ score_min: v })}
            testId="results-filter-score-min"
          />
          <ScoreInput
            label={t("admin.results.scoreMax")}
            value={filters.score_max}
            onCommit={(v) => state.setFilters({ score_max: v })}
            testId="results-filter-score-max"
          />
          <Field label={t("history.colStatus")} className={local.statusField}>
            <div className={local.statuses}>
              {STATUSES.map((s) => (
                <Checkbox
                  key={s}
                  shape="square"
                  indicator={{ className: local.checkboxBox }}
                  label={t(`history.status.${s}`)}
                  checked={filters.status?.includes(s) ?? false}
                  onChange={(_, d) => toggleStatus(s, Boolean(d.checked))}
                  data-testid={`results-filter-status-${s}`}
                />
              ))}
            </div>
          </Field>
          <Button
            appearance="subtle"
            disabled={!hasFilters}
            onClick={state.clearFilters}
            data-testid="results-clear"
          >
            {t("admin.results.clear")}
          </Button>
        </div>

        {state.error && (
          <Body1 role="alert" className={styles.errorText} data-testid="results-error">
            {t("history.loadError", { message: state.error })}
          </Body1>
        )}

        <div className={local.scroll}>
          <DataTable
            testId="results-table"
            aria-busy={state.loading}
            items={state.items}
            getRowId={(it) => it.id}
            rowProps={(it) => ({
              className: local.row,
              onClick: () => void state.open(it.id),
              onKeyDown: (e) => e.key === "Enter" && void state.open(it.id),
              tabIndex: 0,
              "data-testid": `results-row-${it.id}`,
            })}
            columns={columns}
          />
        </div>
        {!state.loading && state.items.length === 0 && !state.error && (
          <Body1 style={{ display: "block", padding: "16px 0" }} data-testid="results-empty">
            {hasFilters ? t("admin.results.noMatch") : t("history.empty")}
          </Body1>
        )}

        <TablePager
          testId="results"
          loading={state.loading}
          total={state.total}
          page={state.page}
          pageSize={state.pageSize}
          onPage={state.setPage}
          onPageSize={state.setPageSize}
        />
      </div>

      <OverlayDrawer
        position="end"
        size="large"
        open={state.detail !== null || state.detailError !== null}
        onOpenChange={(_, d) => !d.open && state.close()}
        data-testid="results-drawer"
      >
        <DrawerHeader>
          <DrawerHeaderTitle>
            {t("admin.results.detailTitle")}
            {state.detail?.bank_version_no != null && (
              <Text size={300} data-testid="results-drawer-bank-version">
                {" · "}
                {t("admin.results.bankVersion", { no: state.detail.bank_version_no })}
              </Text>
            )}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {state.detailError && (
            <Body1 role="alert" className={styles.errorText}>
              {t("history.loadError", { message: state.detailError })}
            </Body1>
          )}
          {state.detail && (
            <InterviewDetailView
              detail={state.detail}
              openSop={fetchInterviewSopDocument}
              onClose={state.close}
              onGenerateReport={state.generateReport}
            />
          )}
          {state.detail && <InterviewRecordings interviewId={state.detail.item.id} />}
        </DrawerBody>
      </OverlayDrawer>
    </Card>
  );
}
