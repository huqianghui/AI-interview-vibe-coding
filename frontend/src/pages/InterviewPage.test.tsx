/**
 * InterviewPage render + flow test (SPEC F9).
 *
 * Drives the full start → orientation → ask → answer → scoring → report loop with the API client
 * mocked, proving the page wires the state-machine responses through the F9 phases, including the
 * new demo-critical beats (orientation, scoring-in-progress, report-ready) and the text channel.
 * Voice is exercised via the P5/503 fallback path (no live WebRTC in jsdom).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import i18n from "../i18n";
import { InterviewPage } from "./InterviewPage";
import { collectVoiceAnswer } from "./interviewVoiceAnswer";
import * as client from "../api/client";
import type { TranscriptSegment } from "../types/voice";

function seg(id: string, content: string, role: "user" | "assistant", isFinal: boolean): TranscriptSegment {
  return { id, content, role, isFinal, timestamp: 0 };
}

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <InterviewPage />
    </FluentProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("collectVoiceAnswer", () => {
  it("joins ALL fresh final user segments in order (multi-segment content-loss fix)", () => {
    const segments = [
      seg("u1", "First part.", "user", true),
      seg("a1", "interviewer says", "assistant", true),
      seg("u2", "Second part.", "user", true),
      seg("u3", "still typing", "user", false), // non-final excluded
    ];
    const { text, ids } = collectVoiceAnswer(segments, new Set());
    expect(text).toBe("First part. Second part.");
    expect(ids).toEqual(["u1", "u2"]);
  });

  it("excludes already-submitted segments (per-turn boundary)", () => {
    const segments = [
      seg("u1", "Prior turn.", "user", true),
      seg("u2", "This turn.", "user", true),
    ];
    const { text, ids } = collectVoiceAnswer(segments, new Set(["u1"]));
    expect(text).toBe("This turn.");
    expect(ids).toEqual(["u2"]);
  });

  it("returns empty when there are no fresh final user segments", () => {
    expect(collectVoiceAnswer([], new Set())).toEqual({ text: "", ids: [] });
  });
});

describe("InterviewPage", () => {
  it("renders the start button initially", () => {
    renderPage();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("runs start → orientation → ask → answer → scoring → report", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 1 },
    });
    vi.spyOn(client, "submitAnswer").mockResolvedValue({
      interview_session_id: "iv1",
      status: "completed",
      current_question: null,
    });
    vi.spyOn(client, "getReport").mockResolvedValue({
      interview_session_id: "iv1",
      status: "scored",
      coverage_pct: 100,
      per_question: [{ question_id: "q1", judgment: "met", rationale: "ok" }],
      is_stub: true,
    });

    renderPage();
    // Start → orientation beat.
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await waitFor(() => expect(screen.getByText(/before we begin/i)).toBeInTheDocument());

    // Orientation → interviewing.
    await user.click(screen.getByRole("button", { name: /i'm ready/i }));
    await waitFor(() => expect(screen.getByText("Question one?")).toBeInTheDocument());

    // Progress stepper + text channel are present.
    expect(screen.getByTestId("question-progress")).toBeInTheDocument();
    // Two-column stage layout: the stage (avatar) and the control column both render.
    expect(screen.getByTestId("interview-stage")).toBeInTheDocument();
    expect(screen.getByTestId("interview-controls")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "a sufficiently long answer");
    await user.click(screen.getByRole("button", { name: /submit answer/i }));

    // Report-ready reveal.
    await waitFor(() => expect(screen.getByText(/100%/)).toBeInTheDocument());
    expect(screen.getByText(/met/)).toBeInTheDocument();
  });

  it("resumes an in-progress interview on mount (edge b)", async () => {
    await i18n.changeLanguage("en-US");
    vi.spyOn(client, "resumeInterview").mockResolvedValue({
      interview_session_id: "iv-resumed",
      status: "in_progress",
      current_question: { question_id: "q2", prompt: "Resumed question?", index: 1, total: 3 },
    });
    const startSpy = vi.spyOn(client, "startInterview");

    renderPage();
    // Lands straight in the interviewing phase on the pending question — no Start click.
    await waitFor(() => expect(screen.getByText("Resumed question?")).toBeInTheDocument());
    expect(startSpy).not.toHaveBeenCalled(); // resumed, not a fresh start
  });

  it("shows a defined end state when the interview has no question (edge a)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: null, // no question to present
    });

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    // A defined "no questions" card, not a blank page.
    await waitFor(() => expect(screen.getByText(/no questions available/i)).toBeInTheDocument());
  });

  it("shows the voice status legend with the current state highlighted, and hides it in text mode (task two)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    // Mock the voice hook to a STABLE connected session in the "listening" audio state, so the
    // legend renders deterministically in jsdom (no live WebRTC). The mock mirrors the real return
    // shape (see useInterviewVoice `return {...}`).
    // Promise-returning methods are plain arrows (not vi.fn) so afterEach's restoreAllMocks — which
    // runs before RTL's unmount cleanup — can't clear their implementation and make the page's
    // teardown effect call `undefined.catch(...)`.
    const voiceMock = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      toggleMute: () => undefined,
      commitAnswer: () => undefined,
      speakQuestion: () => true,
      isMuted: false,
      connectionState: "connected" as const,
      audioState: "listening" as const,
      isAvatarConnected: false,
    };
    const voiceModule = await import("../hooks/useInterviewVoice");
    vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue(voiceMock);

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");

    // Text mode first: the legend must NOT render (no live audio state to describe).
    expect(screen.queryByTestId("voice-status-legend")).not.toBeInTheDocument();

    // Switch to voice → the legend appears with one card per AudioState, and each tip is present.
    await user.click(screen.getByRole("button", { name: /answer by voice/i }));
    const legend = await screen.findByTestId("voice-status-legend");
    const items = legend.querySelectorAll("[data-state]");
    expect(items).toHaveLength(4); // idle / listening / speaking / muted

    // The card matching the live audioState ("listening") is the ONLY highlighted one.
    const active = legend.querySelectorAll('[data-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("data-state")).toBe("listening");
    expect(active[0].getAttribute("aria-current")).toBe("true");

    // Tips are rendered (proves the i18n keys resolve for the current locale).
    expect(screen.getByText(/your voice is being picked up/i)).toBeInTheDocument();
    expect(screen.getByText(/your mic is off/i)).toBeInTheDocument();
  });

  it("falls back to text when the voice connection fails (P5/P6b)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    // Voice now connects over a backend WebSocket proxy (not a REST broker). Simulate the WS
    // failing to connect (e.g. agent not synced / backend down) by stubbing global WebSocket with
    // one that fires onerror right after construction → the hook surfaces onError → text fallback.
    const realWS = global.WebSocket;
    class FailingWS {
      onerror: ((e: unknown) => void) | null = null;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      readyState = 0;
      constructor() {
        setTimeout(() => this.onerror?.(new Event("error")), 0);
      }
      send() {}
      close() {}
    }
    // @ts-expect-error test stub
    global.WebSocket = FailingWS;
    // getUserMedia must succeed so the failure is the WS, not the mic.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }) },
    });

    try {
      renderPage();
      await user.click(screen.getByRole("button", { name: /start interview/i }));
      await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
      await screen.findByText("Question one?");

      await user.click(screen.getByRole("button", { name: /answer by voice/i }));

      // Voice-unavailable notice shows and the page is back on the text channel.
      await waitFor(() => expect(screen.getByText(/voice unavailable/i)).toBeInTheDocument());
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    } finally {
      global.WebSocket = realWS;
    }
  });
});
