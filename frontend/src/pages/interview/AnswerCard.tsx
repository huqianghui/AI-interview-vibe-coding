/** The current question and the candidate's answer controls (text or voice). External turns carry no
 * question count (total = 0), so they show the prompt without an "of N" denominator; bank questions
 * keep the "Question X of N" eyebrow. */
import { useTranslation } from "react-i18next";
import { Body1, Button, Card, CardHeader, Spinner, Text, Textarea } from "@fluentui/react-components";
import type { Question } from "../../api/client";
import type { useInterviewVoice } from "../../hooks/useInterviewVoice";
import type { Channel } from "./ChannelSwitch";
import { ExternalRecovery } from "./ExternalRecovery";
import { useInterviewStyles } from "./styles";

type InterviewVoice = ReturnType<typeof useInterviewVoice>;

export interface AnswerCardProps {
  q: Question;
  isExternal: boolean;
  externalStalled: boolean;
  busy: boolean;
  channel: Channel;
  voice: InterviewVoice;
  voiceUnavailable: boolean;
  voiceErrorDetail: string | null;
  nudgeText: string | null;
  answer: string;
  onAnswerChange: (text: string) => void;
  onSubmitText: () => void;
  onVoiceDone: () => void;
  onRecover: () => void;
}

export function AnswerCard({
  q,
  isExternal,
  externalStalled,
  busy,
  channel,
  voice,
  voiceUnavailable,
  voiceErrorDetail,
  nudgeText,
  answer,
  onAnswerChange,
  onSubmitText,
  onVoiceDone,
  onRecover,
}: AnswerCardProps) {
  const styles = useInterviewStyles();
  const { t } = useTranslation();
  // Turning the picture back on waits out an Azure rate-limit cooldown. Compute the copy at render
  // time from a fixed deadline — no ticking timer, so this costs nothing when nothing else changes.
  const videoToggleBlocked = voice.mediaMode === "audio-only" && !voice.canEnableVideo;
  const videoCooldownSeconds = voice.videoEnableAtMs
    ? Math.max(1, Math.ceil((voice.videoEnableAtMs - Date.now()) / 1000))
    : null;
  const videoCooldownReason = videoCooldownSeconds
    ? t("voice.showAvatarCooldownSeconds", { seconds: videoCooldownSeconds })
    : t("voice.showAvatarCooldown");

  return (
    <Card className={styles.questionCard}>
      <CardHeader
        header={
          <Text size={200} weight="semibold" className={styles.questionEyebrow}>
            {isExternal
              ? t("voice.roleInterviewer")
              : t("questionProgress", { index: q.index + 1, total: q.total })}
          </Text>
        }
      />
      <Body1 as="p" className={styles.questionText}>
        {q.prompt}
      </Body1>

      {voiceUnavailable && (
        <Text size={200} className={styles.fallbackNote}>
          {voiceErrorDetail
            ? t("voice.errorDetail", { detail: voiceErrorDetail })
            : t("voice.endedFallback")}
        </Text>
      )}

      {/* Phase 2: while the external interviewer produces the next turn, replace the answer inputs
          with a quiet "thinking" row so the candidate waits instead of answering a closed turn. */}
      {isExternal && busy && (
        <div
          className={styles.externalThinking}
          data-testid="external-thinking"
        >
          <Spinner size="tiny" />
          <Text>{t("external.thinking")}</Text>
        </div>
      )}

      {/* Phase 2: a stalled external turn (recovery_required / awaiting on resume) — the candidate
          clears it with an explicit 恢复, which re-drives the same committed state (idempotent). */}
      {externalStalled && !busy && <ExternalRecovery busy={busy} onRecover={onRecover} />}

      {/* Answer inputs — hidden while an external turn is thinking or stalled (nothing to answer). */}
      {!(isExternal && (busy || externalStalled)) && channel === "text" && (
        <>
          {nudgeText ? (
            <Text data-testid="judge-nudge" style={{ opacity: 0.85 }}>
              {t("voice.roleInterviewer")}: {nudgeText}
            </Text>
          ) : null}
          <Textarea
            value={answer}
            placeholder={t("answerPlaceholder")}
            onChange={(_, d) => onAnswerChange(d.value)}
            resize="vertical"
          />
          <div>
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

      {!(isExternal && (busy || externalStalled)) && channel === "voice" && (
        <div className={styles.voiceControls}>
          {voice.connectionState === "connecting" && (
            <Text>{t("voice.connecting")}</Text>
          )}
          {voice.connectionState === "reconnecting" && (
            <Text style={{ opacity: 0.7 }}>{t("voice.reconnecting")}</Text>
          )}
          {voice.audioState === "listening" && (
            <Text size={200} style={{ opacity: 0.7 }}>
              {t("voice.stillListening")}
            </Text>
          )}
          <div className={styles.voiceButtons} data-testid="voice-buttons">
            <Button className={styles.voiceButton} onClick={voice.toggleMute}>
              {voice.isMuted ? t("voice.unmute") : t("voice.mute")}
            </Button>
            {/* Manual override of the automatic weak-network degrade. Our thresholds cannot be right
                for every network, so the candidate can force the picture off (saves ~1 Mbps and, more
                importantly, stops the video starving the interviewer's voice) or force it back on.
                Pinning also stops the automation from moving the mode on its own. */}
            {/* Azure rate-limits avatar session creation and every switch makes a new one, so turning
                the picture back ON has a cooldown. Disable the control instead of letting the click do
                nothing — but SAY WHY: a dimmed button with no reason is indistinguishable from a bug,
                and a screen-reader user would hear only "dimmed". Turning it OFF is never blocked;
                that is the move that rescues the audio. */}
            <Button
              onClick={() =>
                voice.setVideoPreference(voice.mediaMode === "audio-only" ? "on" : "off")
              }
              className={styles.voiceButton}
              disabled={videoToggleBlocked}
              title={videoToggleBlocked ? videoCooldownReason : undefined}
              aria-describedby={videoToggleBlocked ? "voice-video-cooldown" : undefined}
              data-testid="voice-video-toggle"
            >
              {voice.mediaMode === "audio-only" ? t("voice.showAvatar") : t("voice.hideAvatar")}
            </Button>
            {/* Manual end-of-answer control (P13) */}
            <Button
              appearance="primary"
              className={styles.voiceButton}
              disabled={busy || voice.connectionState !== "connected"}
              onClick={onVoiceDone}
            >
              {t("voice.imDone")}
            </Button>
          </div>
          {/* BELOW the row, never inside it. `aria-describedby` on the disabled button still points
              here — association does not need DOM adjacency — so the screen-reader behaviour the
              comment above demands is unchanged while the buttons keep their shape. */}
          {videoToggleBlocked && (
            <Text
              id="voice-video-cooldown"
              size={200}
              className={styles.voiceHint}
              data-testid="voice-video-cooldown"
            >
              {videoCooldownReason}
            </Text>
          )}
        </div>
      )}
    </Card>
  );
}
