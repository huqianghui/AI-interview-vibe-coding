/** State of the admin "Interview results" tab: every candidate's interviews, filtered, sorted and
 * paged on the server, plus the interview open in the side drawer. The page owns this hook, so the
 * filters, page and open interview survive switching to another admin tab and back (#181). */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type {
  AdminUser,
  Bank,
  InterviewResultFilters,
  InterviewResultItem,
  InterviewResultsQuery,
} from "../../api/admin";
import type { InterviewDetail } from "../../api/client";
import { listPersonas, type PersonaOut } from "../../api/personas";

export const PAGE_SIZES = [20, 50, 100] as const;

// Background scoring is polled at this pace, for at most this long (~18 s per question, measured).
// Exported so a test can shorten the wait.
export const SCORING_POLL = { ms: 3000 };
const SCORING_POLL_LIMIT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type SortKey = "started_at" | "total_score";

export function useInterviewsTab(active: boolean) {
  const [filters, setFiltersState] = useState<InterviewResultFilters>({});
  const [sort, setSort] = useState<SortKey>("started_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [pageSize, setPageSizeState] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(0); // zero-based

  const [items, setItems] = useState<InterviewResultItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter choices.
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [personas, setPersonas] = useState<PersonaOut[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);

  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Only the newest request may paint the table: a slow response for an older filter or page
  // would otherwise overwrite the one the admin is looking at.
  const requestSeq = useRef(0);
  // Which interview the drawer is for; a late response for another one is dropped.
  const openId = useRef<string | null>(null);

  const query: InterviewResultsQuery = {
    ...filters,
    sort,
    order,
    limit: pageSize,
    offset: page * pageSize,
  };
  const queryKey = JSON.stringify(query);

  const load = useCallback(async (q: InterviewResultsQuery) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await admin.listInterviewResults(q);
      if (seq !== requestSeq.current) return;
      setItems(result.items);
      setTotal(result.total);
    } catch (e) {
      if (seq === requestSeq.current) setError(message(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load(JSON.parse(queryKey) as InterviewResultsQuery);
  }, [active, queryKey, load]);

  useEffect(() => {
    if (!active) return;
    // Filter choices load on their own: a failure leaves the table usable, the selects offer "Any".
    void admin.listUsers().then(setUsers, (e: unknown) => console.warn("[results] users", e));
    void listPersonas().then(setPersonas, (e: unknown) => console.warn("[results] personas", e));
    void admin.listBanks().then(setBanks, (e: unknown) => console.warn("[results] banks", e));
  }, [active]);

  /** Change some filters. Any change goes back to the first page: page 4 of the old list is not a
   * page of the new one. */
  const setFilters = (patch: Partial<InterviewResultFilters>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      for (const key of Object.keys(next) as (keyof InterviewResultFilters)[]) {
        const v = next[key];
        if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete next[key];
      }
      return next;
    });
    setPage(0);
  };

  const clearFilters = () => {
    setFiltersState({});
    setPage(0);
  };

  /** Click a sortable header: the same column flips direction, a new column starts descending. */
  const toggleSort = (key: SortKey) => {
    if (key === sort) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setOrder("desc");
    }
    setPage(0);
  };

  const setPageSize = (size: number) => {
    setPageSizeState(size);
    setPage(0);
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const open = async (interviewId: string) => {
    openId.current = interviewId;
    setDetailError(null);
    try {
      const d = await admin.getInterview(interviewId);
      if (openId.current === interviewId) setDetail(d);
    } catch (e) {
      if (openId.current === interviewId) setDetailError(message(e));
    }
  };

  const close = () => {
    openId.current = null;
    setDetail(null);
    setDetailError(null);
  };

  /** Start scoring the open interview, wait for the saved report, then refresh the page of rows.
   * Throws (shown under the button) when scoring could not start or ended without a report. */
  const generateReport = async () => {
    if (!detail) return;
    const interviewId = detail.item.id;
    await admin.generateInterviewReport(interviewId);
    const deadline = Date.now() + SCORING_POLL_LIMIT_MS;
    while (Date.now() < deadline) {
      await sleep(SCORING_POLL.ms);
      const current = await admin.getInterview(interviewId);
      if (current.report) {
        if (openId.current === interviewId) setDetail(current);
        void load(JSON.parse(queryKey) as InterviewResultsQuery);
        return;
      }
      // The run ended without saving a report: it failed (the server log has why).
      if (!current.scoring) throw new Error("scoring failed");
    }
    throw new Error("scoring did not finish in time");
  };

  return {
    filters,
    setFilters,
    clearFilters,
    sort,
    order,
    toggleSort,
    page,
    setPage,
    pageSize,
    setPageSize,
    pageCount,
    items,
    total,
    loading,
    error,
    users,
    personas,
    banks,
    detail,
    detailError,
    open,
    close,
    generateReport,
  };
}

export type InterviewsTabState = ReturnType<typeof useInterviewsTab>;
