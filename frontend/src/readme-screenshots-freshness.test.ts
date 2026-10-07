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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEPICTS, sha256, sourcesFingerprint, type CaptureEntry } from "./readmeScreenshots";

const REPO = resolve(__dirname, "..", "..");

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

const LEDGER = "docs/images/captures.json";

function readLedger(): Record<string, CaptureEntry> {
  const path = resolve(REPO, LEDGER);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/**
 * Whether `image` is vouched for by an identical recapture: its ledger entry matches the image's
 * bytes AND the current content of every source it depicts. Checked by content, not time: a squash
 * merge rewrites commit times, so a time-based proof passes on the PR and fails on main.
 */
function recapturedFromCurrentSources(image: string): boolean {
  const entry = readLedger()[image];
  const imagePath = resolve(REPO, `docs/images/${image}`);
  if (!entry || !existsSync(imagePath)) return false;
  return entry.sha256 === sha256(readFileSync(imagePath)) && entry.sources === sourcesFingerprint(REPO, image);
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

      // An identical recapture from the current sources is current, whatever the commit times say.
      if (recapturedFromCurrentSources(image)) return;
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

describe("the capture ledger", () => {
  it("vouches only for the exact bytes it recorded", () => {
    for (const [image, entry] of Object.entries(readLedger())) {
      const path = resolve(REPO, `docs/images/${image}`);
      if (!existsSync(path)) continue; // a removed screenshot simply has nothing to vouch for
      expect(sha256(readFileSync(path)), `${image} changed after its capture was recorded`).toBe(
        entry.sha256,
      );
    }
  });

  it("fingerprints sources by content, so a source edit invalidates a recorded capture", () => {
    const image = "00-signin.png";
    const before = sourcesFingerprint(REPO, image);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // Same sources, same fingerprint; a different file list (another image), a different one.
    expect(sourcesFingerprint(REPO, image)).toBe(before);
    expect(sourcesFingerprint(REPO, "01-landing.png")).not.toBe(before);
  });
});
