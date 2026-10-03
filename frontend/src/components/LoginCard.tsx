/**
 * Shared sign-in card (#102) — extracted from AdminPage so the candidate login gate (InterviewPage)
 * and the admin login gate render the identical Fluent structure + behavior (Enter-to-submit,
 * disabled-while-busy, inline error) instead of two copies drifting apart. The username/password
 * placeholder + button copy reuse the existing generic `admin.*` i18n strings — they read
 * "Username" / "Password" / "Sign in" regardless of which page renders the card. Callers supply the
 * page-specific title/body copy and a `testIdPrefix` so existing tests/E2E keep their exact
 * `${prefix}-username-input` / `${prefix}-password-input` / `${prefix}-login` targets.
 *
 * WIDTH IS NOT DECIDED HERE any more. This card used to carry `maxWidth: 420px; margin: 0 auto`
 * while already sitting inside InterviewPage's own 760px centred column — two nested centred
 * containers, so the page title and this card did not share a left edge (the ragged left margin
 * in the owner's screenshot). The page shell owns the measure now; the card fills what it is given.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Field,
  Input,
  Title2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { fonts, palette } from "../theme";

const useStyles = makeStyles({
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL}`,
  },
  title: {
    display: "block",
    fontFamily: fonts.display,
    fontWeight: 700,
    letterSpacing: "-0.022em",
    color: palette.ink,
  },
  body: {
    display: "block",
    marginBlock: `${tokens.spacingVerticalS} ${tokens.spacingVerticalXL}`,
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase400,
  },
  field: { marginBottom: tokens.spacingVerticalM },
  /** Full-width is intentional HERE (a sign-in form's single action), unlike the orientation
   *  button, which Fluent's Card was stretching by accident. */
  submit: { width: "100%", marginTop: tokens.spacingVerticalS, fontFamily: fonts.display },
  errorText: {
    display: "block",
    marginTop: tokens.spacingVerticalM,
    color: tokens.colorPaletteRedForeground1,
  },
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
  titleAs = "h2",
}: LoginCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = () => onSubmit(username.trim(), password);

  return (
    <div className={styles.card}>
      <Title2 as={titleAs} className={styles.title}>
        {title}
      </Title2>
      <Body1 className={styles.body}>{body}</Body1>

      <Field label={t("admin.username")} className={styles.field}>
        <Input
          value={username}
          placeholder={t("admin.username")}
          onChange={(_, d) => setUsername(d.value)}
          disabled={busy}
          data-testid={`${testIdPrefix}-username-input`}
        />
      </Field>
      <Field label={t("admin.password")} className={styles.field}>
        <Input
          type="password"
          value={password}
          placeholder={t("admin.password")}
          onChange={(_, d) => setPassword(d.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={busy}
          data-testid={`${testIdPrefix}-password-input`}
        />
      </Field>

      <Button
        appearance="primary"
        onClick={submit}
        disabled={busy}
        className={styles.submit}
        data-testid={`${testIdPrefix}-login`}
      >
        {t("admin.login")}
      </Button>

      {error && (
        <Body1 role="alert" className={styles.errorText}>
          {error}
        </Body1>
      )}
    </div>
  );
}
