/**
 * Scoring the finished interview (requirement 4: only after the candidate submits from review).
 *
 * Streams real per-question progress off /report/stream and falls back to the batch endpoint when
 * the stream is unavailable (older backend, proxy hiccup): a scored interview re-scores
 * idempotently, so retrying after a mid-stream failure is safe. The opt-in SOP coverage audit
 * reports its own progress, because its total is the number of model calls it needs, usually fewer
 * than the question count.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getReport, getReportStream, type Report } from "../../api/client";

export interface Progress {
  done: number;
  total: number;
}

export function useScoringFlow({
  report,
  questionIndex,
  questionTotal,
}: {
  /** The report once scored (its per-question count is a fallback total). */
  report: Report | null;
  /** The current question's index, the last fallback numerator while nothing has streamed. */
  questionIndex: number;
  /** The question count latched during the interview (`current_question` is null by now). */
  questionTotal: number;
}) {
  const { t } = useTranslation();
  // Real scoring progress (null until the first progress line, and when the stream fell back to
  // the batch endpoint — the copy then shows the latched fallback).
  const [scoringProgress, setScoringProgress] = useState<Progress | null>(null);
  // The opt-in SOP coverage audit's OWN progress (null unless the candidate ticked the box). It runs
  // after every answer is graded, so without a second line the screen froze on "N of N scored" for
  // the length of the audit.
  const [coverageProgress, setCoverageProgress] = useState<Progress | null>(null);

  /** Score the interview and return its report; on failure, clear the progress and rethrow. */
  const scoreInterview = async (interviewId: string, sopCoverageCheck: boolean): Promise<Report> => {
    setScoringProgress(null);
    setCoverageProgress(null);
    try {
      try {
        // Streaming first: one progress event per question as the backend grades it.
        return await getReportStream(
          interviewId,
          sopCoverageCheck,
          (p) => setScoringProgress({ done: p.done, total: p.total }),
          (p) => setCoverageProgress({ done: p.done, total: p.total }),
        );
      } catch {
        return await getReport(interviewId, sopCoverageCheck);
      }
    } catch (e) {
      setScoringProgress(null);
      setCoverageProgress(null);
      throw e;
    }
  };

  // REAL streamed progress when /report/stream delivered any. `done` is the number of answers
  // FINISHED (v0.42.2.0: the backend grades them concurrently, so there is no single "currently
  // analyzing" question to name — it is shown as-is, not done+1, which would claim one more answer
  // is finished than actually is). Fallback (stream unavailable): the report's per-question count
  // once it's back, else the total latched during the interview.
  const scoringTotal = scoringProgress?.total || report?.per_question.length || questionTotal || 1;
  const narration = t("transition.scoring", {
    n: scoringProgress
      ? Math.min(scoringProgress.done, scoringTotal)
      : Math.min(questionIndex, scoringTotal),
    total: scoringTotal,
  });
  // Second line, only while the opt-in audit is running. Separate from the line above rather than
  // replacing it: the scored count is the thing the candidate was watching, and swapping the copy
  // out from under them would read as the first phase having been undone.
  const coverageNarration = coverageProgress
    ? t("transition.coverage", {
        n: Math.min(coverageProgress.done, coverageProgress.total),
        total: coverageProgress.total,
      })
    : null;

  return { scoringProgress, coverageProgress, scoreInterview, narration, coverageNarration };
}
