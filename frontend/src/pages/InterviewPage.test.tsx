/**
 * InterviewPage render + flow test (SPEC F9).
 *
 * Drives the full start → orientation → ask → answer → scoring → report loop with the API client
 * mocked, proving the page wires the state-machine responses through the F9 phases, including the
 * new demo-critical beats (orientation, scoring-in-progress, report-ready) and the text channel.
 * Voice is exercised via the P5/503 fallback path (no live WebRTC in jsdom).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

  it("runs start → orientation → ask → answer → review → explicit submit → report", async () => {
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
    vi.spyOn(client, "getReview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "completed",
      answers: [
        { question_id: "q1", prompt: "Question one?", index: 0, answer_text: "a sufficiently long answer" },
      ],
    });
    const getReportSpy = vi.spyOn(client, "getReport").mockResolvedValue({
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

    // Requirement 4: the last answer does NOT auto-score — the review screen shows every answer and
    // scoring only starts on an explicit submit. Assert we land on review with getReport NOT called.
    await waitFor(() => expect(screen.getByTestId("review")).toBeInTheDocument());
    expect(screen.getByTestId("review-answer")).toHaveTextContent("a sufficiently long answer");
    expect(getReportSpy).not.toHaveBeenCalled();

    // Explicit "Submit & evaluate" → scoring → report-ready reveal. The SOP coverage check
    // (feature D) defaults OFF, so the report request opts out (second arg false).
    await user.click(screen.getByTestId("submit-and-evaluate"));
    await waitFor(() => expect(screen.getByText(/100%/)).toBeInTheDocument());
    expect(getReportSpy).toHaveBeenCalledTimes(1);
    expect(getReportSpy).toHaveBeenCalledWith("iv1", false);
    expect(screen.getByText(/met/)).toBeInTheDocument();
  });

  it("opts into the SOP coverage check when ticked, and renders the advisory panel (feature D)", async () => {
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
    vi.spyOn(client, "getReview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "completed",
      answers: [
        { question_id: "q1", prompt: "Question one?", index: 0, answer_text: "a sufficiently long answer" },
      ],
    });
    const getReportSpy = vi.spyOn(client, "getReport").mockResolvedValue({
      interview_session_id: "iv1",
      status: "scored",
      coverage_pct: 100,
      total_score: 88,
      grade: "B",
      outcome: "Meets Expectations",
      per_question: [
        {
          question_id: "q1",
          is_stub: false,
          score: 88,
          grade: "B",
          outcome: "Meets Expectations",
          items: [],
        },
      ],
      is_stub: false,
      // Feature D advisory finding, grouped per question — must render, and never as a failure.
      sop_coverage: [
        {
          question_id: "q1",
          question_text: "Question one?",
          missing: [{ point: "Confirm the customer's identity first", sop_evidence: "verify ID before proceeding" }],
        },
      ],
    });

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");
    await user.type(screen.getByRole("textbox"), "a sufficiently long answer");
    await user.click(screen.getByRole("button", { name: /submit answer/i }));

    // On the review screen: the coverage switch is present and defaults OFF.
    await screen.findByTestId("review");
    const toggle = screen.getByTestId("sop-coverage-check");
    expect(toggle).not.toBeChecked();

    // Tick it, then submit → the report request opts IN (second arg true).
    await user.click(toggle);
    expect(toggle).toBeChecked();
    await user.click(screen.getByTestId("submit-and-evaluate"));
    await waitFor(() => expect(getReportSpy).toHaveBeenCalledWith("iv1", true));

    // The advisory panel renders the uncovered point; it is reference-only, not a score change.
    const panel = await screen.findByTestId("report-sop-coverage");
    expect(panel).toHaveTextContent("Confirm the customer's identity first");
  });

  it("rejects an empty voice answer without submitting or advancing (requirement 3)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    const submitSpy = vi.spyOn(client, "submitAnswer");
    // Voice hook: connected + "I'm done" resolves an EMPTY transcript (no speech / STT round-trip
    // produced nothing) — the page must reject it, not POST an empty answer.
    const voiceMock = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      toggleMute: () => undefined,
      commitAnswer: () => Promise.resolve("   "), // whitespace-only → still empty after trim
      speakQuestion: () => true,
      isMuted: false,
      connectionState: "connected" as const,
      audioState: "idle" as const,
      isAvatarConnected: false,
    };
    const voiceModule = await import("../hooks/useInterviewVoice");
    vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue(voiceMock);

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");

    await user.click(screen.getByRole("button", { name: /answer by voice/i }));
    await user.click(await screen.findByRole("button", { name: /i'm done answering/i }));

    // The empty-answer notice shows; no answer was submitted; still on the same question.
    await waitFor(() =>
      expect(screen.getByText(/we didn't catch an answer/i)).toBeInTheDocument(),
    );
    expect(submitSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Question one?")).toBeInTheDocument();
  });

  it("submits the awaited transcript, not a stale/empty synchronous read (race regression)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    const submitSpy = vi.spyOn(client, "submitAnswer").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q2", prompt: "Question two?", index: 1, total: 2 },
    });
    // The STT round-trip lands AFTER the click: commitAnswer resolves late, with THIS turn's text.
    // The page must submit exactly that resolved value (not the empty state captured at click time).
    let resolveCommit!: (t: string) => void;
    const voiceMock = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      toggleMute: () => undefined,
      commitAnswer: () => new Promise<string>((res) => { resolveCommit = res; }),
      speakQuestion: () => true,
      isMuted: false,
      connectionState: "connected" as const,
      audioState: "idle" as const,
      isAvatarConnected: false,
    };
    const voiceModule = await import("../hooks/useInterviewVoice");
    vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue(voiceMock);

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");

    await user.click(screen.getByRole("button", { name: /answer by voice/i }));
    await user.click(await screen.findByRole("button", { name: /i'm done answering/i }));

    // Nothing submitted yet — the transcript hasn't landed.
    expect(submitSpy).not.toHaveBeenCalled();

    // The STT round-trip resolves with the real answer.
    await act(async () => {
      resolveCommit("This is my spoken answer.");
    });

    await waitFor(() =>
      expect(submitSpy).toHaveBeenCalledWith("iv1", "This is my spoken answer.", "voice"),
    );
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

  it("shows the status legend in both channels, highlighting the current state (task two)", async () => {
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
      commitAnswer: () => Promise.resolve(""),
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

    // Text mode: the legend renders as a steady reference with one card per AudioState, and the
    // "idle/ready" card is highlighted (no live audio yet).
    const textLegend = await screen.findByTestId("voice-status-legend");
    expect(textLegend.querySelectorAll("[data-state]")).toHaveLength(4); // idle / listening / speaking / muted
    const textActive = textLegend.querySelectorAll('[data-active="true"]');
    expect(textActive).toHaveLength(1);
    expect(textActive[0].getAttribute("data-state")).toBe("idle");

    // Switch to voice → the legend now tracks the live audioState ("listening") as the only highlight.
    await user.click(screen.getByRole("button", { name: /answer by voice/i }));
    const legend = await screen.findByTestId("voice-status-legend");
    const items = legend.querySelectorAll("[data-state]");
    expect(items).toHaveLength(4); // idle / listening / speaking / muted

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
