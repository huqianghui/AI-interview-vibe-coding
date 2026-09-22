/**
 * InterviewPage render + flow test (SPEC F9).
 *
 * Drives the full start → orientation → ask → answer → scoring → report loop with the API client
 * mocked, proving the page wires the state-machine responses through the F9 phases, including the
 * new demo-critical beats (orientation, scoring-in-progress, report-ready) and the text channel.
 * Voice is exercised via the P5/503 fallback path (no live WebRTC in jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import i18n from "../i18n";
import { InterviewPage } from "./InterviewPage";
import { collectVoiceAnswer } from "./interviewVoiceAnswer";
import * as client from "../api/client";
import * as auth from "../api/auth";
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
  // #102: every existing flow test below predates the candidate login gate and expects the page to
  // start straight on the interview UI. Seed a candidate token before each one (mirroring how the
  // "surfaces the real Azure error" test seeds the anon-session token) so candidateAuthed is true at
  // mount and these flows keep exercising exactly what they exercised before the gate landed. The
  // login-gate/sign-out/CandidateAuthError behavior itself is covered by its own describe block below.
  beforeEach(() => {
    sessionStorage.setItem("candidate_access_token", "test-candidate-token");
  });

  afterEach(() => {
    sessionStorage.removeItem("candidate_access_token");
  });

  it("renders the start button initially", () => {
    renderPage();
    expect(screen.getByRole("button", { name: /start interview/i })).toBeInTheDocument();
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
    // The page scores via the streaming endpoint (getReportStream) and only falls back to the
    // batch getReport on stream failure — mock the streaming one as the primary path.
    const getReportSpy = vi.spyOn(client, "getReportStream").mockResolvedValue({
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
    expect(getReportSpy).toHaveBeenCalledWith("iv1", false, expect.any(Function));
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
    const getReportSpy = vi.spyOn(client, "getReportStream").mockResolvedValue({
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
    await waitFor(() =>
      expect(getReportSpy).toHaveBeenCalledWith("iv1", true, expect.any(Function)),
    );

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
      setMuted: () => undefined,
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

  it("opens in the voice channel when the interviewer persona is voice-configured (voice_default)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
      voice_default: true,
    });
    // Track calls with plain counters (not vi.fn — see the stable-mock note above).
    let connectCalls = 0;
    let speakCalls = 0;
    const mutedCalls: boolean[] = [];
    const voiceMock = {
      connect: () => {
        connectCalls += 1;
        return Promise.resolve();
      },
      disconnect: () => Promise.resolve(),
      toggleMute: () => undefined,
      setMuted: (m: boolean) => {
        mutedCalls.push(m);
      },
      commitAnswer: () => Promise.resolve(""),
      speakQuestion: () => {
        speakCalls += 1;
        return true;
      },
      isMuted: false,
      connectionState: "connected" as const,
      audioState: "listening" as const,
      isAvatarConnected: false,
    };
    const voiceModule = await import("../hooks/useInterviewVoice");
    vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue(voiceMock);

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    // Orientation prewarm: the voice session connects while the candidate reads the orientation
    // copy — but Q1 must NOT be read over that screen, and the mic stays muted there.
    await waitFor(() => expect(connectCalls).toBeGreaterThan(0));
    expect(speakCalls).toBe(0);
    expect(mutedCalls.at(-1)).toBe(true);

    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");

    // Entering the live phase: mic unmutes, the question is spoken, and the voice answer control
    // renders instead of the text box — all without touching the channel pill.
    await waitFor(() => expect(speakCalls).toBeGreaterThan(0));
    expect(mutedCalls.at(-1)).toBe(false);
    expect(await screen.findByRole("button", { name: /i'm done answering/i })).toBeInTheDocument();
  });

  it("stays on the text channel when voice_default is absent (no auto-connect)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    let connectCalls = 0;
    const voiceMock = {
      connect: () => {
        connectCalls += 1;
        return Promise.resolve();
      },
      disconnect: () => Promise.resolve(),
      toggleMute: () => undefined,
      setMuted: () => undefined,
      commitAnswer: () => Promise.resolve(""),
      speakQuestion: () => true,
      isMuted: false,
      connectionState: "disconnected" as const,
      audioState: "idle" as const,
      isAvatarConnected: false,
    };
    const voiceModule = await import("../hooks/useInterviewVoice");
    vi.spyOn(voiceModule, "useInterviewVoice").mockReturnValue(voiceMock);

    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");

    // Text stays the default: the text answer box renders and no voice connect was attempted.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(connectCalls).toBe(0);
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
      setMuted: () => undefined,
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

  it("verbatim-reads a main question but NOT a follow-up (duplicate-read regression, issue 1)", async () => {
    // Root cause of the "spoken/rendered twice" bug: the backend follow-up prompt was verbatim-read
    // on top of the agent's own server-VAD auto-response follow-up. The page must speak main
    // questions and let the agent own follow-ups (current_question.is_follow_up === true).
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Main question?", index: 0, total: 2 },
    });
    // Answering the main question returns the SAME question with a follow-up prompt + is_follow_up.
    vi.spyOn(client, "submitAnswer").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: {
        question_id: "q1",
        prompt: "You mentioned X — can you clarify?",
        index: 0,
        total: 2,
        is_follow_up: true,
      },
    });
    const spoken: string[] = [];
    const voiceMock = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      toggleMute: () => undefined,
      setMuted: () => undefined,
      commitAnswer: () => Promise.resolve("my main answer, long enough"),
      speakQuestion: (text: string) => {
        spoken.push(text);
        return true;
      },
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
    await screen.findByText("Main question?");

    // Switch to voice → the main question is read verbatim.
    await user.click(screen.getByRole("button", { name: /answer by voice/i }));
    await waitFor(() => expect(spoken).toContain("Main question?"));

    // Answer it → a follow-up becomes current. It must NOT be verbatim-read (agent voices it).
    await user.click(await screen.findByRole("button", { name: /i'm done answering/i }));
    await screen.findByText("You mentioned X — can you clarify?");
    expect(spoken).not.toContain("You mentioned X — can you clarify?");
    expect(spoken).toEqual(["Main question?"]);
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
      setMuted: () => undefined,
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

  it("surfaces the real Azure error verbatim, not the generic notice (owner: 显示错误信息)", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    });
    // A WS that connects, then emits a pre-connect Voice Live `error` frame carrying Azure's real
    // message (e.g. an invalid_model / region rejection). The hook rejects connect() with that
    // message verbatim → the page must show IT, not the generic "you can continue by text" note.
    const AZURE_MSG = "The model gpt-5.4-mini is not supported in this region.";
    const realWS = global.WebSocket;
    class ErrorFrameWS {
      onerror: ((e: unknown) => void) | null = null;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      readyState = 1;
      constructor() {
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: "error",
              error: { code: "invalid_model", message: AZURE_MSG },
            }),
          });
        }, 0);
      }
      send() {}
      close() {}
    }
    // jsdom has no Web Audio; connect() calls prepareAudioContext()/initMic() BEFORE the WS, so
    // without these stubs it would reject with "AudioContext is not defined" and the error-frame
    // path (the real Azure failure this test guards) would never be reached.
    class FakeAudioContext {
      state = "running";
      destination = {};
      audioWorklet = { addModule: () => Promise.resolve() };
      createMediaStreamSource() {
        return { connect() {} };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    class FakeAudioWorkletNode {
      port = { postMessage() {}, onmessage: null };
      connect() {}
    }
    const realAudioContext = (global as { AudioContext?: unknown }).AudioContext;
    const realWorkletNode = (global as { AudioWorkletNode?: unknown }).AudioWorkletNode;
    // @ts-expect-error test stub
    global.WebSocket = ErrorFrameWS;
    // @ts-expect-error test stub
    global.AudioContext = FakeAudioContext;
    // @ts-expect-error test stub
    global.AudioWorkletNode = FakeAudioWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }),
      },
    });

    // The WS auth token defaults to the anon-session token held in localStorage; give it one so
    // connect() gets past token acquisition to the WS where the error frame arrives.
    localStorage.setItem("anon_session_token", "test-token");

    try {
      renderPage();
      await user.click(screen.getByRole("button", { name: /start interview/i }));
      await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
      await screen.findByText("Question one?");
      await user.click(screen.getByRole("button", { name: /answer by voice/i }));

      // The verbatim Azure message is on screen — the diagnostic the owner wants a human to judge,
      // NOT swallowed behind the generic "you can continue by text" note.
      await waitFor(() =>
        expect(screen.getByText(new RegExp(AZURE_MSG))).toBeInTheDocument(),
      );
    } finally {
      global.WebSocket = realWS;
      // @ts-expect-error restore
      global.AudioContext = realAudioContext;
      // @ts-expect-error restore
      global.AudioWorkletNode = realWorkletNode;
      localStorage.removeItem("anon_session_token");
    }
  });
});

describe("InterviewPage candidate login gate (#102)", () => {
  afterEach(() => {
    sessionStorage.removeItem("candidate_access_token");
    localStorage.removeItem("anon_session_token");
  });

  it("shows only the login card when no candidate token is present", () => {
    sessionStorage.removeItem("candidate_access_token");
    renderPage();
    expect(screen.getByTestId("candidate-username-input")).toBeInTheDocument();
    expect(screen.getByTestId("candidate-password-input")).toBeInTheDocument();
    expect(screen.getByTestId("candidate-login")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start interview/i })).not.toBeInTheDocument();
  });

  it("logs in and reveals the start button on success", async () => {
    await i18n.changeLanguage("en-US");
    sessionStorage.removeItem("candidate_access_token");
    const user = userEvent.setup();
    vi.spyOn(auth, "loginCandidate").mockResolvedValue("jwt-token");
    renderPage();
    await user.type(screen.getByTestId("candidate-username-input"), "user1");
    await user.type(screen.getByTestId("candidate-password-input"), "pw");
    await user.click(screen.getByTestId("candidate-login"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /start interview/i })).toBeInTheDocument(),
    );
  });

  it("shows the localized wrong-credentials message on a 401", async () => {
    await i18n.changeLanguage("en-US");
    sessionStorage.removeItem("candidate_access_token");
    const user = userEvent.setup();
    vi.spyOn(auth, "loginCandidate").mockRejectedValue(new auth.AuthError("用户名或密码错误", 401));
    renderPage();
    await user.type(screen.getByTestId("candidate-username-input"), "user1");
    await user.type(screen.getByTestId("candidate-password-input"), "wrong");
    await user.click(screen.getByTestId("candidate-login"));
    await waitFor(() =>
      expect(screen.getByText("Incorrect username or password.")).toBeInTheDocument(),
    );
  });

  it("shows the AuthError message verbatim for a non-401 failure", async () => {
    await i18n.changeLanguage("en-US");
    sessionStorage.removeItem("candidate_access_token");
    const user = userEvent.setup();
    vi.spyOn(auth, "loginCandidate").mockRejectedValue(new auth.AuthError("登录失败 (500)", 500));
    renderPage();
    await user.type(screen.getByTestId("candidate-username-input"), "user1");
    await user.type(screen.getByTestId("candidate-password-input"), "pw");
    await user.click(screen.getByTestId("candidate-login"));
    await waitFor(() => expect(screen.getByText("登录失败 (500)")).toBeInTheDocument());
  });

  it("drops back to the login card showing the backend detail verbatim on CandidateAuthError", async () => {
    sessionStorage.setItem("candidate_access_token", "stale-token");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockRejectedValue(
      new client.CandidateAuthError("Admin accounts cannot take interviews", 403),
    );
    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await waitFor(() =>
      expect(screen.getByText("Admin accounts cannot take interviews")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("candidate-login")).toBeInTheDocument();
  });

  it("signs out: disconnects voice, clears tokens, and returns to the login card", async () => {
    sessionStorage.setItem("candidate_access_token", "test-candidate-token");
    localStorage.setItem("anon_session_token", "anon-token");
    const user = userEvent.setup();
    vi.spyOn(client, "startInterview").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 1 },
    });
    renderPage();
    await user.click(screen.getByRole("button", { name: /start interview/i }));
    await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
    await screen.findByText("Question one?");

    await user.click(screen.getByTestId("candidate-sign-out"));
    await waitFor(() => expect(screen.getByTestId("candidate-login")).toBeInTheDocument());
    expect(sessionStorage.getItem("candidate_access_token")).toBeNull();
    expect(localStorage.getItem("anon_session_token")).toBeNull();
  });
});
