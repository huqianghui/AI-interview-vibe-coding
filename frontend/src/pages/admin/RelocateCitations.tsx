/** "Relocate SOP citations" for one bank (spec-sop-section-grounding §4): runs in the background
 * over the bank's DRAFT rubric, then lists every item's old citation beside its new one. The new
 * citations are already in the draft; the admin reviews them here and publishes. */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Body1,
  Button,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from "@fluentui/react-components";
import * as admin from "../../api/admin";
import type { CitationRun } from "../../api/admin";
import { sectionName } from "../../api/client";
import { useAdminStyles } from "./shared";

export const RELOCATE_POLL_MS = 3000;

const HOW_COLOR = {
  label: "brand",
  search: "success",
  none: "warning",
  error: "danger",
  edited: "informative",
} as const;

export function RelocateCitations({ bankId, onDone }: { bankId: string; onDone: () => void }) {
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

  const counts = { label: 0, search: 0, none: 0, error: 0, edited: 0 };
  for (const row of run?.rows ?? []) counts[row.how] += 1;

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
      {run?.status === "done" && (
        <>
          <Text size={200} data-testid="relocate-summary">
            {t("admin.relocate.summary", { ...counts, total: run.rows.length })}{" "}
            <Button size="small" appearance="transparent" onClick={() => setOpen((v) => !v)}>
              {open ? t("admin.relocate.hide") : t("admin.relocate.show")}
            </Button>
          </Text>
          {open && (
            <Table size="small" data-testid="relocate-rows">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell style={{ width: 40 }}>#</TableHeaderCell>
                  <TableHeaderCell>{t("admin.relocate.colItem")}</TableHeaderCell>
                  <TableHeaderCell>{t("admin.relocate.colOld")}</TableHeaderCell>
                  <TableHeaderCell>{t("admin.relocate.colNew")}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.rows.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell>{row.question_no}</TableCell>
                    <TableCell>{row.item}</TableCell>
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
                        {row.new.sections
                          .map((s) => `${s.document_name} · ${sectionName(s)}`)
                          .join("; ")}
                        {row.new.quote ? ` — “${row.new.quote}”` : ""}
                      </Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}
