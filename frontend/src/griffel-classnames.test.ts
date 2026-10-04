/**
 * Source-level guard: never join griffel class names by hand.
 *
 * Griffel (Fluent v9's `makeStyles`) emits ATOMIC classes and resolves conflicts through
 * `mergeClasses`. Joining two of its class names with a template string instead leaves the winner
 * to CSS source order, so the override you wrote is applied or dropped essentially by accident.
 *
 * This is not theoretical. The orientation screen's progress rail was written as
 * `` className={`${styles.tick} ${i === 0 ? styles.tickNow : ""}`} ``, and measured in a real
 * browser the "you are here" tick rendered rgb(207,195,177) — the same neutral as every other tick,
 * with the magenta marker silently gone.
 *
 * It needs to be a SOURCE check rather than a render check: measured both ways, jsdom renders the
 * broken form correctly, so the component test for that marker passes on the bug. jsdom does not
 * reproduce griffel's atomic-class ordering, which makes a DOM assertion useless here and this
 * string match the only thing that actually holds the line in CI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Known pre-existing offenders, exempt BY NAME rather than by a path glob so the list cannot grow
 * silently — a new file has to be added here deliberately, in a diff someone reviews.
 *
 * Both are in the operator-facing agent editor, which the owner has explicitly put out of scope
 * for now ("admin/agent 先不要变", 2026-10-04). They are not candidate-facing, so a dropped style
 * override there costs an operator a slightly wrong-looking control rather than costing a
 * candidate their interview. Filed in TODOS.md to be fixed with that screen's own pass.
 */
const KNOWN_OFFENDERS = new Set([
  "src/components/agent-editor/AvatarGrid.tsx:190",
  "src/components/agent-editor/PlaygroundPanel.tsx:258",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p) && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

describe("griffel class names", () => {
  it("are never joined with a template string — use mergeClasses", () => {
    const root = resolve(process.cwd(), "src");
    const offenders: string[] = [];

    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        // A className whose value is a template literal interpolating two or more `styles.*`.
        if (!/className=\{`/.test(line)) return;
        const interpolations = line.match(/\$\{[^}]*styles\.[^}]*\}/g) ?? [];
        if (interpolations.length >= 2) {
          const at = `${file.replace(root, "src")}:${i + 1}`;
          if (!KNOWN_OFFENDERS.has(at)) offenders.push(at);
        }
      });
    }

    expect(
      offenders,
      `Join griffel classes with mergeClasses(a, b), not a template string:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the exemption list honest — every entry still exists", () => {
    // An exemption that no longer points at real code is worse than no exemption: it hides the next
    // offender that happens to land on that line number. If this fails, the file was fixed or moved
    // and the entry should be deleted.
    const root = resolve(process.cwd(), "src");
    for (const entry of KNOWN_OFFENDERS) {
      const [rel, lineNo] = entry.split(":");
      const lines = readFileSync(
        resolve(root, "..", rel),
        "utf8",
      ).split("\n");
      const line = lines[Number(lineNo) - 1] ?? "";
      expect(line, `${entry} no longer joins griffel classes — remove the exemption`).toMatch(
        /className=\{`/,
      );
    }
  });
});
