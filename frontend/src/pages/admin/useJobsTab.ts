/** State of the admin "Jobs" tab: background jobs (scoring, SOP conversion and summaries, citation
 * runs, persona sync), filtered and paged on the server, refreshed while any is still going. The
 * page owns this hook, so the filters and page survive switching tabs (#181). */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type { JobItem, JobKind, JobStatus, JobsQuery } from "../../api/admin";
import { DEFAULT_PAGE_SIZE } from "../../components/tableToolbar";

/** What the tab shows first: what is going on, and what went wrong. */
export const DEFAULT_STATUSES: JobStatus[] = ["queued", "running", "failed"];
// While a job is queued or running the list refreshes at the first pace, otherwise the second.
// Exported so a test can shorten them.
export const JOBS_POLL = { activeMs: 5000, idleMs: 30_000 };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The one line above the table (owner: no status text inside rows). */
export type JobsNotice =
  | { kind: "retried"; job: JobItem }
  | { kind: "cancelled"; job: JobItem }
  | { kind: "failed"; message: string };

export function useJobsTab(active: boolean) {
  const [statuses, setStatusesState] = useState<JobStatus[]>(DEFAULT_STATUSES);
  const [kind, setKindState] = useState<JobKind | "">("");
  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);

  const [items, setItems] = useState<JobItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<JobsNotice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const requestSeq = useRef(0);
  const query: JobsQuery = {
    status: statuses,
    kind: kind ? [kind] : undefined,
    limit: pageSize,
    offset: page * pageSize,
  };
  const queryKey = JSON.stringify(query);

  const load = useCallback(async (q: JobsQuery, quiet = false) => {
    const seq = ++requestSeq.current;
    if (!quiet) setLoading(true);
    try {
      const result = await admin.listJobs(q);
      if (seq !== requestSeq.current) return;
      setItems(result.items);
      setTotal(result.total);
      setError(null);
    } catch (e) {
      if (seq === requestSeq.current) setError(message(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load(JSON.parse(queryKey) as JobsQuery);
  }, [active, queryKey, load]);

  // Refresh in the background: quickly while something is still going, slowly otherwise.
  const going = items.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(
      () => void load(JSON.parse(queryKey) as JobsQuery, true),
      going ? JOBS_POLL.activeMs : JOBS_POLL.idleMs,
    );
    return () => clearInterval(id);
  }, [active, going, queryKey, load]);

  const setStatuses = (next: JobStatus[]) => {
    setStatusesState(next);
    setPage(0);
  };
  const setKind = (next: JobKind | "") => {
    setKindState(next);
    setPage(0);
  };
  const setPageSize = (size: number) => {
    setPageSizeState(size);
    setPage(0);
  };

  const act = async (job: JobItem, action: "retry" | "cancel") => {
    setBusyId(job.job_id);
    try {
      const out =
        action === "retry" ? await admin.retryJob(job.job_id) : await admin.cancelJob(job.job_id);
      setNotice({ kind: action === "retry" ? "retried" : "cancelled", job: out });
      await load(JSON.parse(queryKey) as JobsQuery, true);
    } catch (e) {
      setNotice({ kind: "failed", message: message(e) });
    } finally {
      setBusyId(null);
    }
  };

  return {
    statuses,
    setStatuses,
    kind,
    setKind,
    page,
    setPage,
    pageSize,
    setPageSize,
    items,
    total,
    loading,
    error,
    notice,
    busyId,
    retry: (job: JobItem) => act(job, "retry"),
    cancel: (job: JobItem) => act(job, "cancel"),
    refresh: () => load(JSON.parse(queryKey) as JobsQuery),
  };
}

export type JobsTabState = ReturnType<typeof useJobsTab>;
