/** The admin page's Users tab: hand out a seeded seat's username/password (#102) and assign each
 * user an interviewer and a question bank (#187). Interview results live in their own tab. */
import { useTranslation } from "react-i18next";
import { Body1, Button, Card, CardHeader, Select, Text, Title3, tokens } from "@fluentui/react-components";
import type { AdminUser } from "../../api/admin";
import { DataTable, type DataColumn } from "../../components/DataTable";
import { useAdminStyles } from "./shared";
import type { UsersTabState } from "./useUsersTab";

function PasswordCell({ u, state }: { u: AdminUser; state: UsersTabState }) {
  const { t } = useTranslation();
  if (u.password_stale) {
    return (
      <Text data-testid={`user-password-stale-${u.username}`}>{t("admin.users.passwordStale")}</Text>
    );
  }
  if (u.generated_password) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Text style={{ fontFamily: "monospace" }} data-testid={`user-password-${u.username}`}>
          {u.generated_password}
        </Text>
        <Button
          size="small"
          data-testid={`user-copy-${u.username}`}
          onClick={() => state.copyPassword(u.id, u.generated_password as string)}
        >
          {state.copiedUserId === u.id ? t("admin.users.copied") : t("admin.users.copy")}
        </Button>
      </div>
    );
  }
  return (
    <Text data-testid={`user-password-not-viewable-${u.username}`}>{t("admin.users.notViewable")}</Text>
  );
}

function AssignStatus({ u, state }: { u: AdminUser; state: UsersTabState }) {
  const { t } = useTranslation();
  const status = state.assignStatus[u.id];
  if (status?.kind === "saved") {
    return (
      <Text size={200} data-testid={`user-assign-saved-${u.username}`}>
        {t("admin.users.assignSaved")}
      </Text>
    );
  }
  if (status?.kind === "error") {
    return (
      <Text size={200} role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
        {t("admin.users.assignError", { message: status.message })}
      </Text>
    );
  }
  return null;
}

function PersonaSelect({ u, state }: { u: AdminUser; state: UsersTabState }) {
  const { t } = useTranslation();
  const defaultPersona = state.personas.find((p) => p.is_default && p.enabled);
  // A disabled target stays listed only while it is the one assigned, so the select can show it.
  const personas = state.personas.filter((p) => p.enabled || p.id === u.assigned_persona_id);
  return (
    <Select
      size="small"
      aria-label={t("admin.users.colInterviewer")}
      data-testid={`user-assign-persona-${u.username}`}
      value={u.assigned_persona_id ?? ""}
      onChange={(_, d) => void state.assign(u, { persona_id: d.value || null })}
    >
      <option value="">
        {t("admin.users.useDefault", { name: defaultPersona?.name ?? t("admin.users.noDefault") })}
      </option>
      {personas.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

function BankSelect({ u, state }: { u: AdminUser; state: UsersTabState }) {
  const { t } = useTranslation();
  const defaultBank = state.banks.find((b) => b.is_default && b.enabled);
  const banks = state.banks.filter((b) => b.enabled || b.bank_id === u.assigned_bank_id);
  return (
    <Select
      size="small"
      aria-label={t("admin.users.colBank")}
      data-testid={`user-assign-bank-${u.username}`}
      value={u.assigned_bank_id ?? ""}
      onChange={(_, d) => void state.assign(u, { bank_id: d.value || null })}
    >
      <option value="">
        {t("admin.users.useDefault", { name: defaultBank?.name ?? t("admin.users.noDefault") })}
      </option>
      {banks.map((b) => (
        <option key={b.bank_id} value={b.bank_id}>
          {b.name}
        </option>
      ))}
    </Select>
  );
}

/** The assigned bank's rubric version, in its own column (owner, 2026-10-09). It follows the
 * bank: a user on the default bank has no version to pick. */
function VersionSelect({ u, state }: { u: AdminUser; state: UsersTabState }) {
  const { t } = useTranslation();
  if (!u.assigned_bank_id) return null;
  const versions = state.versionsByBank[u.assigned_bank_id];
  return (
    <Select
      size="small"
      aria-label={t("admin.users.bankVersion")}
      data-testid={`user-assign-version-${u.username}`}
      value={u.assigned_bank_version_id ?? ""}
      onChange={(_, d) => void state.assign(u, { bank_version_id: d.value || null })}
    >
      {/* Until the bank's versions load (or if loading failed), still name the assigned version
          instead of rendering an empty box. */}
      {!versions && u.assigned_bank_version_id && (
        <option value={u.assigned_bank_version_id}>{`v${u.assigned_bank_version_no ?? "?"}`}</option>
      )}
      {/* A bank never published has no version: its interviews read the current draft. */}
      {versions?.length === 0 && <option value="">{t("admin.versionNeverPublished")}</option>}
      {(versions ?? []).map((v) => (
        <option key={v.id} value={v.id}>
          {t(v.is_latest ? "admin.users.versionLatest" : "admin.users.versionOption", {
            no: v.version_no,
            date: v.created_at ? v.created_at.slice(0, 10) : "",
          })}
        </option>
      ))}
    </Select>
  );
}

export function UsersTab({ state }: { state: UsersTabState }) {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const { users, usersLoading, usersError } = state;
  // Only a candidate seat (role "user") is assigned an interviewer and a bank.
  const candidate = (u: AdminUser) => u.role === "user";
  const columns: DataColumn<AdminUser>[] = [
    { id: "username", header: t("admin.users.colUsername"), text: (u) => u.username, cell: (u) => u.username },
    { id: "role", header: t("admin.users.colRole"), text: (u) => u.role, cell: (u) => u.role },
    {
      id: "status",
      header: t("admin.users.colStatus"),
      text: (u) => statusText(u),
      cell: (u) => statusText(u),
    },
    { id: "password", header: t("admin.users.colPassword"), width: 240, cell: (u) => <PasswordCell u={u} state={state} /> },
    {
      id: "interviewer",
      header: t("admin.users.colInterviewer"),
      width: 220,
      cell: (u) => (candidate(u) ? <PersonaSelect u={u} state={state} /> : null),
    },
    {
      id: "bank",
      header: t("admin.users.colBank"),
      width: 260,
      cell: (u) => (candidate(u) ? <BankSelect u={u} state={state} /> : null),
    },
    {
      id: "version",
      header: t("admin.users.bankVersion"),
      width: 200,
      cell: (u) =>
        candidate(u) ? (
          <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS }}>
            <VersionSelect u={u} state={state} />
            <AssignStatus u={u} state={state} />
          </div>
        ) : null,
    },
  ];
  function statusText(u: AdminUser) {
    return u.is_active ? t("admin.users.statusActive") : t("admin.users.statusInactive");
  }

  return (
    <Card className={styles.card} data-testid="users-tab">
      <CardHeader header={<Title3>{t("admin.users.tab")}</Title3>} />
      <div style={{ padding: "0 16px 16px" }}>
        <Body1 style={{ display: "block", marginBottom: 12 }}>{t("admin.users.hint")}</Body1>
        {usersLoading && <Text data-testid="users-loading">{t("admin.users.loading")}</Text>}
        {usersError && (
          <Body1 role="alert" className={styles.errorText} data-testid="users-error">
            {t("admin.users.loadError", { message: usersError })}
          </Body1>
        )}
        {!usersLoading && !usersError && (
          <DataTable
            testId="users-table"
            items={users}
            getRowId={(u) => u.id}
            rowProps={(u) => ({ "data-testid": `user-row-${u.username}` })}
            columns={columns}
          />
        )}
      </div>
    </Card>
  );
}
