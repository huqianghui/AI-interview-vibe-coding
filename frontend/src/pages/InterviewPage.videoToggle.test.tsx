/**
 * Coverage for the manual video/audio-only toggle button (weak-network media adaptation, 2026-09-30).
 *
 * `InterviewPage.test.tsx` sets `mediaMode: "video"` and `setVideoPreference: () => undefined` (a
 * no-op) in every one of its `voiceMock` objects, and never clicks `voice-video-toggle` — so the
 * manual override (SPEC weaknet media resilience) — including the cooldown-disabled state and its
 * accessible reason text — is currently unexercised. This is a separate NEW test file (not an edit
 * to the existing one) so the audit's "only add new test files" constraint holds; it follows the
 * exact `voiceMock`/`vi.spyOn` pattern already used throughout `InterviewPage.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import i18n from "../i18n";
import { InterviewPage } from "./InterviewPage";
import * as client from "../api/client";

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <InterviewPage />
    </FluentProvider>,
  );
}

describe("InterviewPage manual video/audio-only toggle", () => {
  beforeEach(() => {
    sessionStorage.setItem("candidate_access_token", "test-candidate-token");
  });

  afterEach(() => {
    sessionStorage.removeItem("candidate_access_token");
    vi.restoreAllMocks();
  });

  async function startOnVoiceQuestion(voiceMock: Record<string, unknown>) {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    const voiceModule = await import("../hooks/useInterviewVoice");
    const hookSpy = vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue(voiceMock as never);

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");
    await user.click(screen.getByRole("button", { name: /answer by voice/i }));
    await screen.findByTestId("voice-video-toggle");
    return { user, hookSpy };
  }

  function baseVoiceMock(overrides: Record<string, unknown> = {}) {
    return {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      toggleMute: () => undefined,
      setMuted: () => undefined,
      commitAnswer: () => Promise.resolve(""),
      speakQuestion: () => true,
      isMuted: false,
      connectionState: "connected" as const,
      audioState: "idle" as const,
      isAvatarConnected: false,
      mediaMode: "video" as const,
      videoPreference: "auto" as const,
      setVideoPreference: () => undefined,
      canEnableVideo: true,
      videoEnableAtMs: null,
      speakAside: () => true,
      peekDraft: () => "",
      ...overrides,
    };
  }

  it('shows "Turn off video" while in video mode, and requests "off" on click', async () => {
    const calls: string[] = [];
    const { user } = await startOnVoiceQuestion(
      baseVoiceMock({ setVideoPreference: (v: string) => calls.push(v) }),
    );
    const toggle = screen.getByTestId("voice-video-toggle");
    expect(toggle).toHaveTextContent("Turn off video");
    expect(toggle).not.toBeDisabled();
    await user.click(toggle);
    expect(calls).toEqual(["off"]);
  });

  it('shows "Turn on video" while audio-only and not blocked, and requests "on" on click', async () => {
    const calls: string[] = [];
    const { user } = await startOnVoiceQuestion(
      baseVoiceMock({
        mediaMode: "audio-only",
        canEnableVideo: true,
        setVideoPreference: (v: string) => calls.push(v),
      }),
    );
    const toggle = screen.getByTestId("voice-video-toggle");
    expect(toggle).toHaveTextContent("Turn on video");
    expect(toggle).not.toBeDisabled();
    await user.click(toggle);
    expect(calls).toEqual(["on"]);
  });

  it("disables the toggle during the Azure rate-limit cooldown and states why (no generic seconds)", async () => {
    const calls: string[] = [];
    await startOnVoiceQuestion(
      baseVoiceMock({
        mediaMode: "audio-only",
        canEnableVideo: false,
        videoEnableAtMs: null,
        setVideoPreference: (v: string) => calls.push(v),
      }),
    );
    const toggle = screen.getByTestId("voice-video-toggle");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-describedby", "voice-video-cooldown");
    expect(screen.getByTestId("voice-video-cooldown")).toHaveTextContent(
      "Video can be turned back on again shortly.",
    );
    // A disabled button click is a no-op — @testing-library's userEvent honours the disabled attr,
    // but assert the callback anyway so a future removal of `disabled` doesn't silently start firing.
    await userEvent.setup().click(toggle).catch(() => undefined);
    expect(calls).toEqual([]);
  });

  it("surfaces the concrete countdown once Azure gives a retry-after deadline", async () => {
    const now = Date.now();
    await startOnVoiceQuestion(
      baseVoiceMock({
        mediaMode: "audio-only",
        canEnableVideo: false,
        videoEnableAtMs: now + 43_000,
      }),
    );
    const toggle = screen.getByTestId("voice-video-toggle");
    expect(toggle).toBeDisabled();
    // Ceil'd seconds-remaining copy (videoCooldownReason), not the generic fallback string.
    expect(screen.getByTestId("voice-video-cooldown")).toHaveTextContent(/Video can be turned back on in about \d+s\./);
    expect(screen.getByTestId("voice-video-cooldown")).not.toHaveTextContent(
      "Video can be turned back on again shortly.",
    );
  });
  it("keeps the cooldown reason OUT of the button row, so a weak network cannot reshape the buttons", async () => {
    // The regression this locks (owner, 2026-10-02): the reason used to render as a sibling BETWEEN
    // the buttons, and its width forced "Turn on video" and "I'm done answering" to wrap onto two
    // lines — the controls changed shape the moment the network degraded. Asserting on the DOM
    // STRUCTURE rather than on pixels: nothing but buttons may live in that row, so the squeeze
    // cannot come back by any route (a wider string, a new locale, another hint).
    await startOnVoiceQuestion(
      baseVoiceMock({
        mediaMode: "audio-only",
        canEnableVideo: false,
        videoEnableAtMs: Date.now() + 43_000,
      }),
    );
    const row = screen.getByTestId("voice-buttons");
    // The reason is on screen...
    expect(screen.getByTestId("voice-video-cooldown")).toBeInTheDocument();
    // ...but NOT inside the row...
    expect(within(row).queryByTestId("voice-video-cooldown")).toBeNull();
    // ...and the row still holds exactly the three controls.
    expect(within(row).getAllByRole("button")).toHaveLength(3);
    // The accessible association survives the move (describedby needs no DOM adjacency).
    expect(screen.getByTestId("voice-video-toggle")).toHaveAttribute(
      "aria-describedby",
      "voice-video-cooldown",
    );
  });

  it("asks Azure to paint the stage colour behind EVERY avatar, not just photo ones", async () => {
    // Before this, `avatar_bg` came only from the photo roster's measured thumbnail backdrop, so a
    // VIDEO avatar got nothing and Azure kept its own studio wall — a rectangle in a colour the page
    // never chose. The value is the theme's surface colour, which is what actually paints behind the
    // transparent stage (verified against the live deployment: only `.fui-FluentProvider` has a
    // background, `rgb(255,255,255)`).
    const { hookSpy } = await startOnVoiceQuestion(baseVoiceMock());
    // `useInterviewVoice(sessionId, options)` — the options are the SECOND argument.
    const options = hookSpy.mock.calls.at(-1)?.[1] as { avatarBackground?: string } | undefined;
    expect(options?.avatarBackground).toBe(webLightTheme.colorNeutralBackground1);
  });
});
