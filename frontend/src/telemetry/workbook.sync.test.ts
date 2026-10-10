/**
 * The workbook (infra/azure/workbooks/voice-performance.json) and the metric reference
 * (docs/voice-performance-telemetry.md) both name every duration voiceTimeline.ts sends. A span
 * renamed or added here without them would silently fall out of the dashboard (its stage table
 * orders rows by a fixed name list), so the three are pinned together.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AVATAR_SPANS, SETUP_SPANS, TURN_SPANS, type SpanDef } from "./voiceTimeline";

const ROOT = resolve(__dirname, "../../..");
const workbook = JSON.parse(
  readFileSync(resolve(ROOT, "infra/azure/workbooks/voice-performance.json"), "utf8"),
) as { items: { type: number; content: { query?: string } }[] };
const doc = readFileSync(resolve(ROOT, "docs/voice-performance-telemetry.md"), "utf8");

/** The ordered metric list of every stage-table query over `event`. */
function stageLists(event: string): string[][] {
  return workbook.items
    .map((item) => item.content.query ?? "")
    .filter((q) => q.includes(`name == "${event}"`) && q.includes("array_index_of(dynamic(["))
    .map((q) => {
      const list = /array_index_of\(dynamic\(\[([^\]]*)\]\)/.exec(q)![1];
      return list.split(",").map((name) => name.trim().replace(/^"|"$/g, ""));
    });
}

const names = (spans: readonly SpanDef[]) => spans.map(([name]) => name);

describe.each([
  ["voice.setup", SETUP_SPANS, [] as string[]],
  // rtt_ms is a measurement from getStats, not a span between two marks.
  ["voice.avatar", AVATAR_SPANS, ["rtt_ms"]],
  ["voice.turn", TURN_SPANS, [] as string[]],
])("%s", (event, spans, extra) => {
  it("every stage table lists exactly the spans the page sends", () => {
    const lists = stageLists(event);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) expect([...list].sort()).toEqual([...names(spans), ...extra].sort());
  });

  it("every span is defined in the metric reference", () => {
    for (const name of [...names(spans), ...extra]) expect(doc).toContain(`\`${name}\``);
  });
});
