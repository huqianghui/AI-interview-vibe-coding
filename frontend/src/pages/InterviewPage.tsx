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
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  Spinner,
  Text,
  Textarea,
  Title2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  getReport,
  resumeInterview,
  startInterview,
  submitAnswer,
  type Interview,
  type Report,
} from "../api/client";
import { MicAccessError, useInterviewVoice } from "../hooks/useInterviewVoice";
import { collectVoiceAnswer } from "./interviewVoiceAnswer";
import type { AudioState, TranscriptSegment } from "../types/voice";
import { AvatarView } from "../components/AvatarView";
import { QuestionProgress } from "../components/QuestionProgress";
import { MicPermissionDialog } from "../components/MicPermissionDialog";
import { Transcript } from "../components/Transcript";
import { ReportView } from "../components/ReportView";

type Phase = "idle" | "orientation" | "interviewing" | "scoring" | "scored";
type Channel = "text" | "voice";

const useStyles = makeStyles({
  // Centered container for the non-live phases (idle / orientation / scoring / report).
  page: { maxWidth: "760px", margin: "0 auto", padding: "24px" },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalL,
  },
  // Full-width two-column stage for the live Q&A.
  stageWrap: {
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXXL}`,
    boxSizing: "border-box",
    width: "100%",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 3fr) minmax(360px, 2fr)",
    gap: tokens.spacingHorizontalXXL,
    alignItems: "stretch",
    maxWidth: "1400px",
    margin: "0 auto",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  // Left: the dark "stage" the digital human / orb sits on.
  stage: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "560px",
    borderRadius: tokens.borderRadiusXLarge,
    background: "linear-gradient(160deg, #14162b 0%, #1f2140 60%, #2a1f45 100%)",
    overflow: "hidden",
    padding: tokens.spacingVerticalXL,
    "@media (max-width: 900px)": { minHeight: "360px" },
  },
  stageAvatar: { width: "100%", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  // Status pill overlaid at the bottom of the stage.
  statusOverlay: {
    position: "absolute",
    bottom: tokens.spacingVerticalL,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 20,
  },
  // Right: the control column.
  controls: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    minWidth: 0,
  },
  questionCard: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  questionText: { fontSize: tokens.fontSizeBase500, lineHeight: tokens.lineHeightBase500 },
  channelRow: { display: "flex", gap: tokens.spacingHorizontalS },
  voiceControls: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  voiceButtons: { display: "flex", gap: tokens.spacingHorizontalS },
});

/** Fluent Badge color for each voice audio state (status prominence). */
const AUDIO_BADGE_COLOR: Record<AudioState, "informative" | "success" | "subtle" | "brand"> = {
  idle: "brand",
  listening: "informative",
  speaking: "success",
  muted: "subtle",
};

export function InterviewPage() {
  const styles = useStyles();
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
  // The avatar video element the voice hook attaches a digital-human track to (F5/F9).
  const avatarVideoRef = useRef<HTMLVideoElement | null>(null);
  // Final voice-transcript segment ids already POSTed, so a turn with multiple final segments
  // (candidate paused mid-answer) submits ALL of them once — not just the latest (content-loss fix).
  const submittedSegmentIds = useRef<Set<string>>(new Set());
  // The prompt text last spoken aloud in voice mode, so we don't re-speak it on every re-render
  // (keyed on the text so a follow-up on the same question_id is still spoken).
  const spokenQuestionId = useRef<string | null>(null);

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
    videoRef: avatarVideoRef,
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
      // ALL of this turn's not-yet-submitted final user segments join into the answer (content-loss
      // fix); mark them submitted so the next turn starts clean.
      const { text: spoken, ids } = collectVoiceAnswer(segments, submittedSegmentIds.current);
      ids.forEach((id) => submittedSegmentIds.current.add(id));
      const updated = await submitAnswer(iv.interview_session_id, spoken, "voice");
      await advanceOrComplete(updated);
    });

  const startVoice = useCallback(async () => {
    setChannel("voice");
    setMicDialogOpen(false);
    try {
      await voice.connect(i18n.language);
      setVoiceUnavailable(false); // a successful (re)connect clears a prior transient failure
    } catch (err) {
      if (err instanceof MicAccessError) {
        setMicRetried((prev) => prev || micDialogOpen);
        setMicDialogOpen(true);
      } else {
        // P5/P6b: any non-mic failure (agent not synced, voice off, WS proxy unreachable — the
        // WS transport rejects with a plain Error, not only VoiceSessionError) → stay on text.
        setVoiceUnavailable(true);
        setChannel("text");
      }
    }
  }, [voice, i18n.language, micDialogOpen]);

  // Resume an in-progress interview on mount (edge b): a reload lands back on the pending question
  // instead of stranding it behind a fresh /start. No saved/live interview → stay on the idle
  // screen. Runs once.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const iv = await resumeInterview();
        if (active && iv) {
          setInterview(iv);
          setPhase("interviewing");
        }
      } catch {
        /* nothing resumable — idle screen */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Tear down the voice connection when the page unmounts (mic + WebRTC + signaling socket).
  useEffect(() => {
    return () => {
      void voice.disconnect().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Self-heal the voice UI: if the session (re)connects while the page still shows the
  // voice-unavailable fallback (e.g. an error fired mid-reconnect but a later attempt succeeded),
  // clear the notice and return to voice — a LIVE session must never sit behind "语音不可用".
  useEffect(() => {
    if (voice.connectionState === "connected" && voiceUnavailable) {
      setVoiceUnavailable(false);
      setChannel("voice");
    }
  }, [voice.connectionState, voiceUnavailable]);

  // Voice mode: speak the backend-authoritative question text (Phase 4 voice→turn sub-design).
  // When a new prompt is current and voice is connected, have Voice Live read it verbatim rather
  // than let the agent autonomously generate — the backend keeps the question pointer. Keyed on the
  // prompt TEXT, not question_id, so a follow-up (same question_id, new prompt) is spoken too.
  const currentPrompt = interview?.current_question?.prompt ?? "";
  useEffect(() => {
    if (
      channel === "voice" &&
      voice.connectionState === "connected" &&
      currentPrompt &&
      spokenQuestionId.current !== currentPrompt
    ) {
      if (voice.speakQuestion(currentPrompt)) {
        spokenQuestionId.current = currentPrompt;
      }
    }
  }, [channel, voice, currentPrompt]);

  const q = interview?.current_question ?? null;
  const scoringNarr = t("transition.scoring", {
    n: (q?.index ?? 0) + 1,
    total: q?.total ?? report?.per_question.length ?? 0,
  });

  const errorBanner = error && (
    <Body1 role="alert" style={{ display: "block", marginTop: 16, color: "#b00" }}>
      {error}
    </Body1>
  );

  const micDialog = (
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
  );

  // The answer controls (question card, channel switch, text/voice answer) — shared by both layouts.
  const answerControls = q && (
    <Card className={styles.questionCard}>
      <CardHeader
        header={
          <Text weight="semibold">
            {t("questionProgress", { index: q.index + 1, total: q.total })}
          </Text>
        }
      />
      <Body1 as="p" className={styles.questionText}>
        {q.prompt}
      </Body1>

      {/* Channel switch */}
      <div className={styles.channelRow}>
        <Button
          appearance={channel === "text" ? "primary" : "secondary"}
          onClick={() => setChannel("text")}
        >
          {t("voice.useText")}
        </Button>
        {/* Never permanently disabled: a transient failure (proxy hiccup, network blip) must stay
            retryable — startVoice clears voiceUnavailable on a successful reconnect. */}
        <Button
          appearance={channel === "voice" ? "primary" : "secondary"}
          onClick={startVoice}
        >
          {t("voice.useVoice")}
        </Button>
      </div>

      {voiceUnavailable && (
        <Body1 style={{ display: "block", opacity: 0.7 }}>{t("voice.endedFallback")}</Body1>
      )}

      {channel === "text" && (
        <>
          <Textarea
            value={answer}
            placeholder={t("answerPlaceholder")}
            onChange={(_, d) => setAnswer(d.value)}
            resize="vertical"
          />
          <div>
            <Button appearance="primary" disabled={busy || !answer.trim()} onClick={onSubmitText}>
              {busy ? t("submitting") : t("submit")}
            </Button>
          </div>
        </>
      )}

      {channel === "voice" && (
        <div className={styles.voiceControls}>
          {voice.connectionState === "connecting" && <Text>{t("voice.connecting")}</Text>}
          {voice.connectionState === "reconnecting" && (
            <Text style={{ opacity: 0.7 }}>{t("voice.reconnecting")}</Text>
          )}
          {voice.audioState === "listening" && (
            <Text size={200} style={{ opacity: 0.7 }}>
              {t("voice.stillListening")}
            </Text>
          )}
          <div className={styles.voiceButtons}>
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
  );

  // Live Q&A: full-width two-column stage (avatar dominant left, controls right).
  if (phase === "interviewing" && q) {
    const voiceActive = channel === "voice";
    const badgeState: AudioState = voiceActive ? voice.audioState : "idle";
    return (
      <>
        <div className={styles.stageWrap}>
          <div className={styles.header}>
            <Title2 as="h1">{t("appTitle")}</Title2>
            <Body1 style={{ opacity: 0.7 }}>{t("tagline")}</Body1>
          </div>
          <div className={styles.grid}>
            {/* Left: the stage — digital human / orb, dominant. */}
            <div className={styles.stage} data-testid="interview-stage">
              <div className={styles.stageAvatar}>
                {/* Once the digital human is streaming, keep it visible — do NOT gate on the
                    channel tab. Gating on voiceActive hid a LIVE avatar the moment the candidate
                    peeked at the text tab (the "出现了又消失" symptom); the stream itself is
                    unaffected by the tab, so visibility follows only the actual video state. */}
                <AvatarView
                  ref={avatarVideoRef}
                  audioState={badgeState}
                  isAvatarConnected={voice.isAvatarConnected}
                />
              </div>
              {voiceActive && (
                <div className={styles.statusOverlay}>
                  <Badge
                    size="large"
                    appearance="filled"
                    color={AUDIO_BADGE_COLOR[badgeState]}
                    data-testid="voice-status-badge"
                  >
                    {t(`voice.${badgeState}`)}
                  </Badge>
                </div>
              )}
            </div>

            {/* Right: the control column. */}
            <div className={styles.controls} data-testid="interview-controls">
              <QuestionProgress current={q.index} total={q.total} />
              {answerControls}
              <Transcript segments={segments} />
            </div>
          </div>
          {errorBanner}
        </div>
        {micDialog}
      </>
    );
  }

  // All non-live phases: a centered, readable column.
  return (
    <>
      <div className={styles.page}>
        <div className={styles.header}>
          <Title2 as="h1">{t("appTitle")}</Title2>
          <Body1 style={{ display: "block", opacity: 0.7 }}>{t("tagline")}</Body1>
        </div>

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

        {/* Edge (a): an interview with no question to show (empty bank / defensive backend null).
            A defined end state, not a blank page — never leave the candidate on a broken screen. */}
        {(phase === "orientation" || phase === "interviewing") && !q && (
          <Card>
            <CardHeader header={<Text weight="semibold">{t("noQuestions.title")}</Text>} />
            <Body1 style={{ display: "block" }}>{t("noQuestions.body")}</Body1>
          </Card>
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

        {phase === "scored" && report && <ReportView report={report} />}

        {errorBanner}
      </div>
      {micDialog}
    </>
  );
}
