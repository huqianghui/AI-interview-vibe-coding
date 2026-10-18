/** The interview page's broadcast stage wiring (owner, 2026-10-17): the studio set, the name plate
 * and the topic strip appear while a photo avatar's picture shows, carry the interview's title and
 * count, and keep them (latched) when answers come back without them. AvatarView is stubbed: jsdom
 * cannot decode video, and AvatarView's own framing is covered by AvatarView.photoStage.test.tsx. */
import { forwardRef, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import i18n from "../i18n";
import * as client from "../api/client";

const STUB = { photo: true };

vi.mock("../components/AvatarView", () => ({
  AvatarView: forwardRef<
    HTMLVideoElement,
    { onPhotoStage?: (p: boolean) => void; photoOverlay?: ReactNode; photoBelow?: ReactNode }
  >(function AvatarViewStub({ onPhotoStage, photoOverlay, photoBelow }, ref) {
    useEffect(() => onPhotoStage?.(STUB.photo));
    return (
      <div data-testid="avatar-view">
        <video ref={ref} />
        {STUB.photo && photoOverlay}
        {STUB.photo && photoBelow}
      </div>
    );
  }),
}));

// Imported after the mock, so the page renders the stub.
const { InterviewPage } = await import("./InterviewPage");

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <InterviewPage />
    </FluentProvider>,
  );
}

async function startOn(start: Record<string, unknown>) {
  await i18n.changeLanguage("en-US");
  const user = userEvent.setup();
  vi.spyOn(client, "startInterview").mockResolvedValue({
    interview_session_id: "iv1",
    status: "in_progress",
    current_question: { question_id: "q1", prompt: "Question one?", index: 0, total: 2 },
    ...start,
  } as never);
  renderPage();
  await user.click(screen.getByRole("button", { name: /start interview/i }));
  await user.click(await screen.findByRole("button", { name: /i'm ready/i }));
  await screen.findByText("Question one?");
  return user;
}

describe("InterviewPage broadcast stage", () => {
  beforeEach(() => {
    sessionStorage.setItem("candidate_access_token", "test-candidate-token");
    STUB.photo = true;
  });
  afterEach(() => {
    sessionStorage.removeItem("candidate_access_token");
    vi.restoreAllMocks();
  });

  it("shows the set, her name plate and the topic strip, and keeps the title after an answer", async () => {
    const user = await startOn({
      voice_avatar_character: "sakura",
      interview_title: "Clinical Study Manager",
    });
    await waitFor(() =>
      expect(screen.getByTestId("interview-stage")).toHaveAttribute("data-broadcast", "true"),
    );
    expect(screen.getByTestId("stage-name-plate")).toHaveTextContent("Sakura");
    expect(screen.getByTestId("stage-topic-title")).toHaveTextContent("Clinical Study Manager");
    expect(screen.getByTestId("stage-topic-strip")).toHaveTextContent("2 questions");
    // Template B's masthead: the question, the language, and the voice's state (text mode: Ready).
    expect(screen.getByTestId("stage-masthead")).toHaveTextContent("No. 01 / 02 · English · Ready");

    // An answer's response carries no title (mutations report none): the strip keeps it.
    vi.spyOn(client, "submitAnswer").mockResolvedValue({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q2", prompt: "Question two?", index: 1, total: 2 },
      interview_title: null,
    } as never);
    await user.type(screen.getByRole("textbox"), "a sufficiently long answer");
    await user.click(screen.getByRole("button", { name: /submit answer/i }));
    await screen.findByText("Question two?");
    expect(screen.getByTestId("stage-topic-title")).toHaveTextContent("Clinical Study Manager");
  });

  it("labels no one it cannot name: an unknown character gets no plate", async () => {
    await startOn({ voice_avatar_character: "nobody", interview_title: "T" });
    await screen.findByTestId("stage-topic-strip");
    expect(screen.queryByTestId("stage-name-plate")).toBeNull();
  });

  it("keeps the plain stage when there is no picture (the orb)", async () => {
    STUB.photo = false;
    await startOn({ voice_avatar_character: "sakura", interview_title: "T" });
    expect(screen.getByTestId("interview-stage")).toHaveAttribute("data-broadcast", "false");
    expect(screen.queryByTestId("stage-topic-strip")).toBeNull();
    expect(screen.queryByTestId("stage-masthead")).toBeNull(); // template B is the photo stage only
  });
});
