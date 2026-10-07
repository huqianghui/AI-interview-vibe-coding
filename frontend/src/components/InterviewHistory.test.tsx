/** Interview history (#187): the list, one interview's detail, and the transcript download text. */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import i18n from "../i18n";
import type { InterviewDetail, InterviewHistoryItem, Report } from "../api/client";
import { InterviewDetailView, InterviewHistoryTable } from "./InterviewHistory";
import { transcriptText } from "./transcriptText";

const ITEM: InterviewHistoryItem = {
  id: "i1",
  status: "scored",
  started_at: "2026-10-07T09:00:00",
  completed_at: "2026-10-07T09:20:00",
  persona_name: "Ava",
  bank_name: "Safety bank",
  total_score: 72,
  outcome: "Meets Expectations",
  has_report: true,
};

const REPORT: Report = {
  interview_session_id: "i1",
  status: "scored",
  coverage_pct: 72,
  per_question: [],
  is_stub: true,
};

const TRANSCRIPT = [
  {
    turn_index: 0,
    role: "interviewer" as const,
    turn_kind: "main" as const,
    content: "Describe the safety check.",
    created_at: "2026-10-07T09:00:01",
  },
  {
    turn_index: 1,
    role: "candidate" as const,
    turn_kind: "main" as const,
    content: "I check the runbook first.",
    created_at: "2026-10-07T09:01:00",
  },
];

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

describe("InterviewHistoryTable", () => {
  it("lists every interview with interviewer, bank, status and score, and opens one", async () => {
    await i18n.changeLanguage("en-US");
    const onOpen = vi.fn();
    const legacy = { ...ITEM, id: "i0", status: "abandoned" as const, persona_name: null, bank_name: null, total_score: null };
    wrap(<InterviewHistoryTable items={[ITEM, legacy]} onOpen={onOpen} />);

    const row = screen.getByTestId("history-row-i1");
    expect(row).toHaveTextContent("Ava");
    expect(row).toHaveTextContent("Safety bank");
    expect(row).toHaveTextContent("Scored");
    expect(row).toHaveTextContent("72/100");
    const old = screen.getByTestId("history-row-i0");
    expect(old).toHaveTextContent("Abandoned");
    expect(old).toHaveTextContent("Default (not recorded)");

    await userEvent.setup().click(screen.getByTestId("history-open-i1"));
    expect(onOpen).toHaveBeenCalledWith("i1");
  });

  it("says so when there is nothing yet", async () => {
    await i18n.changeLanguage("en-US");
    wrap(<InterviewHistoryTable items={[]} onOpen={vi.fn()} />);
    expect(screen.getByTestId("history-table-empty")).toHaveTextContent("No interviews yet.");
  });
});

describe("InterviewDetailView", () => {
  const open = vi.fn().mockResolvedValue("blob:x");

  it("shows the saved report and the transcript", async () => {
    await i18n.changeLanguage("en-US");
    const detail: InterviewDetail = { item: ITEM, report: REPORT, transcript: TRANSCRIPT };
    wrap(<InterviewDetailView detail={detail} openSop={open} onClose={vi.fn()} />);
    expect(screen.getByText("Interview report")).toBeInTheDocument();
    expect(screen.queryByTestId("history-no-report")).not.toBeInTheDocument();
    expect(screen.getByTestId("history-transcript")).toHaveTextContent("I check the runbook first.");
  });

  it("an in-progress interview has no report and nothing to generate", async () => {
    await i18n.changeLanguage("en-US");
    const detail: InterviewDetail = {
      item: { ...ITEM, status: "in_progress", has_report: false, total_score: null },
      report: null,
      transcript: TRANSCRIPT.slice(0, 1),
    };
    wrap(
      <InterviewDetailView detail={detail} openSop={open} onClose={vi.fn()} onGenerateReport={vi.fn()} />,
    );
    expect(screen.getByTestId("history-no-report")).toHaveTextContent("No report yet (In progress).");
    expect(screen.queryByTestId("history-generate-report")).not.toBeInTheDocument();
  });

  it("the admin can generate the missing report of a finished interview", async () => {
    await i18n.changeLanguage("en-US");
    const generate = vi.fn().mockResolvedValue(undefined);
    const detail: InterviewDetail = {
      item: { ...ITEM, status: "completed", has_report: false, total_score: null },
      report: null,
      transcript: TRANSCRIPT,
    };
    wrap(
      <InterviewDetailView detail={detail} openSop={open} onClose={vi.fn()} onGenerateReport={generate} />,
    );
    await userEvent.setup().click(screen.getByTestId("history-generate-report"));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("shows why generating failed", async () => {
    await i18n.changeLanguage("en-US");
    const detail: InterviewDetail = {
      item: { ...ITEM, status: "completed", has_report: false },
      report: null,
      transcript: [],
    };
    wrap(
      <InterviewDetailView
        detail={detail}
        openSop={open}
        onClose={vi.fn()}
        onGenerateReport={vi.fn().mockRejectedValue(new Error("boom"))}
      />,
    );
    await userEvent.setup().click(screen.getByTestId("history-generate-report"));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByText("Nothing was said in this interview.")).toBeInTheDocument();
  });

  it("the candidate's view never offers to generate a report", async () => {
    await i18n.changeLanguage("en-US");
    const detail: InterviewDetail = {
      item: { ...ITEM, status: "completed", has_report: false },
      report: null,
      transcript: [],
    };
    wrap(<InterviewDetailView detail={detail} openSop={open} onClose={vi.fn()} />);
    expect(screen.queryByTestId("history-generate-report")).not.toBeInTheDocument();
  });

  it("downloads the transcript as a text file and closes", async () => {
    await i18n.changeLanguage("en-US");
    const onClose = vi.fn();
    const createUrl = vi.fn().mockReturnValue("blob:t");
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const detail: InterviewDetail = { item: ITEM, report: null, transcript: TRANSCRIPT };
    wrap(<InterviewDetailView detail={detail} openSop={open} onClose={onClose} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("history-download-transcript"));
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("history-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe("transcriptText", () => {
  it("has a header and one line per turn, naming the speaker and follow-ups", async () => {
    await i18n.changeLanguage("en-US");
    const followUp = { ...TRANSCRIPT[0], turn_index: 2, turn_kind: "follow_up" as const, content: "Why?" };
    const text = transcriptText(
      { item: ITEM, report: null, transcript: [...TRANSCRIPT, followUp] },
      i18n.t.bind(i18n),
      "en-US",
    );
    const lines = text.trim().split("\n");
    expect(lines[1]).toBe("Interviewer: Ava");
    expect(lines[2]).toBe("Question bank: Safety bank");
    expect(lines[3]).toBe("Status: Scored");
    expect(lines[5]).toMatch(/\] Interviewer: Describe the safety check\.$/);
    expect(lines[6]).toMatch(/\] Candidate: I check the runbook first\.$/);
    expect(lines[7]).toMatch(/\] Interviewer \(follow-up\): Why\?$/);
  });
});
