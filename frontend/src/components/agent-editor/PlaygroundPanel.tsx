/**
 * Inline Playground for the agent editor's center column (Foundry-portal "Try it" parity).
 *
 * Two tabs, both testing the SELECTED persona's live Foundry agent without leaving the editor:
 *  - **Text:** chat with the hosted Prompt Agent (POST /admin/personas/{id}/test-chat), threaded via
 *    response id. Fastest proof the agent works + is grounded.
 *  - **Voice + digital human:** Start brokers a persona-scoped Voice Live session and runs the real
 *    WebRTC flow via `useInterviewVoice` (persona `sessionFetcher`), embedding the live `AvatarView`.
 *
 * A not-yet-saved persona has no agent to test → shows a hint. The static `AvatarPreview` is the
 * idle state before a voice session starts, so the column always shows the character.
 */
import { useRef, useState } from "react";
import {
  Body1,
  Button,
  Caption1,
  Input,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AvatarView } from "../AvatarView";
import { AvatarPreview } from "./AvatarPreview";
import { useInterviewVoice, MicAccessError } from "../../hooks/useInterviewVoice";
import { brokerPlaygroundVoice, testChat } from "../../api/personaKnowledge";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", height: "100%", gap: tokens.spacingVerticalM },
  stage: { flex: 1, minHeight: "420px", display: "flex", flexDirection: "column" },
  chat: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    flex: 1,
    minHeight: 0,
  },
  log: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    background: tokens.colorBrandBackground2,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    maxWidth: "80%",
  },
  bubbleAgent: {
    alignSelf: "flex-start",
    background: tokens.colorNeutralBackground3,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    maxWidth: "80%",
  },
  composer: { display: "flex", gap: tokens.spacingHorizontalS },
  voiceControls: { display: "flex", gap: tokens.spacingHorizontalS, alignItems: "center" },
  error: { color: tokens.colorPaletteRedForeground1 },
});

type Msg = { role: "user" | "agent"; text: string };

export interface PlaygroundPanelProps {
  /** Saved persona id; null for a not-yet-saved persona (nothing to test). */
  personaId: string | null;
  character: string;
  style: string;
  locale: string;
}

export function PlaygroundPanel({ personaId, character, style, locale }: PlaygroundPanelProps) {
  const styles = useStyles();
  const [tab, setTab] = useState<"text" | "voice">("text");

  // Text chat state.
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const prevResponseId = useRef<string | null>(null);

  // Voice state.
  const avatarVideoRef = useRef<HTMLVideoElement | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceStarted, setVoiceStarted] = useState(false);

  const voice = useInterviewVoice("", {
    locale,
    videoRef: avatarVideoRef,
    sessionFetcher: () => brokerPlaygroundVoice(personaId ?? ""),
    onError: (err) => {
      if (err instanceof MicAccessError) setVoiceError("需要麦克风权限 / Microphone access needed.");
      else setVoiceError(err.message);
    },
  });

  const send = async () => {
    const text = input.trim();
    if (!text || !personaId) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setBusy(true);
    setChatError(null);
    try {
      const reply = await testChat(personaId, text, prevResponseId.current ?? undefined);
      prevResponseId.current = reply.response_id;
      setMessages((m) => [...m, { role: "agent", text: reply.response_text }]);
    } catch (e) {
      setChatError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startVoice = async () => {
    setVoiceError(null);
    setVoiceStarted(true);
    try {
      await voice.connect(locale);
    } catch (e) {
      if (!(e instanceof MicAccessError)) setVoiceError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopVoice = async () => {
    await voice.disconnect().catch(() => undefined);
    setVoiceStarted(false);
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
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as "text" | "voice")}>
        <Tab value="text" data-testid="playground-tab-text">
          Text
        </Tab>
        <Tab value="voice" data-testid="playground-tab-voice">
          Voice + digital human
        </Tab>
      </TabList>

      {tab === "text" ? (
        <div className={styles.chat} data-testid="playground-text">
          <div className={styles.log}>
            {messages.length === 0 && (
              <Caption1>Send a message to test the interviewer agent.</Caption1>
            )}
            {messages.map((m, i) => (
              <Text key={i} className={m.role === "user" ? styles.bubbleUser : styles.bubbleAgent}>
                {m.text}
              </Text>
            ))}
          </div>
          {chatError && (
            <Caption1 className={styles.error} data-testid="playground-chat-error">
              {chatError}
            </Caption1>
          )}
          <div className={styles.composer}>
            <Input
              value={input}
              placeholder="Type a message…"
              onChange={(_, d) => setInput(d.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && send()}
              style={{ flex: 1 }}
              data-testid="playground-input"
            />
            <Button
              appearance="primary"
              disabled={busy || !input.trim()}
              onClick={send}
              data-testid="playground-send"
            >
              {busy ? "…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.stage} data-testid="playground-voice">
          {voiceStarted ? (
            <AvatarView
              ref={avatarVideoRef}
              audioState={voice.audioState}
              isAvatarConnected={voice.isAvatarConnected}
            />
          ) : (
            <AvatarPreview character={character} style={style} />
          )}
          {voiceError && (
            <Caption1 className={styles.error} data-testid="playground-voice-error">
              {voiceError}
            </Caption1>
          )}
          <div className={styles.voiceControls}>
            {!voiceStarted ? (
              <Button appearance="primary" onClick={startVoice} data-testid="playground-voice-start">
                Start voice test
              </Button>
            ) : (
              <>
                <Body1>
                  {voice.connectionState === "connected"
                    ? "Connected"
                    : voice.connectionState === "connecting"
                      ? "Connecting…"
                      : voice.connectionState}
                </Body1>
                <Button onClick={voice.toggleMute}>{voice.isMuted ? "Unmute" : "Mute"}</Button>
                <Button onClick={stopVoice} data-testid="playground-voice-stop">
                  Stop
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
