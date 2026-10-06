/** useScoringFlow: the stream → batch fallback, progress, and the scoring screen's copy. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import "../../i18n";
import * as client from "../../api/client";
import type { Report } from "../../api/client";
import { useScoringFlow } from "./useScoringFlow";

const REPORT = { interview_session_id: "iv1", status: "scored", per_question: [{}, {}, {}] } as unknown as Report;

function render(opts: Partial<Parameters<typeof useScoringFlow>[0]> = {}) {
  return renderHook((props: Parameters<typeof useScoringFlow>[0]) => useScoringFlow(props), {
    initialProps: { report: null, questionIndex: 0, questionTotal: 5, ...opts },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("scoreInterview", () => {
  it("returns the streamed report and records progress as it arrives", async () => {
    vi.spyOn(client, "getReportStream").mockImplementation(async (_id, _sop, onProgress, onCoverage) => {
      onProgress?.({ done: 2, total: 4, question_id: "q2" });
      onCoverage?.({ done: 1, total: 2 });
      return REPORT;
    });
    const batch = vi.spyOn(client, "getReport");
    const { result } = render();

    let got: Report | undefined;
    await act(async () => {
      got = await result.current.scoreInterview("iv1", true);
    });
    expect(got).toBe(REPORT);
    expect(client.getReportStream).toHaveBeenCalledWith("iv1", true, expect.any(Function), expect.any(Function));
    expect(batch).not.toHaveBeenCalled();
    expect(result.current.scoringProgress).toEqual({ done: 2, total: 4 });
    expect(result.current.coverageProgress).toEqual({ done: 1, total: 2 });
    expect(result.current.coverageNarration).not.toBeNull();
  });

  it("falls back to the batch endpoint when the stream fails", async () => {
    vi.spyOn(client, "getReportStream").mockRejectedValue(new Error("stream down"));
    const batch = vi.spyOn(client, "getReport").mockResolvedValue(REPORT);
    const { result } = render();

    let got: Report | undefined;
    await act(async () => {
      got = await result.current.scoreInterview("iv1", false);
    });
    expect(got).toBe(REPORT);
    expect(batch).toHaveBeenCalledWith("iv1", false);
  });

  it("clears any progress and rethrows the batch error when both paths fail", async () => {
    vi.spyOn(client, "getReportStream").mockImplementation(async (_id, _sop, onProgress) => {
      onProgress?.({ done: 1, total: 3, question_id: "q1" });
      throw new Error("stream down");
    });
    vi.spyOn(client, "getReport").mockRejectedValue(new Error("502 Bad Gateway"));
    const { result } = render();

    let caught: unknown;
    await act(async () => {
      caught = await result.current.scoreInterview("iv1", false).catch((e: unknown) => e);
    });
    expect((caught as Error).message).toBe("502 Bad Gateway");
    expect(result.current.scoringProgress).toBeNull();
    expect(result.current.coverageProgress).toBeNull();
  });
});

describe("narration", () => {
  it("counts finished answers out of the streamed total, never past it", async () => {
    vi.spyOn(client, "getReportStream").mockImplementation(async (_id, _sop, onProgress) => {
      onProgress?.({ done: 9, total: 4, question_id: "q9" });
      return REPORT;
    });
    const { result } = render();
    await act(async () => {
      await result.current.scoreInterview("iv1", false);
    });
    expect(result.current.narration).toMatch(/4\D+4/);
  });

  it("falls back to the report's question count, then the latched total, then 1", () => {
    const { result, rerender } = render({ report: REPORT, questionIndex: 1, questionTotal: 9 });
    expect(result.current.narration).toMatch(/1\D+3/); // 3 questions in the report
    rerender({ report: null, questionIndex: 2, questionTotal: 9 });
    expect(result.current.narration).toMatch(/2\D+9/);
    rerender({ report: null, questionIndex: 0, questionTotal: 0 });
    expect(result.current.narration).toMatch(/0\D+1/);
  });

  it("has no coverage line unless the audit reported progress", () => {
    const { result } = render();
    expect(result.current.coverageNarration).toBeNull();
  });
});
