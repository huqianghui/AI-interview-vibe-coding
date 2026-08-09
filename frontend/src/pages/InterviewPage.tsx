/**
 * Interview page (SPEC F9) — the winning-demo path.
 *
 * Layout hierarchy (P11): (1) avatar/orb dominant, (2) current question pinned & visible without
 * scrolling, (3) question-progress dot-stepper, (4) transcript secondary, (5) sources panel —
 * which is deliberately ABSENT during live Q&A (P12: raw SOP citations are not candidate-facing;
 * they surface in the report phase).
 *
 * Two answer channels converge on the backend's single `answer_finalized(text, source)` event
 * (P9): text submit (`source=text`) and voice (`source=voice`). The candidate always has a manual
 * "I'm done answering" control (P13) and text never stops working, so a denied mic or a dropped
 * voice connection (P6b) degrades gracefully to text instead of blocking the interview.
 *
 * Demo-critical states (P10): a pre-Q1 orientation beat, a per-question transition acknowledgement,
 * a scoring-in-progress screen, and a report-ready reveal.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  Title3,
  tokens,
} from "@fluentui/react-components";
import {
  getReport,
  startInterview,
  submitAnswer,
  VoiceSessionError,
  type Interview,
  type Report,
} from "../api/client";
import { MicAccessError, useInterviewVoice } from "../hooks/useInterviewVoice";
import type { TranscriptSegment } from "../types/voice";
import { AudioOrb } from "../components/AudioOrb";
import { QuestionProgress } from "../components/QuestionProgress";
import { MicPermissionDialog } from "../components/MicPermissionDialog";
import { Transcript } from "../components/Transcript";

type Phase = "idle" | "orientation" | "interviewing" | "scoring" | "scored";
type Channel = "text" | "voice";

export function InterviewPage() {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [interview, setInterview] = useState<Interview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>("text");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [micDialogOpen, setMicDialogOpen] = useState(false);
  const [micRetried, setMicRetried] = useState(false);
  const [voiceUnavailable, setVoiceUnavailable] = useState(false);

  const interviewRef = useRef<Interview | null>(null);
  interviewRef.current = interview;

  const onTranscript = useCallback((seg: TranscriptSegment) => {
    setSegments((prev) => {
      const idx = prev.findIndex((s) => s.id === seg.id);
      if (idx === -1) return [...prev, seg];
      const next = [...prev];
      next[idx] = seg;
      return next;
    });
  }, []);

  const voice = useInterviewVoice(interview?.interview_session_id ?? "", {
    locale: i18n.language,
    onTranscript,
    onError: (err) => {
      // A mic failure opens the permission dialog; anything else falls the page back to text.
      if (err instanceof MicAccessError) {
        setMicDialogOpen(true);
      } else {
        setVoiceUnavailable(true);
        setChannel("text");
      }
    },
  });

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
      setPhase("orientation");
    });

  const advanceOrComplete = useCallback(
    async (iv: Interview) => {
      setInterview(iv);
      setAnswer("");
      if (iv.status === "completed") {
        // Scoring-in-progress beat (P10) before the report reveal.
        setPhase("scoring");
        await voice.disconnect().catch(() => undefined);
        const r = await getReport(iv.interview_session_id);
        setReport(r);
        setPhase("scored");
      }
    },
    [voice],
  );

  const onSubmitText = () =>
    guard(async () => {
      const iv = interviewRef.current;
      if (!iv) return;
      const updated = await submitAnswer(iv.interview_session_id, answer, "text");
      await advanceOrComplete(updated);
    });

  // Voice "I'm done answering" (P13): the transcript of this turn is the finalized answer.
  const onVoiceDone = () =>
    guard(async () => {
      const iv = interviewRef.current;
      if (!iv) return;
      voice.commitAnswer();
      // The candidate's spoken words for this turn (latest final user segment) become the answer.
      const spoken = [...segments].reverse().find((s) => s.role === "user" && s.isFinal);
      const updated = await submitAnswer(
        iv.interview_session_id,
        spoken?.content ?? "",
        "voice",
      );
      await advanceOrComplete(updated);
    });

  const startVoice = useCallback(async () => {
    setChannel("voice");
    setMicDialogOpen(false);
    try {
      await voice.connect(i18n.language);
    } catch (err) {
      if (err instanceof MicAccessError) {
        setMicRetried((prev) => prev || micDialogOpen);
        setMicDialogOpen(true);
      } else if (err instanceof VoiceSessionError) {
        // P5/P6b: agent not synced (409) or voice off (503) — stay on text, tell the candidate.
        setVoiceUnavailable(true);
        setChannel("text");
      }
    }
  }, [voice, i18n.language, micDialogOpen]);

  // Tear down the voice connection when the page unmounts (mic + WebRTC + signaling socket).
  useEffect(() => {
    return () => {
      void voice.disconnect().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = interview?.current_question ?? null;
  const scoringNarr = t("transition.scoring", {
    n: (q?.index ?? 0) + 1,
    total: q?.total ?? report?.per_question.length ?? 0,
  });

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <Title2 as="h1">{t("appTitle")}</Title2>
      <Body1 style={{ display: "block", marginBottom: 24, opacity: 0.7 }}>{t("tagline")}</Body1>

      {phase === "idle" && (
        <Button appearance="primary" disabled={busy} onClick={onStart}>
          {busy ? t("starting") : t("start")}
        </Button>
      )}

      {/* Orientation beat (P13): set expectations before Q1. */}
      {phase === "orientation" && q && (
        <Card>
          <CardHeader header={<Text weight="semibold">{t("orientation.title")}</Text>} />
          <Body1 style={{ display: "block", marginBottom: 16 }}>
            {t("orientation.body", { total: q.total })}
          </Body1>
          <Button appearance="primary" onClick={() => setPhase("interviewing")}>
            {t("orientation.begin")}
          </Button>
        </Card>
      )}

      {phase === "interviewing" && q && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* (1) avatar dominant */}
          <div style={{ padding: "24px 0" }}>
            <AudioOrb audioState={channel === "voice" ? voice.audioState : "idle"} />
          </div>

          {/* (3) progress */}
          <QuestionProgress current={q.index} total={q.total} />

          {/* (2) current question pinned */}
          <Card>
            <CardHeader
              header={
                <Text weight="semibold">
                  {t("questionProgress", { index: q.index + 1, total: q.total })}
                </Text>
              }
            />
            <Body1 style={{ display: "block", marginBottom: 12 }}>{q.prompt}</Body1>

            {/* Channel switch */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Button
                appearance={channel === "text" ? "primary" : "secondary"}
                onClick={() => setChannel("text")}
              >
                {t("voice.useText")}
              </Button>
              <Button
                appearance={channel === "voice" ? "primary" : "secondary"}
                disabled={voiceUnavailable}
                onClick={startVoice}
              >
                {t("voice.useVoice")}
              </Button>
            </div>

            {voiceUnavailable && (
              <Body1 style={{ display: "block", marginBottom: 12, opacity: 0.7 }}>
                {t("voice.endedFallback")}
              </Body1>
            )}

            {channel === "text" && (
              <>
                <Textarea
                  value={answer}
                  placeholder={t("answerPlaceholder")}
                  onChange={(_, d) => setAnswer(d.value)}
                  resize="vertical"
                />
                <div style={{ marginTop: 12 }}>
                  <Button
                    appearance="primary"
                    disabled={busy || !answer.trim()}
                    onClick={onSubmitText}
                  >
                    {busy ? t("submitting") : t("submit")}
                  </Button>
                </div>
              </>
            )}

            {channel === "voice" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {voice.connectionState === "connecting" && <Text>{t("voice.connecting")}</Text>}
                {voice.connectionState === "reconnecting" && (
                  <Text style={{ opacity: 0.7 }}>{t("voice.reconnecting")}</Text>
                )}
                {voice.audioState === "listening" && (
                  <Text size={200} style={{ opacity: 0.7 }}>
                    {t("voice.stillListening")}
                  </Text>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <Button onClick={voice.toggleMute}>
                    {voice.isMuted ? t("voice.unmute") : t("voice.mute")}
                  </Button>
                  {/* Manual end-of-answer control (P13) */}
                  <Button
                    appearance="primary"
                    disabled={busy || voice.connectionState !== "connected"}
                    onClick={onVoiceDone}
                  >
                    {t("voice.imDone")}
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* (4) transcript secondary — (5) sources panel intentionally omitted during live Q&A (P12) */}
          <Transcript segments={segments} />
        </div>
      )}

      {/* Scoring-in-progress beat (P10) */}
      {phase === "scoring" && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
            <Spinner size="small" />
            <Text>{scoringNarr}</Text>
          </div>
        </Card>
      )}

      {phase === "scored" && report && (
        <Card>
          <CardHeader
            header={
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <Text weight="semibold" style={{ color: tokens.colorPaletteGreenForeground1 }}>
                  {t("transition.reportReady")}
                </Text>
                <Title3>{t("reportTitle")}</Title3>
              </div>
            }
          />
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

      <MicPermissionDialog
        open={micDialogOpen}
        onOpenChange={setMicDialogOpen}
        onRetry={startVoice}
        onUseTextInstead={() => {
          setChannel("text");
          setMicDialogOpen(false);
        }}
        stillDenied={micRetried}
      />
    </div>
  );
}
