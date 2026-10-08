import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import i18n from "../../i18n";
import * as admin from "../../api/admin";
import { InterviewRecordings } from "./InterviewRecordings";

const ROWS: admin.InterviewRecording[] = [
  { recording_id: "r1", question_index: 0, duration_ms: 83_000, size_bytes: 1, created_at: null },
  { recording_id: "r2", question_index: 1, duration_ms: 5_000, size_bytes: 1, created_at: null },
];

function renderPanel() {
  render(
    <FluentProvider theme={webLightTheme}>
      <InterviewRecordings interviewId="iv1" />
    </FluentProvider>,
  );
}

// jsdom has no object URLs.
URL.revokeObjectURL = vi.fn();

describe("InterviewRecordings", () => {
  it("lists each question's recording, plays one, and says when one has expired", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(admin, "listInterviewRecordings").mockResolvedValue(ROWS);
    vi.spyOn(admin, "fetchInterviewRecording").mockImplementation(async (_iv, id) => {
      if (id === "r2") throw Object.assign(new Error("gone"), { status: 410 });
      return "blob:audio-r1";
    });
    renderPanel();
    const panel = await screen.findByTestId("interview-recordings");
    expect(panel).toHaveTextContent("Question 1 · 1:23");
    expect(panel).toHaveTextContent("Question 2 · 0:05");

    await user.click(screen.getByTestId("recording-play-r1"));
    expect(await screen.findByTestId("recording-audio-r1")).toHaveAttribute("src", "blob:audio-r1");
    await user.click(screen.getByTestId("recording-play-r2"));
    expect(await screen.findByText(/has been deleted/)).toBeInTheDocument();
  });

  it("shows nothing for an interview with no recordings", async () => {
    vi.spyOn(admin, "listInterviewRecordings").mockResolvedValue([]);
    renderPanel();
    await Promise.resolve();
    expect(screen.queryByTestId("interview-recordings")).toBeNull();
  });
});
