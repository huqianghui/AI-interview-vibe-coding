/**
 * Shared sign-in card (#102) — extracted from AdminPage so the candidate login gate (InterviewPage)
 * and the admin login gate render the identical Fluent structure + behavior (Enter-to-submit,
 * disabled-while-busy, inline error) instead of two copies drifting apart. The username/password
 * placeholder + button copy reuse the existing generic `admin.*` i18n strings — they read
 * "Username" / "Password" / "Sign in" regardless of which page renders the card. Callers supply the
 * page-specific title/body copy and a `testIdPrefix` so existing tests/E2E keep their exact
 * `${prefix}-username-input` / `${prefix}-password-input` / `${prefix}-login` targets.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Body1, Button, Input, Title2, makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  loginPage: { maxWidth: "420px", margin: "0 auto", padding: "24px" },
  errorText: { color: tokens.colorPaletteRedForeground1 },
});

export interface LoginCardProps {
  title: string;
  body: string;
  error: string | null;
  busy: boolean;
  onSubmit: (username: string, password: string) => void;
  testIdPrefix: string;
  /** Heading level for the card title — "h2" when the page already renders its own h1. */
  titleAs?: "h1" | "h2";
}

export function LoginCard({
  title,
  body,
  error,
  busy,
  onSubmit,
  testIdPrefix,
  titleAs = "h1",
}: LoginCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = () => onSubmit(username.trim(), password);

  return (
    <div className={styles.loginPage}>
      <Title2 as={titleAs}>{title}</Title2>
      <Body1 style={{ display: "block", margin: "12px 0" }}>{body}</Body1>
      <Input
        value={username}
        placeholder={t("admin.username")}
        onChange={(_, d) => setUsername(d.value)}
        disabled={busy}
        style={{ width: "100%", marginBottom: 8 }}
        data-testid={`${testIdPrefix}-username-input`}
      />
      <Input
        type="password"
        value={password}
        placeholder={t("admin.password")}
        onChange={(_, d) => setPassword(d.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        disabled={busy}
        style={{ width: "100%" }}
        data-testid={`${testIdPrefix}-password-input`}
      />
      <div style={{ marginTop: 12 }}>
        <Button
          appearance="primary"
          onClick={submit}
          disabled={busy}
          data-testid={`${testIdPrefix}-login`}
        >
          {t("admin.login")}
        </Button>
      </div>
      {error && (
        <Body1 role="alert" className={styles.errorText} style={{ display: "block", marginTop: 12 }}>
          {error}
        </Body1>
      )}
    </div>
  );
}
