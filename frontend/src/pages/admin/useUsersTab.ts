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
  // Assignment changes are staged per user and saved together by the Save button (owner,
  // 2026-10-09), not on every change of a select.
  const [drafts, setDrafts] = useState<Record<string, Assignment>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<
    { kind: "saved"; count: number } | { kind: "error"; count: number } | null
  >(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

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

  const savedAssignment = (u: AdminUser): Assignment => ({
    persona_id: u.assigned_persona_id,
    bank_id: u.assigned_bank_id,
    bank_version_id: u.assigned_bank_version_id ?? null,
  });
  // Unset and null are the same choice (the default).
  const same = (a: Assignment, b: Assignment) =>
    (a.persona_id ?? null) === (b.persona_id ?? null) &&
    (a.bank_id ?? null) === (b.bank_id ?? null) &&
    (a.bank_version_id ?? null) === (b.bank_version_id ?? null);

  /** Stage a change to one user's assignment; nothing is saved until Save. */
  const assign = (row: AdminUser, change: Partial<Assignment>) => {
    setSaveResult(null);
    // The table hands over the row as shown (staged change applied): compare with what is saved.
    const user = users.find((u) => u.id === row.id) ?? row;
    setDrafts((prev) => {
      const base = prev[user.id] ?? savedAssignment(user);
      const next: Assignment = { ...base, ...change };
      // A new bank starts on its latest version: null, which the backend resolves on save.
      if ("bank_id" in change && change.bank_id !== base.bank_id && !("bank_version_id" in change)) {
        next.bank_version_id = null;
      }
      const rest = { ...prev };
      delete rest[user.id];
      return same(next, savedAssignment(user)) ? rest : { ...rest, [user.id]: next };
    });
    if (change.bank_id) loadVersions(change.bank_id);
  };

  /** A user as the table shows them: the saved assignment with any staged change on top. */
  const rowOf = (u: AdminUser): AdminUser => {
    const d = drafts[u.id];
    if (!d) return u;
    return {
      ...u,
      assigned_persona_id: d.persona_id,
      assigned_bank_id: d.bank_id,
      assigned_bank_version_id: d.bank_version_id ?? null,
    };
  };

  const changedCount = Object.keys(drafts).length;

  const discard = () => {
    setDrafts({});
    setRowErrors({});
    setSaveResult(null);
  };

  /** Save every staged change. A user whose save fails keeps the change staged and says why. */
  const save = async () => {
    const pending = Object.entries(drafts);
    if (pending.length === 0) return;
    setSaving(true);
    setSaveResult(null);
    const results = await Promise.allSettled(
      pending.map(([id, next]) => admin.setUserAssignment(id, next)),
    );
    const failed: Record<string, string> = {};
    const saved: Record<string, AdminUser> = {};
    results.forEach((r, i) => {
      const id = pending[i][0];
      if (r.status === "fulfilled" && r.value) saved[id] = r.value;
      else failed[id] = r.status === "rejected" ? message(r.reason) : "not saved";
    });
    setUsers((prev) => prev.map((u) => saved[u.id] ?? u));
    for (const u of Object.values(saved)) if (u.assigned_bank_id) loadVersions(u.assigned_bank_id, true);
    setDrafts((prev) => {
      const rest = { ...prev };
      for (const id of Object.keys(saved)) delete rest[id];
      return rest;
    });
    setRowErrors(failed);
    const failures = Object.keys(failed).length;
    setSaveResult(
      failures ? { kind: "error", count: failures } : { kind: "saved", count: pending.length },
    );
    setSaving(false);
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
    rowOf,
    drafts,
    changedCount,
    save,
    discard,
    saving,
    saveResult,
    rowErrors,
  };
}

export type UsersTabState = ReturnType<typeof useUsersTab>;
