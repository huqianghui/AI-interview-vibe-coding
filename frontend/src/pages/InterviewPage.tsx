/**
 * Interview page — Step 0 thin slice (text channel).
 *
 * Proves the ask → answer → placeholder-report loop end to end against the backend state
 * machine. Voice / digital-human components (F5/F9) slot in later behind the same
 * answer_finalized flow; this page uses source="text" only.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Spinner,
  Text,
  Textarea,
  Title2,
} from "@fluentui/react-components";
import {
  getReport,
  startInterview,
  submitAnswer,
  type Interview,
  type Report,
} from "../api/client";

type Phase = "idle" | "interviewing" | "scored";

export function InterviewPage() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [interview, setInterview] = useState<Interview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const onStart = () =>
    guard(async () => {
      const iv = await startInterview();
      setInterview(iv);
      setPhase("interviewing");
    });

  const onSubmit = () =>
    guard(async () => {
      if (!interview) return;
      const iv = await submitAnswer(interview.interview_session_id, answer);
      setInterview(iv);
      setAnswer("");
      if (iv.status === "completed") {
        const r = await getReport(iv.interview_session_id);
        setReport(r);
        setPhase("scored");
      }
    });

  const q = interview?.current_question ?? null;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
      <Title2 as="h1">{t("appTitle")}</Title2>
      <Body1 style={{ display: "block", marginBottom: 24, opacity: 0.7 }}>{t("tagline")}</Body1>

      {phase === "idle" && (
        <Button appearance="primary" disabled={busy} onClick={onStart}>
          {busy ? t("starting") : t("start")}
        </Button>
      )}

      {phase === "interviewing" && q && (
        <Card>
          <CardHeader
            header={
              <Text weight="semibold">
                {t("questionProgress", { index: q.index + 1, total: q.total })}
              </Text>
            }
          />
          <Body1 style={{ display: "block", marginBottom: 12 }}>{q.prompt}</Body1>
          <Textarea
            value={answer}
            placeholder={t("answerPlaceholder")}
            onChange={(_, d) => setAnswer(d.value)}
            resize="vertical"
          />
          <div style={{ marginTop: 12 }}>
            <Button appearance="primary" disabled={busy || !answer.trim()} onClick={onSubmit}>
              {busy ? t("submitting") : t("submit")}
            </Button>
          </div>
        </Card>
      )}

      {phase === "scored" && report && (
        <Card>
          <CardHeader header={<Text weight="semibold">{t("reportTitle")}</Text>} />
          <Body1 style={{ display: "block" }}>
            {t("coverage")}: {report.coverage_pct}%
          </Body1>
          <ul>
            {report.per_question.map((s) => (
              <li key={s.question_id}>
                <Text weight="semibold">{s.question_id}</Text>: {s.judgment} — {s.rationale}
              </li>
            ))}
          </ul>
          {report.is_stub && (
            <Body1 style={{ display: "block", opacity: 0.6 }}>{t("stubNote")}</Body1>
          )}
        </Card>
      )}

      {error && (
        <Body1 role="alert" style={{ display: "block", marginTop: 16, color: "#b00" }}>
          {error}
        </Body1>
      )}

      {busy && phase === "idle" && <Spinner />}
    </div>
  );
}
