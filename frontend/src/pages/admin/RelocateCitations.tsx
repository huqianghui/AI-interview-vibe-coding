/** "Relocate SOP citations" for one bank (spec-sop-section-grounding §4): runs in the background
 * over the bank's DRAFT rubric, then lists every item's old citation beside its new one. The new
 * citations are already in the draft; the admin reviews them and publishes.
 *
 * The results open in a right-side drawer, like an interview's results (owner, 2026-10-09): the
 * items that need a decision first, each with a way into its rubric. Once a version is published
 * after the run, the summary goes away. */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Body1,
  Button,
  Checkbox,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from "@fluentui/react-components";
import { ChevronDownRegular, ChevronRightRegular, DismissRegular } from "@fluentui/react-icons";
import * as admin from "../../api/admin";
import type { CitationRun, CitationRunRow } from "../../api/admin";
import { sectionName } from "../../api/client";
import { useAdminStyles } from "./shared";

export const RELOCATE_POLL_MS = 3000;

const HOW_COLOR = {
  label: "brand",
  search: "success",
  none: "warning",
  off_topic: "subtle",
  error: "danger",
  edited: "informative",
} as const;

// No SOP found, failed, or saved during the run: the admin decides what to do with these.
const NEEDS_ATTENTION: ReadonlySet<CitationRunRow["how"]> = new Set(["none", "error", "edited"]);

function RowsTable({
  rows,
  testId,
  onOpenQuestion,
}: {
  rows: CitationRunRow[];
  testId: string;
  onOpenQuestion: (row: CitationRunRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <Table size="small" data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell style={{ width: "26%" }}>{t("admin.relocate.colQuestion")}</TableHeaderCell>
          <TableHeaderCell style={{ width: "24%" }}>{t("admin.relocate.colItem")}</TableHeaderCell>
          <TableHeaderCell style={{ width: "18%" }}>{t("admin.relocate.colOld")}</TableHeaderCell>
          <TableHeaderCell>{t("admin.relocate.colNew")}</TableHeaderCell>
          <TableHeaderCell style={{ width: 130 }} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            <TableCell>
              <Text size={200}>
                <Text weight="semibold" size={200}>
                  {row.question_no}.
                </Text>{" "}
                {row.question}
              </Text>
            </TableCell>
            <TableCell>
              <Text size={200}>{row.item}</Text>
            </TableCell>
            <TableCell>
              <Text size={200}>
                {[row.old.document_name, row.old.quote].filter(Boolean).join(" — ") ||
                  t("admin.relocate.nothing")}
              </Text>
            </TableCell>
            <TableCell>
              <Badge appearance="tint" color={HOW_COLOR[row.how]}>
                {t(`admin.relocate.how.${row.how}`)}
              </Badge>{" "}
              <Text size={200}>
                {row.new.sections.map((s) => `${s.document_name} · ${sectionName(s)}`).join("; ")}
                {row.new.quote ? ` — “${row.new.quote}”` : ""}
              </Text>
            </TableCell>
            <TableCell>
              <Button size="small" appearance="subtle" onClick={() => onOpenQuestion(row)}>
                {t("admin.relocate.openEditor")}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One collapsible group of rows in the drawer. */
function Group({
  title,
  hint,
  rows,
  testId,
  initiallyOpen,
  onOpenQuestion,
}: {
  title: string;
  hint?: string;
  rows: CitationRunRow[];
  testId: string;
  initiallyOpen: boolean;
  onOpenQuestion: (row: CitationRunRow) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  if (rows.length === 0) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
      <Button
        appearance="transparent"
        icon={open ? <ChevronDownRegular /> : <ChevronRightRegular />}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        style={{ justifyContent: "flex-start", fontWeight: 600, paddingLeft: 0 }}
      >
        {title}
      </Button>
      {open && hint && <Text size={200}>{hint}</Text>}
      {open && <RowsTable rows={rows} testId={testId} onOpenQuestion={onOpenQuestion} />}
    </section>
  );
}

export function RelocateCitations({
  bankId,
  onDone,
  onOpenQuestion,
}: {
  bankId: string;
  onDone: () => void;
  /** Open this row's question in the rubric editor (the drawer closes first). */
  onOpenQuestion: (row: CitationRunRow) => void;
}) {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const [run, setRun] = useState<CitationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(false);

  const load = useCallback(async () => {
    try {
      setRun(await admin.getCitationRun(bankId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [bankId]);

  // A run just finished: the draft rubric changed underneath the editor. Tracked per bank, so
  // switching banks mid-run is not mistaken for a finish.
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    setRun(null);
    setOpen(false);
    setWasRunning(false);
    void load();
  }, [load]);

  const running = run?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), RELOCATE_POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  useEffect(() => {
    if (wasRunning && !running && run !== null) {
      setOpen(true);
      onDone();
    }
    setWasRunning(running);
  }, [running, wasRunning, run, onDone]);

  const start = async () => {
    setError(null);
    try {
      setRun(await admin.relocateCitations(bankId, fresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rows = run?.rows ?? [];
  const counts = { label: 0, search: 0, none: 0, off_topic: 0, error: 0, edited: 0 };
  for (const row of rows) counts[row.how] += 1;
  const attention = rows.filter((r) => NEEDS_ATTENTION.has(r.how));
  const others = rows.filter((r) => !NEEDS_ATTENTION.has(r.how));
  const pending = run?.status === "done" && !run.published;

  const openQuestion = (row: CitationRunRow) => {
    setOpen(false);
    onOpenQuestion(row);
  };

  return (
    <div data-testid="relocate-citations" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button size="small" data-testid="relocate-start" disabled={running} onClick={() => void start()}>
          {running
            ? t("admin.relocate.running", { done: run?.done ?? 0, total: run?.total ?? 0 })
            : t("admin.relocate.start")}
        </Button>
        {run !== null && (
          <Checkbox
            data-testid="relocate-fresh"
            checked={fresh}
            disabled={running}
            onChange={(_, d) => setFresh(Boolean(d.checked))}
            label={t("admin.relocate.fresh")}
          />
        )}
        <Text size={200}>{t("admin.relocate.hint")}</Text>
      </div>
      {error && (
        <Body1 role="alert" className={styles.errorText}>
          {error}
        </Body1>
      )}
      {run?.status === "failed" && (
        <Body1 role="alert" className={styles.errorText}>
          {t("admin.relocate.failed", { error: run.error })}
        </Body1>
      )}
      {pending && (
        <Text size={200} data-testid="relocate-summary">
          {t("admin.relocate.summary", { ...counts, total: rows.length })}{" "}
          <Button
            size="small"
            appearance="transparent"
            data-testid="relocate-show"
            onClick={() => setOpen(true)}
          >
            {t("admin.relocate.show")}
          </Button>
        </Text>
      )}

      <OverlayDrawer
        position="end"
        size="large"
        open={open && run?.status === "done"}
        onOpenChange={(_, d) => !d.open && setOpen(false)}
        data-testid="relocate-drawer"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                aria-label={t("admin.relocate.close")}
                icon={<DismissRegular />}
                onClick={() => setOpen(false)}
                data-testid="relocate-close"
              />
            }
          >
            {t("admin.relocate.drawerTitle")}
          </DrawerHeaderTitle>
          <Text size={200}>{t("admin.relocate.summary", { ...counts, total: rows.length })}</Text>
        </DrawerHeader>
        <DrawerBody>
          <Group
            title={t("admin.relocate.attention", { count: attention.length })}
            hint={t("admin.relocate.attentionHint")}
            rows={attention}
            testId="relocate-attention"
            initiallyOpen
            onOpenQuestion={openQuestion}
          />
          <Group
            title={t("admin.relocate.others", { count: others.length })}
            rows={others}
            testId="relocate-rows"
            initiallyOpen={attention.length === 0}
            onOpenQuestion={openQuestion}
          />
        </DrawerBody>
      </OverlayDrawer>
    </div>
  );
}
