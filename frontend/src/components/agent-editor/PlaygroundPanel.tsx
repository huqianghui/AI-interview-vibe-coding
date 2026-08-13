/**
 * Unified inline Playground for the agent editor (Foundry-portal parity).
 *
 * ONE conversation surface — text and voice+avatar are NOT separate tabs. A single message stream
 * carries both typed turns and live voice transcripts (user speech + agent replies), so everything
 * the agent says is shown as text whether you typed or spoke. The composer row holds a text input +
 * Send AND a voice toggle; starting voice brokers a persona-scoped Voice Live session and shows the
 * digital human / orb above the stream, while its transcript flows into the same message list.
 *
 * A not-yet-saved persona has nothing to test → a hint. Backend: /admin/personas/{id}/test-chat
 * (text) + /admin/personas/{id}/voice/session (voice).
 */
import { useCallback, useRef, useState } from "react";
import {
  Body1,
  Button,
  Caption1,
  Input,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Mic24Regular, MicOff24Regular } from "@fluentui/react-icons";
import { AvatarView } from "../AvatarView";
import { AvatarPreview } from "./AvatarPreview";
import { useInterviewVoice, MicAccessError } from "../../hooks/useInterviewVoice";
import { testChat } from "../../api/personaKnowledge";
import { getAdminToken } from "../../api/admin";
import type { TranscriptSegment } from "../../types/voice";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", height: "100%", gap: tokens.spacingVerticalM },
  // Avatar/orb sits above the conversation only while a voice session is live.
  stageRow: { display: "flex", justifyContent: "center", flexShrink: 0 },
  stageBox: { width: "100%", maxWidth: "520px", minHeight: "320px" },
  log: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
  },
  turn: { display: "flex", flexDirection: "column", gap: "2px", maxWidth: "85%" },
  userTurn: { alignSelf: "flex-end", alignItems: "flex-end" },
  agentTurn: { alignSelf: "flex-start", alignItems: "flex-start" },
  role: { color: tokens.colorNeutralForeground3 },
  bubbleUser: {
    background: tokens.colorBrandBackground2,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  bubbleAgent: {
    background: tokens.colorNeutralBackground3,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  interim: { opacity: 0.6, fontStyle: "italic" },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  composer: { display: "flex", gap: tokens.spacingHorizontalS, flexShrink: 0 },
  error: { color: tokens.colorPaletteRedForeground1 },
});

/** A message in the unified stream. Voice segments carry their transcript id so streaming deltas
 * update in place; typed turns get a synthetic id. `final=false` renders as a live interim bubble. */
type Turn = { id: string; role: "user" | "agent"; text: string; final: boolean };

export interface PlaygroundPanelProps {
  /** Saved persona id; null for a not-yet-saved persona (nothing to test). */
  personaId: string | null;
  character: string;
  style: string;
  locale: string;
}

export function PlaygroundPanel({ personaId, character, style, locale }: PlaygroundPanelProps) {
  const styles = useStyles();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const prevResponseId = useRef<string | null>(null);
  const avatarVideoRef = useRef<HTMLVideoElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const scrollToEnd = () => {
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  };

  // Voice transcripts (user speech + agent replies) flow into the SAME stream as typed turns.
  // Segment ids are stable per turn, so streaming deltas update the bubble in place.
  const onTranscript = useCallback((seg: TranscriptSegment) => {
    const role: "user" | "agent" = seg.role === "user" ? "user" : "agent";
    setTurns((prev) => {
      const idx = prev.findIndex((t) => t.id === seg.id);
      const next: Turn = { id: seg.id, role, text: seg.content, final: seg.isFinal };
      if (idx === -1) return [...prev, next];
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
    scrollToEnd();
  }, []);

  const voice = useInterviewVoice("", {
    locale,
    videoRef: avatarVideoRef,
    onTranscript,
    // Editor Playground: pin THIS persona's Voice Live session over the backend WS proxy, authed
    // with the admin token (the candidate anon token is only for /interview).
    tokenProvider: getAdminToken,
    personaId: personaId ?? undefined,
    onError: (err) => {
      if (err instanceof MicAccessError) setError("需要麦克风权限 / Microphone access needed.");
      else setError(err.message);
    },
  });

  const sendText = async () => {
    const text = input.trim();
    if (!text || !personaId) return;
    setTurns((t) => [...t, { id: `u-${Date.now()}`, role: "user", text, final: true }]);
    setInput("");
    setBusy(true);
    setError(null);
    scrollToEnd();
    try {
      const reply = await testChat(personaId, text, prevResponseId.current ?? undefined);
      prevResponseId.current = reply.response_id;
      setTurns((t) => [
        ...t,
        { id: `a-${Date.now()}`, role: "agent", text: reply.response_text, final: true },
      ]);
      scrollToEnd();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleVoice = async () => {
    setError(null);
    if (voiceOn) {
      await voice.disconnect().catch(() => undefined);
      setVoiceOn(false);
      return;
    }
    setVoiceOn(true);
    try {
      await voice.connect(locale);
    } catch (e) {
      setVoiceOn(false);
      if (!(e instanceof MicAccessError)) setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!personaId) {
    return (
      <div className={styles.root}>
        <AvatarPreview character={character} style={style} />
        <Caption1 data-testid="playground-needs-save">
          Save the persona first to test it here.
        </Caption1>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="playground-panel">
      {/* Digital human / orb — only while a voice session is live. */}
      {voiceOn && (
        <div className={styles.stageRow}>
          <div className={styles.stageBox}>
            <AvatarView
              ref={avatarVideoRef}
              audioState={voice.audioState}
              isAvatarConnected={voice.isAvatarConnected}
            />
          </div>
        </div>
      )}

      {/* One shared conversation stream (typed + spoken). */}
      <div className={styles.log} ref={logRef} data-testid="playground-log" aria-live="polite">
        {turns.length === 0 && (
          <Caption1>Type a message, or start voice — the agent's replies show here as text.</Caption1>
        )}
        {turns.map((t) => (
          <div
            key={t.id}
            className={`${styles.turn} ${t.role === "user" ? styles.userTurn : styles.agentTurn}`}
          >
            <Text size={100} className={styles.role}>
              {t.role === "user" ? "You" : "Interviewer"}
            </Text>
            <div className={t.role === "user" ? styles.bubbleUser : styles.bubbleAgent}>
              <Text className={t.final ? undefined : styles.interim}>{t.text}</Text>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <Caption1 className={styles.error} data-testid="playground-error">
          {error}
        </Caption1>
      )}

      {/* Voice status line (only when a session is up). */}
      {voiceOn && (
        <div className={styles.statusRow} data-testid="playground-voice-status">
          <Body1>
            {voice.connectionState === "connected"
              ? voice.audioState === "listening"
                ? "聆听中… / Listening…"
                : voice.audioState === "speaking"
                  ? "回应中… / Speaking…"
                  : "已连接 / Connected"
              : voice.connectionState === "connecting"
                ? "连接中… / Connecting…"
                : voice.connectionState}
          </Body1>
          {voice.connectionState === "connected" && (
            <Button size="small" onClick={voice.toggleMute}>
              {voice.isMuted ? "取消静音 / Unmute" : "静音 / Mute"}
            </Button>
          )}
        </div>
      )}

      {/* One composer: text input + Send + a voice toggle (both channels, one place). */}
      <div className={styles.composer}>
        <Input
          value={input}
          placeholder="Type a message…"
          onChange={(_, d) => setInput(d.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && sendText()}
          style={{ flex: 1 }}
          data-testid="playground-input"
        />
        <Button
          appearance="primary"
          disabled={busy || !input.trim()}
          onClick={sendText}
          data-testid="playground-send"
        >
          {busy ? "…" : "Send"}
        </Button>
        <Button
          icon={voiceOn ? <MicOff24Regular /> : <Mic24Regular />}
          appearance={voiceOn ? "secondary" : "outline"}
          onClick={toggleVoice}
          data-testid="playground-voice-toggle"
        >
          {voiceOn ? "Stop voice" : "Voice"}
        </Button>
      </div>
    </div>
  );
}
