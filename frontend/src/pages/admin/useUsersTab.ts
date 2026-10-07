/** State of the admin page's Users tab: the seeded candidate seats and their derived passwords
 * (#102), each user's interviewer + question-bank assignment, and their interview history (#187).
 * Loaded each time the tab is opened; the expanded user and the open interview are kept across tab
 * switches because the page owns this hook (#181). */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type { AdminUser, Assignment, Bank } from "../../api/admin";
import type { InterviewDetail, InterviewHistoryItem } from "../../api/client";
import { listPersonas, type PersonaOut } from "../../api/personas";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Background scoring is polled at this pace, for at most this long (~18 s per question, measured).
// Exported so a test can shorten the wait.
export const SCORING_POLL = { ms: 3000 };
const SCORING_POLL_LIMIT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useUsersTab(active: boolean) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);

  // Assignment choices: every persona/bank, so a disabled one already assigned still shows by name.
  const [personas, setPersonas] = useState<PersonaOut[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [assignStatus, setAssignStatus] = useState<
    Record<string, { kind: "saved" } | { kind: "error"; message: string }>
  >({});

  // History of ONE user at a time, expanded under that user's row.
  const [historyUserId, setHistoryUserId] = useState<string | null>(null);
  const [history, setHistory] = useState<InterviewHistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  // Which user's history is on screen. A response for any other user arrived late (the admin
  // switched users while it was in flight) and is dropped instead of painted under the wrong row.
  const shownUserRef = useRef<string | null>(null);
  // The latest assignment chosen per user. Two quick changes on one row (interviewer, then bank)
  // each build on the previous choice, not on the row as it was rendered before the first save.
  const pendingAssignment = useRef<Record<string, Assignment>>({});

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    // The assignment choices load on their own: if they fail, the list (and the passwords an admin
    // opened this tab to hand out) still shows; the selects just offer only "Default".
    void listPersonas().then(setPersonas, (e: unknown) => console.warn("[users] personas", e));
    void admin.listBanks().then(setBanks, (e: unknown) => console.warn("[users] banks", e));
    try {
      setUsers(await admin.listUsers());
    } catch (e) {
      setUsersError(message(e));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void loadUsers();
  }, [active, loadUsers]);

  const copyPassword = (userId: string, generatedPassword: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(generatedPassword).then(() => {
        setCopiedUserId(userId);
      });
    }
  };

  const assign = async (user: AdminUser, change: Partial<Assignment>) => {
    const base = pendingAssignment.current[user.id] ?? {
      persona_id: user.assigned_persona_id,
      bank_id: user.assigned_bank_id,
    };
    const next: Assignment = { ...base, ...change };
    pendingAssignment.current[user.id] = next;
    // Show the choice at once; the save confirms it (or the error says it did not stick).
    setUsers((prev) =>
      prev.map((u) =>
        u.id === user.id
          ? { ...u, assigned_persona_id: next.persona_id, assigned_bank_id: next.bank_id }
          : u,
      ),
    );
    try {
      await admin.setUserAssignment(user.id, next);
      setAssignStatus((prev) => ({ ...prev, [user.id]: { kind: "saved" } }));
    } catch (e) {
      setAssignStatus((prev) => ({ ...prev, [user.id]: { kind: "error", message: message(e) } }));
    }
  };

  const loadHistory = useCallback(async (userId: string) => {
    setHistory(null);
    setHistoryError(null);
    try {
      const list = await admin.listUserInterviews(userId);
      if (shownUserRef.current === userId) setHistory(list);
    } catch (e) {
      if (shownUserRef.current === userId) setHistoryError(message(e));
    }
  }, []);

  const toggleHistory = (userId: string) => {
    setDetail(null);
    if (historyUserId === userId) {
      shownUserRef.current = null;
      setHistoryUserId(null);
      return;
    }
    shownUserRef.current = userId;
    setHistoryUserId(userId);
    void loadHistory(userId);
  };

  const openInterview = async (interviewId: string) => {
    const userId = shownUserRef.current;
    setHistoryError(null);
    try {
      const opened = await admin.getInterview(interviewId);
      if (shownUserRef.current === userId) setDetail(opened);
    } catch (e) {
      if (shownUserRef.current === userId) setHistoryError(message(e));
    }
  };

  const closeInterview = () => setDetail(null);

  /** Start scoring the open interview, wait for the saved report, then refresh the list too.
   * Throws (shown under the button) when scoring could not start or never finished. */
  const generateReport = async () => {
    if (!detail) return;
    const interviewId = detail.item.id;
    const userId = shownUserRef.current;
    await admin.generateInterviewReport(interviewId);
    const deadline = Date.now() + SCORING_POLL_LIMIT_MS;
    while (Date.now() < deadline) {
      await sleep(SCORING_POLL.ms);
      const current = await admin.getInterview(interviewId);
      if (current.report) {
        if (shownUserRef.current === userId) {
          setDetail(current);
          if (userId) void loadHistory(userId);
        }
        return;
      }
      // The run ended without saving a report: it failed (the server log has why).
      if (!current.scoring) throw new Error("scoring failed");
    }
    throw new Error("scoring did not finish in time");
  };

  return {
    users,
    usersLoading,
    usersError,
    copiedUserId,
    copyPassword,
    personas,
    banks,
    assign,
    assignStatus,
    historyUserId,
    history,
    historyError,
    toggleHistory,
    detail,
    openInterview,
    closeInterview,
    generateReport,
  };
}

export type UsersTabState = ReturnType<typeof useUsersTab>;
