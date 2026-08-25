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
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  getReport,
  getReview,
  resumeInterview,
  startInterview,
  submitAnswer,
  type AnsweredQuestion,
  type Interview,
  type Report,
} from "../api/client";
import { MicAccessError, useInterviewVoice } from "../hooks/useInterviewVoice";
import type { AudioState, TranscriptSegment } from "../types/voice";
import { AvatarView } from "../components/AvatarView";
import { QuestionProgress } from "../components/QuestionProgress";
import { MicPermissionDialog } from "../components/MicPermissionDialog";
import { Transcript } from "../components/Transcript";
import { ReportView } from "../components/ReportView";
import { ReviewView } from "../components/ReviewView";

// "review" (requirement 4): once all questions are answered the interview is `completed` but NOT
// scored — the candidate reviews every answer and must explicitly submit before scoring starts.
type Phase = "idle" | "orientation" | "interviewing" | "review" | "scoring" | "scored";
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
  // Status legend under the header: the four voice states shown side-by-side as tip cards, so the
  // candidate can read what each state means AND see which one is live right now (the active card is
  // lifted out of the dimmed row). Educational + a live indicator in one strip.
  statusLegend: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    maxWidth: "1400px",
    margin: "0 auto",
    marginBottom: tokens.spacingVerticalL,
  },
  statusItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalS,
    flex: "1 1 200px",
    minWidth: "180px",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    // Inactive states recede; the active one is restored to full presence below.
    opacity: 0.55,
    transition: "opacity 200ms ease, border-color 200ms ease, box-shadow 200ms ease",
  },
  statusItemActive: {
    opacity: 1,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    boxShadow: tokens.shadow4,
    background: tokens.colorNeutralBackground1,
  },
  statusDot: {
    flexShrink: 0,
    width: "10px",
    height: "10px",
    borderRadius: tokens.borderRadiusCircular,
    marginTop: "5px",
  },
  statusTextCol: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  statusItemLabel: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  statusItemTip: { color: tokens.colorNeutralForeground3, lineHeight: tokens.lineHeightBase200 },
  // Full-width stage for the live Q&A: a title, a global top bar, then a two-column body.
  stageWrap: {
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXXL}`,
    boxSizing: "border-box",
    width: "100%",
    // Pin to the viewport height (not just a min) so the stage + transcript stay ON screen: the
    // grid gets a bounded height to divide, the transcript scrolls internally, and neither the
    // avatar video nor a long dialogue can push the top bar off-screen or balloon the page.
    height: "calc(100vh - 56px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  // Global top bar (P11 rule #3): progress + live voice state + channel switch, spanning the full
  // width above both columns. Frosted-glass surface so it reads as a control strip, not content.
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
    width: "100%",
    maxWidth: "1400px",
    margin: "0 auto",
    marginBottom: tokens.spacingVerticalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    boxSizing: "border-box",
    borderRadius: tokens.borderRadiusXLarge,
    background: "linear-gradient(135deg, rgba(124,58,237,0.10) 0%, rgba(168,85,247,0.05) 100%)",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backdropFilter: "blur(10px)",
    boxShadow: tokens.shadow4,
  },
  topBarSlot: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, minWidth: 0 },
  // The progress slot grows to fill the bar so the rail spreads across the whole row; the channel
  // switch on the right keeps its natural width.
  topBarGrow: { flex: 1, minWidth: "240px" },
  topBarRight: { justifyContent: "flex-end", flexShrink: 0 },
  // Segmented text/voice switch — one pill, two halves.
  segmented: {
    display: "inline-flex",
    padding: "3px",
    gap: "2px",
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  segBtn: { borderRadius: tokens.borderRadiusCircular, minWidth: "84px" },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 3fr) minmax(380px, 2fr)",
    gap: tokens.spacingHorizontalXXL,
    alignItems: "stretch",
    width: "100%",
    maxWidth: "1400px",
    margin: "0 auto",
    flex: 1,
    minHeight: 0,
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  // Left: the dark "stage" the digital human / orb sits on.
  stage: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    // Adapt to the grid's height (bounded by the viewport-height stageWrap) instead of a fixed
    // 560px that forced the stage taller than the screen. minHeight:0 lets flex shrink it.
    minHeight: 0,
    height: "100%",
    // border-box so the vertical padding is INCLUDED in height:100% — otherwise the stage renders
    // (row height + 40px padding), overflowing the viewport (cropping the figure's legs) and
    // standing 40px taller than the right column. With border-box it matches the column exactly.
    boxSizing: "border-box",
    borderRadius: tokens.borderRadiusXLarge,
    // Layered deep-violet: a soft radial spotlight on top of a diagonal night gradient, so the
    // digital human sits in a pool of light rather than a flat panel.
    background:
      "radial-gradient(120% 90% at 50% 18%, rgba(124,58,237,0.28) 0%, rgba(124,58,237,0) 55%), " +
      "linear-gradient(160deg, #121327 0%, #1c1d3a 55%, #291a44 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), 0 18px 48px -24px rgba(41,26,68,0.8)",
    overflow: "hidden",
    padding: tokens.spacingVerticalXL,
    "@media (max-width: 900px)": { minHeight: "360px" },
  },
  stageAvatar: { width: "100%", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  // Right: the control column — a flex column so the transcript can grow to fill leftover height.
  controls: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    minWidth: 0,
    minHeight: 0,
  },
  questionCard: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  questionEyebrow: {
    color: tokens.colorBrandForeground1,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  questionText: {
    fontSize: tokens.fontSizeBase600,
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
  },
  // Wrapper that lets the transcript flex-grow and scroll internally (auto-fit, no fixed height).
  transcriptFill: { flex: 1, minHeight: "120px", display: "flex", flexDirection: "column" },
  fallbackNote: {
    display: "block",
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  voiceControls: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  voiceButtons: { display: "flex", gap: tokens.spacingHorizontalS },
});

/** Dot color per state for the status legend, matching each state's semantic hue. */
const STATUS_DOT_COLOR: Record<AudioState, string> = {
  idle: tokens.colorBrandForeground1,
  listening: tokens.colorPaletteBlueForeground2,
  speaking: tokens.colorPaletteGreenForeground1,
  muted: tokens.colorNeutralForeground3,
};

/** Order the four states read left-to-right in the legend. */
const STATUS_ORDER: AudioState[] = ["idle", "listening", "speaking", "muted"];

export function InterviewPage() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [interview, setInterview] = useState<Interview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  // The pre-scoring review list (requirement 4): every answered question + answer, in bank order,
  // fetched from the backend so it survives a reload and matches exactly what gets scored.
  const [reviewAnswers, setReviewAnswers] = useState<AnsweredQuestion[]>([]);
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
  // Remember the question count seen during the interview: `current_question` (and its `total`) is
  // null once the interview completes, so the scoring-progress copy would otherwise show "/ 0".
  // We latch the last-known total here and fall back to it (then the report's actual count).
  const questionTotalRef = useRef(0);
  if (interview?.current_question?.total) {
    questionTotalRef.current = interview.current_question.total;
  }
  // The avatar video element the voice hook attaches a digital-human track to (F5/F9).
  const avatarVideoRef = useRef<HTMLVideoElement | null>(null);
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
        // Requirement 4: all questions answered → do NOT auto-score. Drop into the review phase so
        // the candidate can read every answer back and explicitly submit. Release the mic eagerly —
        // there is no more voice interaction until (and unless) a new interview starts.
        await voice.disconnect().catch(() => undefined);
        const review = await getReview(iv.interview_session_id);
        setReviewAnswers(review.answers);
        setPhase("review");
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

  // Voice "I'm done answering" (P13): commitAnswer() resolves THIS turn's finalized transcript once
  // the async STT round-trip lands (and after it's been emitted to the panel), so we never submit a
  // stale/empty answer or shift answers by one question (the report-misalignment race). Option A —
  // use the promise's resolved value, never the `segments` closure.
  const onVoiceDone = () =>
    guard(async () => {
      const iv = interviewRef.current;
      if (!iv) return;
      const spoken = await voice.commitAnswer();
      if (!spoken.trim()) {
        // Requirement 3: an empty answer cannot pass. Don't advance — let the candidate speak again.
        setError(t("voice.emptyAnswer"));
        return;
      }
      const updated = await submitAnswer(iv.interview_session_id, spoken, "voice");
      await advanceOrComplete(updated);
    });

  // Requirement 4: scoring only begins when the candidate explicitly submits from the review screen.
  // `sopCoverageCheck` (feature D opt-in, default off) rides through to the report request; on, it
  // adds the advisory SOP-coverage audit to the report without touching any score.
  const onSubmitForScoring = (sopCoverageCheck: boolean) =>
    guard(async () => {
      const iv = interviewRef.current;
      if (!iv) return;
      setPhase("scoring");
      const r = await getReport(iv.interview_session_id, sopCoverageCheck);
      setReport(r);
      setPhase("scored");
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
  // Denominator: the report's real per-question count once it's back, else the total we latched
  // during the interview (current_question is null in the scoring phase, so q.total is gone).
  // Scoring is one batch call (no per-answer streaming), so the numerator just reads 1 there.
  const scoringTotal = report?.per_question.length || questionTotalRef.current || 1;
  const scoringNarr = t("transition.scoring", {
    n: Math.min((q?.index ?? 0) + 1, scoringTotal),
    total: scoringTotal,
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

  // The channel switch (text/voice) — a segmented pill that lives in the global top bar.
  const channelSwitch = (
    <div className={styles.segmented} role="tablist" aria-label={t("voice.useVoice")}>
      <Button
        className={styles.segBtn}
        size="small"
        appearance={channel === "text" ? "primary" : "subtle"}
        onClick={() => setChannel("text")}
      >
        {t("voice.useText")}
      </Button>
      {/* Never permanently disabled: a transient failure (proxy hiccup, network blip) must stay
          retryable — startVoice clears voiceUnavailable on a successful reconnect. */}
      <Button
        className={styles.segBtn}
        size="small"
        appearance={channel === "voice" ? "primary" : "subtle"}
        onClick={startVoice}
      >
        {t("voice.useVoice")}
      </Button>
    </div>
  );

  // The answer controls (question card + text/voice answer). The question card fills its own space;
  // the transcript below it flex-grows. Progress + status + channel switch now live in the top bar.
  const answerControls = q && (
    <Card className={styles.questionCard}>
      <CardHeader
        header={
          <Text size={200} weight="semibold" className={styles.questionEyebrow}>
            {t("questionProgress", { index: q.index + 1, total: q.total })}
          </Text>
        }
      />
      <Body1 as="p" className={styles.questionText}>
        {q.prompt}
      </Body1>

      {voiceUnavailable && (
        <Text size={200} className={styles.fallbackNote}>
          {t("voice.endedFallback")}
        </Text>
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

  // Live Q&A: a global top bar over a full-width two-column stage (avatar left, controls right).
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

          {/* Status legend: describe each state as a tip AND highlight the current one. Shown in
              both channels — in voice mode it tracks the live audio state (listening/speaking/muted);
              in text mode there is no live audio, so the "idle/ready" card stays highlighted as a
              steady reference of what the states mean. */}
          <div
            className={styles.statusLegend}
            role="group"
            aria-label={t("voice.statusLegendLabel")}
            data-testid="voice-status-legend"
          >
            {STATUS_ORDER.map((state) => {
              const active = badgeState === state;
              return (
                <div
                  key={state}
                  className={mergeClasses(styles.statusItem, active && styles.statusItemActive)}
                  data-state={state}
                  data-active={active}
                  aria-current={active ? "true" : undefined}
                >
                  <span
                    className={styles.statusDot}
                    style={{ background: STATUS_DOT_COLOR[state] }}
                    aria-hidden
                  />
                  <span className={styles.statusTextCol}>
                    <Text size={200} className={styles.statusItemLabel}>
                      {t(`voice.${state}`)}
                    </Text>
                    <Text size={100} className={styles.statusItemTip}>
                      {t(`voice.statusTips.${state}`)}
                    </Text>
                  </span>
                </div>
              );
            })}
          </div>

          {/* Global top bar: progress (left) · channel switch (right). The live voice state used to
              sit in the center here, but the status legend above already names AND highlights the
              current state — a second badge was redundant and stole room the question progress needs
              as the question count grows. */}
          <div className={styles.topBar} data-testid="interview-topbar">
            <div className={mergeClasses(styles.topBarSlot, styles.topBarGrow)}>
              <QuestionProgress current={q.index} total={q.total} />
            </div>
            <div className={mergeClasses(styles.topBarSlot, styles.topBarRight)}>{channelSwitch}</div>
          </div>

          <div className={styles.grid}>
            {/* Left: the stage — digital human / orb, dominant. Fills the full grid height so the
                stage + right column stay bottom-aligned and use the whole viewport. The avatar
                video inside is `cover`-fit (see AvatarView) so a 16:9 stream fills a tall stage
                without dark letterbox bands — the surrounding white margin is what gets cropped,
                not the centered figure. */}
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
            </div>

            {/* Right: the control column. Transcript flex-grows to fill the leftover height. */}
            <div className={styles.controls} data-testid="interview-controls">
              {answerControls}
              <div className={styles.transcriptFill}>
                <Transcript segments={segments} />
              </div>
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

        {/* Pre-scoring review (requirement 4): read every answer back, then explicitly submit. */}
        {phase === "review" && (
          <ReviewView answers={reviewAnswers} busy={busy} onSubmit={onSubmitForScoring} />
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
