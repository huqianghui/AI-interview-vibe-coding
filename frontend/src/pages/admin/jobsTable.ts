/** Formatting for the admin Jobs table. */
import type { JobItem } from "../../api/admin";
import { parseUtc } from "../../components/transcriptText";

const utc = (text: string) => parseUtc(text).getTime();

/** How long it ran, or has been running: "42 s", "3 min 5 s". */
export function duration(job: JobItem, now: number = Date.now()): string {
  // A queued job has not started (again: one requeued after its runner died keeps the old start).
  if (!job.started_at || job.status === "queued") return "—";
  const start = utc(job.started_at);
  const end = job.finished_at ? utc(job.finished_at) : now;
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
