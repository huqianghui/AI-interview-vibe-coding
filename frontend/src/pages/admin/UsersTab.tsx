/** The admin page's Users tab (#102, read-only): hand out a seeded seat's username/password. */
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
} from "@fluentui/react-components";
import { useAdminStyles } from "./shared";
import type { UsersTabState } from "./useUsersTab";

export function UsersTab({ state }: { state: UsersTabState }) {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const {
    users,
    usersLoading,
    usersError,
    copiedUserId,
    copyPassword,
  } = state;

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
        <Table data-testid="users-table">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t("admin.users.colUsername")}</TableHeaderCell>
              <TableHeaderCell>{t("admin.users.colRole")}</TableHeaderCell>
              <TableHeaderCell>{t("admin.users.colStatus")}</TableHeaderCell>
              <TableHeaderCell>{t("admin.users.colPassword")}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} data-testid={`user-row-${u.username}`}>
                <TableCell>{u.username}</TableCell>
                <TableCell>{u.role}</TableCell>
                <TableCell>
                  {u.is_active ? t("admin.users.statusActive") : t("admin.users.statusInactive")}
                </TableCell>
                <TableCell>
                  {u.password_stale ? (
                    <Text data-testid={`user-password-stale-${u.username}`}>
                      {t("admin.users.passwordStale")}
                    </Text>
                  ) : u.generated_password ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Text
                        style={{ fontFamily: "monospace" }}
                        data-testid={`user-password-${u.username}`}
                      >
                        {u.generated_password}
                      </Text>
                      <Button
                        size="small"
                        data-testid={`user-copy-${u.username}`}
                        onClick={() => copyPassword(u.id, u.generated_password as string)}
                      >
                        {copiedUserId === u.id ? t("admin.users.copied") : t("admin.users.copy")}
                      </Button>
                    </div>
                  ) : (
                    <Text data-testid={`user-password-not-viewable-${u.username}`}>
                      {t("admin.users.notViewable")}
                    </Text>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  </Card>
  );
}
