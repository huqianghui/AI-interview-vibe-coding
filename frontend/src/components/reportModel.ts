/**
 * Report rules shared by the two renderers of a report: the page (ReportView) and the PDF
 * (reportPdf). Each one used to carry its own copy, so a change to either rule would have made the
 * downloaded PDF disagree with the screen it was downloaded from.
 */
import type { Report } from "../api/client";

/** The backend tags an advisory (CONFLICT-001) disclosure with this stable English prefix so it can
 * be told apart from a hard critical-error warning regardless of the display locale. */
export const ADVISORY_PREFIX = "Advisory item disclosed";

/** The report's warnings split into hard critical-error warnings and neutral disclosures: a
 * disclosure is transparency (it does not cap), a warning is a failure to flag. */
export function splitWarnings(report: Report): { critical: string[]; disclosures: string[] } {
  const warnings = report.warnings ?? [];
  return {
    critical: warnings.filter((w) => !w.startsWith(ADVISORY_PREFIX)),
    disclosures: warnings.filter((w) => w.startsWith(ADVISORY_PREFIX)),
  };
}

/** How many questions could not be scored. Prefers the per-question flag over the id list: both come
 * from the same decision, and the flag is what the rows are rendered from, so the banner's count can
 * never disagree with them. */
export function unscoredCount(report: Report): number {
  return (
    report.per_question.filter((q) => q.scoring_failed).length ||
    (report.unscored_question_ids?.length ?? 0)
  );
}
