/**
 * Which source files each README screenshot depicts, and the content fingerprint of those sources.
 * Shared by the capture spec (e2e/readme-screenshots.spec.ts), which records the fingerprint next to
 * each shot in docs/images/captures.json, and by readme-screenshots-freshness.test.ts, which checks it.
 *
 * Content, not commit time: the repo lands PRs by squash merge, which rewrites every commit time, so
 * any time-based proof that a recapture came after a source change breaks on main after merge.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Screenshot → the source files whose appearance it is supposed to show (repo-relative). */
export const DEPICTS: Record<string, string[]> = {
  "00-signin.png": ["frontend/src/components/CandidateSignIn.tsx"],
  "01-landing.png": ["frontend/src/components/CandidateIdle.tsx"],
  "01b-orientation.png": ["frontend/src/components/CandidateOrientation.tsx"],
  // The interviewing screen: the page lays out the stage; the question card + answer controls, the
  // status legend, the channel switch and their styles live in pages/interview/.
  "02-interview-question.png": [
    "frontend/src/pages/InterviewPage.tsx",
    "frontend/src/pages/interview/AnswerCard.tsx",
    "frontend/src/pages/interview/StatusLegend.tsx",
    "frontend/src/pages/interview/ChannelSwitch.tsx",
    "frontend/src/pages/interview/styles.ts",
    "frontend/src/components/Transcript.tsx",
  ],
  "04-review-before-scoring.png": ["frontend/src/components/ReviewView.tsx"],
  "05-report-executive.png": ["frontend/src/components/ReportView.tsx"],
  "06-report-detail.png": ["frontend/src/components/ReportView.tsx"],
  // Shared by every screen: the design language and the page shell. A change here restyles all of
  // them at once, which is exactly what went unnoticed for five weeks.
  "*": ["frontend/src/theme.ts", "frontend/src/styles/global.css", "frontend/src/components/AppShell.tsx"],
};

/** The files `image` depicts, its own then the shared ones. */
export function sourcesOf(image: string): string[] {
  return [...(DEPICTS[image] ?? []), ...DEPICTS["*"]];
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One hash over the current content of every file `image` depicts (path + bytes, in order). A
 *  missing file hashes as absent, so a rename changes the fingerprint rather than throwing. */
export function sourcesFingerprint(repoRoot: string, image: string): string {
  const h = createHash("sha256");
  for (const path of sourcesOf(image)) {
    const abs = resolve(repoRoot, path);
    h.update(`${path}\0`);
    h.update(existsSync(abs) ? readFileSync(abs) : "<absent>");
    h.update("\0");
  }
  return h.digest("hex");
}

/** A ledger entry: the shot's bytes and the sources it was taken from. */
export interface CaptureEntry {
  sha256: string;
  sources: string;
  capturedAt: string;
}
