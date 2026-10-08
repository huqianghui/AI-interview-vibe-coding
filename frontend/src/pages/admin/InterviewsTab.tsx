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
import { fetchInterviewSopDocument } from "../../api/admin";
import type { HistoryStatus } from "../../api/client";
import { InterviewDetailView, StatusBadge } from "../../components/InterviewHistory";
import { formatWhen } from "../../components/transcriptText";
import { useAdminStyles } from "./shared";
import { PAGE_SIZES, type InterviewsTabState, type SortKey } from "./useInterviewsTab";

const STATUSES: HistoryStatus[] = ["in_progress", "completed", "scored", "abandoned", "created"];
const OUTCOMES = ["Meets Expectations", "Needs Improvement", "Does Not Meet"] as const;

const useStyles = makeStyles({
  filters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))",
    gap: tokens.spacingHorizontalM,
    alignItems: "end",
    marginBottom: tokens.spacingVerticalL,
  },
  // A select sizes itself to its longest option by default; a long bank or interviewer name then
  // spilled over the next filter (seen at 2000px). Each filter fits its grid cell instead.
  filter: { minWidth: 0 },
  control: { minWidth: 0, width: "100%" },
  statuses: { display: "flex", flexWrap: "wrap", columnGap: tokens.spacingHorizontalS },
  statusField: { gridColumn: "span 2" },
  scroll: { overflowX: "auto" },
  row: { cursor: "pointer" },
  pager: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
  },
  pagerControls: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    whiteSpace: "nowrap",
  },
  // The app theme's 8px small radius turns a 16px checkbox into a circle, which reads as a radio
  // ("pick one"); these are multi-select, so they keep a square-ish box.
  checkboxBox: { borderRadius: "3px" },
  // Pager labels keep their full width; the page-size select is what may narrow.
  pagerText: { flexShrink: 0, overflow: "visible" },
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

function SortHeader({
  state,
  column,
  children,
}: {
  state: InterviewsTabState;
  column: SortKey;
  children: React.ReactNode;
}) {
  const active = state.sort === column;
  return (
    <TableHeaderCell
      sortable
      sortDirection={active ? (state.order === "desc" ? "descending" : "ascending") : undefined}
      onClick={() => state.toggleSort(column)}
      data-testid={`results-sort-${column}`}
    >
      {children}
    </TableHeaderCell>
  );
}

export function InterviewsTab({ state }: { state: InterviewsTabState }) {
  const styles = useAdminStyles();
  const local = useStyles();
  const { t, i18n } = useTranslation();
  const { filters } = state;
  const candidates = state.users.filter((u) => u.role === "user");
  const from = state.total === 0 ? 0 : state.page * state.pageSize + 1;
  const to = Math.min(state.total, (state.page + 1) * state.pageSize);
  const hasFilters = Object.keys(filters).length > 0;

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
          <Table data-testid="results-table" aria-busy={state.loading}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t("admin.results.candidate")}</TableHeaderCell>
                <SortHeader state={state} column="started_at">
                  {t("history.colStarted")}
                </SortHeader>
                <TableHeaderCell>{t("history.colCompleted")}</TableHeaderCell>
                <TableHeaderCell>{t("history.colInterviewer")}</TableHeaderCell>
                <TableHeaderCell>{t("history.colBank")}</TableHeaderCell>
                <TableHeaderCell>{t("history.colStatus")}</TableHeaderCell>
                <SortHeader state={state} column="total_score">
                  {t("history.colScore")}
                </SortHeader>
                <TableHeaderCell>{t("admin.results.outcome")}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.items.map((it) => (
                <TableRow
                  key={it.id}
                  className={local.row}
                  onClick={() => void state.open(it.id)}
                  onKeyDown={(e) => e.key === "Enter" && void state.open(it.id)}
                  tabIndex={0}
                  data-testid={`results-row-${it.id}`}
                >
                  <TableCell>{it.username ?? t("admin.results.anonymous")}</TableCell>
                  <TableCell>{formatWhen(it.started_at, i18n.language)}</TableCell>
                  <TableCell>{formatWhen(it.completed_at, i18n.language)}</TableCell>
                  <TableCell>{it.persona_name ?? t("history.notRecorded")}</TableCell>
                  <TableCell>
                    {it.bank_name ?? t("history.notRecorded")}
                    {it.bank_version_no != null && (
                      <Text size={200} data-testid={`result-bank-version-${it.id}`}>
                        {" · "}
                        {t("admin.results.bankVersion", { no: it.bank_version_no })}
                      </Text>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={it.status} />
                  </TableCell>
                  <TableCell>{it.total_score == null ? "—" : `${it.total_score}/100`}</TableCell>
                  <TableCell>{it.outcome ? t(`report.outcome.${it.outcome}`) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {!state.loading && state.items.length === 0 && !state.error && (
          <Body1 style={{ display: "block", padding: "16px 0" }} data-testid="results-empty">
            {hasFilters ? t("admin.results.noMatch") : t("history.empty")}
          </Body1>
        )}

        <div className={local.pager} data-testid="results-pager">
          <Text>
            {state.loading ? (
              <Spinner size="tiny" label={t("history.loading")} />
            ) : (
              t("admin.results.range", { from, to, total: state.total })
            )}
          </Text>
          <div className={local.pagerControls}>
            <Text wrap={false} className={local.pagerText}>
              {t("admin.results.perPage")}
            </Text>
            <Select
              className={local.control}
              value={String(state.pageSize)}
              onChange={(_, d) => state.setPageSize(Number(d.value))}
              data-testid="results-page-size"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <Button
              disabled={state.page === 0}
              onClick={() => state.setPage(state.page - 1)}
              data-testid="results-prev"
            >
              {t("admin.results.prev")}
            </Button>
            <Text wrap={false} className={local.pagerText} data-testid="results-page">
              {t("admin.results.page", { page: state.page + 1, pages: state.pageCount })}
            </Text>
            <Button
              disabled={state.page + 1 >= state.pageCount}
              onClick={() => state.setPage(state.page + 1)}
              data-testid="results-next"
            >
              {t("admin.results.next")}
            </Button>
          </div>
        </div>
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
        </DrawerBody>
      </OverlayDrawer>
    </Card>
  );
}
