/** State of the admin page's Users tab (#102, read-only): the seeded candidate seats and their
 * derived passwords, loaded each time the tab is opened. */
import { useCallback, useEffect, useState } from "react";
import * as admin from "../../api/admin";
import type { AdminUser } from "../../api/admin";

export function useUsersTab(active: boolean) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      setUsers(await admin.listUsers());
    } catch (e) {
      setUsersError(e instanceof Error ? e.message : String(e));
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

  return { users, usersLoading, usersError, copiedUserId, copyPassword };
}

export type UsersTabState = ReturnType<typeof useUsersTab>;
