/** State of the admin page's Users tab: the seeded candidate seats and their derived passwords
 * (#102), and each user's interviewer + question-bank assignment (#187). Loaded each time the tab
 * is opened. Interview results have their own tab (useInterviewsTab). */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type { AdminUser, Assignment, Bank, BankVersion } from "../../api/admin";
import { listPersonas, type PersonaOut } from "../../api/personas";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useUsersTab(active: boolean) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);

  // Assignment choices: every persona/bank, so a disabled one already assigned still shows by name.
  const [personas, setPersonas] = useState<PersonaOut[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  // Each assigned bank's rubric versions (newest first), fetched once per bank for the picker.
  const [versionsByBank, setVersionsByBank] = useState<Record<string, BankVersion[]>>({});
  const requestedVersions = useRef<Set<string>>(new Set());
  const loadVersions = useCallback((bankId: string, force = false) => {
    if (!force && requestedVersions.current.has(bankId)) return;
    requestedVersions.current.add(bankId);
    void admin.listBankVersions(bankId).then(
      (versions) => setVersionsByBank((prev) => ({ ...prev, [bankId]: versions })),
      (e: unknown) => console.warn("[users] rubric versions", e),
    );
  }, []);
  const [assignStatus, setAssignStatus] = useState<
    Record<string, { kind: "saved" } | { kind: "error"; message: string }>
  >({});

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
      const loaded = await admin.listUsers();
      setUsers(loaded);
      requestedVersions.current.clear();
      for (const bankId of new Set(loaded.map((u) => u.assigned_bank_id).filter(Boolean))) {
        loadVersions(bankId as string, true);
      }
    } catch (e) {
      setUsersError(message(e));
    } finally {
      setUsersLoading(false);
    }
  }, [loadVersions]);

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
      bank_version_id: user.assigned_bank_version_id ?? null,
    };
    const next: Assignment = { ...base, ...change };
    // A new bank starts on that bank's latest version: the backend picks it when the id is null.
    if ("bank_id" in change && change.bank_id !== base.bank_id && !("bank_version_id" in change)) {
      next.bank_version_id = null;
    }
    pendingAssignment.current[user.id] = next;
    // Show the choice at once; the save confirms it (or the error says it did not stick).
    setUsers((prev) =>
      prev.map((u) =>
        u.id === user.id
          ? {
              ...u,
              assigned_persona_id: next.persona_id,
              assigned_bank_id: next.bank_id,
              assigned_bank_version_id: next.bank_version_id ?? null,
            }
          : u,
      ),
    );
    try {
      const saved = await admin.setUserAssignment(user.id, next);
      // The backend resolved "latest" to a concrete version: show it and build on it next time.
      pendingAssignment.current[user.id] = {
        ...next,
        bank_version_id: saved?.assigned_bank_version_id ?? null,
      };
      setUsers((prev) =>
        prev.map((u) =>
          u.id === user.id
            ? {
                ...u,
                assigned_bank_version_id: saved?.assigned_bank_version_id ?? null,
                assigned_bank_version_no: saved?.assigned_bank_version_no ?? null,
              }
            : u,
        ),
      );
      if (next.bank_id) loadVersions(next.bank_id, true);
      setAssignStatus((prev) => ({ ...prev, [user.id]: { kind: "saved" } }));
    } catch (e) {
      setAssignStatus((prev) => ({ ...prev, [user.id]: { kind: "error", message: message(e) } }));
    }
  };

  return {
    users,
    usersLoading,
    usersError,
    copiedUserId,
    copyPassword,
    personas,
    banks,
    versionsByBank,
    assign,
    assignStatus,
  };
}

export type UsersTabState = ReturnType<typeof useUsersTab>;
