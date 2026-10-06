/**
 * The README's screenshots must not be older than the screens they depict.
 *
 * Why this and not "run the capture script in CI": the capture script
 * (`e2e/readme-screenshots.spec.ts`) is opt-in, so nothing runs it, so nothing says anything when it
 * stops matching the product — which is how five images sat five weeks stale through two redesigns.
 * But putting THAT script in CI would have caught only one of the three failures found on
 * 2026-10-04: the mic-dialog one does not happen on CI (Linux has a fake media device) and the
 * stale-server one *cannot* (`reuseExistingServer: !process.env.CI` means CI always boots fresh).
 *
 * What detects a stale image is comparing it against what it depicts, whatever broke the script. So
 * this asserts, per screenshot, that its last commit is not older than the last commit to the
 * components it shows. It cannot tell whether an image is CORRECT — only a human reading it can do
 * that, which is how the photo-avatar and the four-hour-old-backend captures were caught — but it
 * does make "the screen changed and the picture did not" impossible to merge silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..");

/** Screenshot → the source files whose appearance it is supposed to show. */
const DEPICTS: Record<string, string[]> = {
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

/** Unix timestamp of the last commit touching `path`, or 0 when git knows nothing about it. */
function lastCommit(path: string): number {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", path], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    return out ? Number(out) : 0;
  } catch {
    return 0;
  }
}

describe("README screenshot freshness", () => {
  const shared = DEPICTS["*"];

  for (const [image, sources] of Object.entries(DEPICTS)) {
    if (image === "*") continue;

    it(`${image} is not older than what it depicts`, () => {
      const imagePath = `docs/images/${image}`;
      expect(existsSync(resolve(REPO, imagePath)), `${imagePath} is referenced but missing`).toBe(
        true,
      );

      const shotAt = lastCommit(imagePath);
      expect(shotAt, `${imagePath} has no commit history`).toBeGreaterThan(0);

      for (const src of [...sources, ...shared]) {
        const changedAt = lastCommit(src);
        if (!changedAt) continue; // file renamed or gone — the DEPICTS map is then what needs fixing
        expect(
          shotAt,
          `${imagePath} was last captured before ${src} last changed — recapture it:\n` +
            `  pkill -f "uvicorn app.main:app.*8100"; pkill -f "vite.*5273"\n` +
            `  cd frontend && SCREENSHOTS=1 npx playwright test e2e/readme-screenshots.spec.ts\n` +
            `(kill the stale stack first: playwright reuses a running server, and that server serves ` +
            `the code it booted with)`,
        ).toBeGreaterThanOrEqual(changedAt);
      }
    });
  }

  it("every image the README references is in the freshness map", () => {
    // Otherwise a new screenshot is added and silently exempt for ever.
    const readme = execFileSync("git", ["show", "HEAD:README.md"], { cwd: REPO, encoding: "utf8" });
    const referenced = [...readme.matchAll(/docs\/images\/([a-z0-9.-]+\.png)/g)].map((m) => m[1]);
    const mapped = new Set(Object.keys(DEPICTS));
    // The live-avatar shot needs real Azure and a persona, so it is captured by a different spec and
    // tracked separately; it is named here so the exemption is deliberate rather than accidental.
    const EXEMPT = new Set(["09-live-avatar-voice.png", "07-admin-rubric-editor.png", "08-admin-agent-editor.png"]);
    const unmapped = [...new Set(referenced)].filter((f) => !mapped.has(f) && !EXEMPT.has(f));
    expect(unmapped, `add these to DEPICTS or EXEMPT: ${unmapped.join(", ")}`).toEqual([]);
  });
});
