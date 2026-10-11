/** Formatting for the admin Jobs table. */
import type { JobItem } from "../../api/admin";

/** A naive UTC timestamp from the backend ("2026-10-11T06:00:00") as epoch milliseconds. */
function utc(text: string): number {
  return Date.parse(/[Zz]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
}

/** How long it ran, or has been running: "42 s", "3 min 5 s". */
export function duration(job: JobItem, now: number = Date.now()): string {
  if (!job.started_at) return "—";
  const start = utc(job.started_at);
  const end = job.finished_at ? utc(job.finished_at) : now;
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
