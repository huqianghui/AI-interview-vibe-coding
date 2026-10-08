/** The admin page's Users tab: hand out a seeded seat's username/password (#102) and assign each
 * user an interviewer and a question bank (#187). Interview results live in their own tab. */
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
  tokens,
} from "@fluentui/react-components";
import type { AdminUser } from "../../api/admin";
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

function AssignmentCells({ u, state }: { u: AdminUser; state: UsersTabState }) {
  const { t } = useTranslation();
  const defaultPersona = state.personas.find((p) => p.is_default && p.enabled);
  const defaultBank = state.banks.find((b) => b.is_default && b.enabled);
  const status = state.assignStatus[u.id];
  // A disabled target stays listed only while it is the one assigned, so the select can show it.
  const personas = state.personas.filter((p) => p.enabled || p.id === u.assigned_persona_id);
  const banks = state.banks.filter((b) => b.enabled || b.bank_id === u.assigned_bank_id);
  return (
    <>
      <TableCell>
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
      </TableCell>
      <TableCell>
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
        {u.assigned_bank_id && (
          <Select
            size="small"
            style={{ marginTop: 4 }}
            aria-label={t("admin.users.rubricVersion")}
            data-testid={`user-assign-version-${u.username}`}
            value={u.assigned_rubric_version_id ?? ""}
            onChange={(_, d) => void state.assign(u, { rubric_version_id: d.value || null })}
          >
            {(state.versionsByBank[u.assigned_bank_id] ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {t(v.is_latest ? "admin.users.versionLatest" : "admin.users.versionOption", {
                  no: v.version_no,
                  date: v.created_at ? v.created_at.slice(0, 10) : "",
                })}
              </option>
            ))}
          </Select>
        )}
        {status?.kind === "saved" && (
          <Text size={200} style={{ marginLeft: 6 }} data-testid={`user-assign-saved-${u.username}`}>
            {t("admin.users.assignSaved")}
          </Text>
        )}
        {status?.kind === "error" && (
          <Text
            size={200}
            role="alert"
            style={{ marginLeft: 6, color: tokens.colorPaletteRedForeground1 }}
          >
            {t("admin.users.assignError", { message: status.message })}
          </Text>
        )}
      </TableCell>
    </>
  );
}

export function UsersTab({ state }: { state: UsersTabState }) {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const { users, usersLoading, usersError } = state;

  return (
    <Card className={styles.card} data-testid="users-tab">
      <CardHeader header={<Title3>{t("admin.users.tab")}</Title3>} />
      <div style={{ padding: "0 16px 16px", overflowX: "auto" }}>
        <Body1 style={{ display: "block", marginBottom: 12 }}>{t("admin.users.hint")}</Body1>
        {usersLoading && <Text data-testid="users-loading">{t("admin.users.loading")}</Text>}
        {usersError && (
          <Body1 role="alert" className={styles.errorText} data-testid="users-error">
            {t("admin.users.loadError", { message: usersError })}
          </Body1>
        )}
        {!usersLoading && !usersError && (
          <Table data-testid="users-table">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t("admin.users.colUsername")}</TableHeaderCell>
                <TableHeaderCell>{t("admin.users.colRole")}</TableHeaderCell>
                <TableHeaderCell>{t("admin.users.colStatus")}</TableHeaderCell>
                <TableHeaderCell>{t("admin.users.colPassword")}</TableHeaderCell>
                <TableHeaderCell>{t("admin.users.colInterviewer")}</TableHeaderCell>
                <TableHeaderCell>{t("admin.users.colBank")}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const candidate = u.role === "user";
                return (
                  <Fragment key={u.id}>
                    <TableRow data-testid={`user-row-${u.username}`}>
                      <TableCell>{u.username}</TableCell>
                      <TableCell>{u.role}</TableCell>
                      <TableCell>
                        {u.is_active ? t("admin.users.statusActive") : t("admin.users.statusInactive")}
                      </TableCell>
                      <TableCell>
                        <PasswordCell u={u} state={state} />
                      </TableCell>
                      {candidate ? (
                        <AssignmentCells u={u} state={state} />
                      ) : (
                        <>
                          <TableCell />
                          <TableCell />
                        </>
                      )}
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  );
}
