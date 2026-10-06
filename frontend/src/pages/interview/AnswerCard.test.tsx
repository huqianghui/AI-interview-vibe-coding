/** AnswerCard: the states the page-level suite never reaches — an external turn that is thinking or
 * stalled, voice that fell back to text, and the picture toggle's cooldown. */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import i18n from "../../i18n";
import type { Question } from "../../api/client";
import { AnswerCard, type AnswerCardProps } from "./AnswerCard";

const QUESTION: Question = { question_id: "q1", prompt: "Tell me about a deviation.", index: 1, total: 4 };

function fakeVoice(overrides: Record<string, unknown> = {}) {
  return {
    connectionState: "connected",
    audioState: "idle",
    isMuted: false,
    mediaMode: "video",
    canEnableVideo: true,
    videoEnableAtMs: null,
    toggleMute: vi.fn(),
    setVideoPreference: vi.fn(),
    ...overrides,
  } as unknown as AnswerCardProps["voice"];
}

function renderCard(props: Partial<AnswerCardProps> = {}) {
  const all: AnswerCardProps = {
    q: QUESTION,
    isExternal: false,
    externalStalled: false,
    busy: false,
    channel: "text",
    voice: fakeVoice(),
    voiceUnavailable: false,
    voiceErrorDetail: null,
    nudgeText: null,
    answer: "",
    onAnswerChange: vi.fn(),
    onSubmitText: vi.fn(),
    onVoiceDone: vi.fn(),
    onRecover: vi.fn(),
    ...props,
  };
  render(
    <FluentProvider theme={webLightTheme}>
      <AnswerCard {...all} />
    </FluentProvider>,
  );
  return all;
}

describe("AnswerCard", () => {
  it("shows a bank question's progress and the prompt", () => {
    renderCard();
    expect(screen.getByText("Tell me about a deviation.")).toBeInTheDocument();
    expect(screen.getByText(/2\D+4/)).toBeInTheDocument();
  });

  it("names the interviewer instead of a count for an external turn", () => {
    renderCard({ isExternal: true });
    expect(screen.queryByText(/2\D+4/)).not.toBeInTheDocument();
  });

  it("replaces the answer inputs with a thinking row while an external turn is produced", () => {
    renderCard({ isExternal: true, busy: true });
    expect(screen.getByTestId("external-thinking")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByTestId("external-recovery")).not.toBeInTheDocument();
  });

  it("offers recovery for a stalled external turn, and hides the answer inputs", async () => {
    const user = userEvent.setup();
    const props = renderCard({ isExternal: true, externalStalled: true });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const block = screen.getByTestId("external-recovery");
    await user.click(block.querySelector("button") as HTMLButtonElement);
    expect(props.onRecover).toHaveBeenCalledOnce();
  });

  it("shows the real voice error when voice fell back to text, else the generic note", () => {
    renderCard({ voiceUnavailable: true, voiceErrorDetail: "invalid_model: gpt-x" });
    expect(screen.getByText(/invalid_model: gpt-x/)).toBeInTheDocument();
  });

  it("shows a generic fallback note when voice ended without a message", () => {
    renderCard({ voiceUnavailable: true, voiceErrorDetail: null });
    expect(screen.getByText(i18n.t("voice.endedFallback"))).toBeInTheDocument();
  });

  it("submits a typed answer and shows a pending nudge", async () => {
    const user = userEvent.setup();
    const props = renderCard({ answer: "We log it.", nudgeText: "Please go on." });
    expect(screen.getByTestId("judge-nudge")).toHaveTextContent("Please go on.");
    await user.type(screen.getByRole("textbox"), "!");
    expect(props.onAnswerChange).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /submit/i }));
    expect(props.onSubmitText).toHaveBeenCalledOnce();
  });

  it("disables the picture toggle during the avatar cooldown and says why", () => {
    renderCard({
      channel: "voice",
      voice: fakeVoice({ mediaMode: "audio-only", canEnableVideo: false, videoEnableAtMs: Date.now() + 30_000 }),
    });
    const toggle = screen.getByTestId("voice-video-toggle");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-describedby", "voice-video-cooldown");
    expect(screen.getByTestId("voice-video-cooldown")).toHaveTextContent(/30/);
  });

  it("explains the cooldown without seconds when no deadline is known", () => {
    renderCard({
      channel: "voice",
      voice: fakeVoice({ mediaMode: "audio-only", canEnableVideo: false, videoEnableAtMs: null }),
    });
    expect(screen.getByTestId("voice-video-cooldown")).not.toHaveTextContent(/\d/);
  });

  it("toggles the picture off and back on, and finishes a voice answer", async () => {
    const user = userEvent.setup();
    const voice = fakeVoice();
    const props = renderCard({ channel: "voice", voice });
    await user.click(screen.getByTestId("voice-video-toggle"));
    expect(voice.setVideoPreference).toHaveBeenCalledWith("off");
    await user.click(screen.getByRole("button", { name: /done/i }));
    expect(props.onVoiceDone).toHaveBeenCalledOnce();
  });

  it("shows the reconnecting and still-listening hints, and blocks I'm done until connected", () => {
    renderCard({
      channel: "voice",
      voice: fakeVoice({ connectionState: "reconnecting", audioState: "listening" }),
    });
    expect(screen.getByText(i18n.t("voice.reconnecting"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("voice.stillListening"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /done/i })).toBeDisabled();
  });

  it("shows the connecting hint", () => {
    renderCard({ channel: "voice", voice: fakeVoice({ connectionState: "connecting" }) });
    expect(screen.getByText(i18n.t("voice.connecting"))).toBeInTheDocument();
  });

  it("labels the mute button by the current state", async () => {
    const user = userEvent.setup();
    const voice = fakeVoice({ isMuted: true });
    renderCard({ channel: "voice", voice });
    await user.click(screen.getByRole("button", { name: i18n.t("voice.unmute") }));
    expect(voice.toggleMute).toHaveBeenCalledOnce();
  });
});
