/**
 * The A-to-D network grade of docs/network-grades.md: three numbers (RTT, UDP loss, downlink) plus
 * a UDP gate pick the starting form of the interview. From the Voice Live weak-network study's
 * A-to-E table (§7.6.2) with its B and C merged into one grade, "photo avatar" (owner, 2026-10-15):
 * both start with a photo avatar, and what told them apart, the video bitrate, the backend now picks
 * per session by itself (voice_live_proxy.choose_avatar_bitrate). So: A = the study's A, B = its B
 * and C, C = its D, D = its E.
 *
 * Used twice: on an interview's own WebRTC telemetry (authoritative) and on this browser's quick
 * check (an estimate: no UDP loss, TCP RTT to the region instead of the media path).
 */

export type Grade = "A" | "B" | "C" | "D";

export interface GradeInput {
  /** UDP 3478 reachable (false = D); null = not known. */
  udpOk: boolean | null;
  rttMs: number | null;
  /** Audio packet loss in percent; null = not measured (the browser check). */
  lossPct: number | null;
  downKbps: number | null;
  /** Whether downlink is a capacity reading. Chrome's `availableIncomingBitrate` only rises
   * to what is being sent, so a photo avatar's ~0.8 Mbps says nothing about the link: there it
   * is shown, not graded. */
  downCounts: boolean;
}

/** One number that set the grade, against the table limit it crossed: "RTT 294 ms > 150 ms, A's
 * limit". `row` is the grade whose limit it is (D for D's own triggers). */
export interface GradeReason {
  metric: "rtt" | "loss" | "down" | "udp";
  value: number | null;
  limit: number | null;
  row: Grade;
}

export interface GradeResult {
  grade: Grade;
  /** Between two rows of the table (e.g. RTT 500 to 600 ms): graded as the worse one, the safer
   * start. */
  boundary: boolean;
  /** Something the grade needed was not measured, so it may be better or worse than shown. */
  estimated: boolean;
  /** Why it is not one grade better (for C: what triggered it; empty for A). */
  reasons: GradeReason[];
  /** C only because of the downlink: on the browser check, a measurement that underestimates a
   * distant link. */
  downlinkOnly: boolean;
  /** With `downlinkOnly`: the grade the other numbers alone give. */
  withoutDownlink?: Grade;
  /** B in its upper half (RTT > 300 ms or loss > 0.5%): there the backend lowers a photo
   * avatar's video bitrate for each new session by itself. */
  autoBitrate: boolean;
}

interface Row {
  grade: Grade;
  rtt: number;
  loss: number;
  down: number;
}

// docs/network-grades.md, verbatim: the best row whose every limit holds.
const ROWS: Row[] = [
  { grade: "A", rtt: 150, loss: 0.5, down: 4000 },
  { grade: "B", rtt: 500, loss: 1, down: 1500 },
];
// C: any one of these.
const C_LOSS = 3;
const C_RTT = 600;
const C_DOWN = 1000;
/** Where B's upper half begins (the study's C): there the backend lowers a photo avatar's
 * bitrate by itself. Mirrors voice_live_proxy.AUTO_BITRATE_RTT_MS / _LOSS_PCT. */
export const AUTO_BITRATE_RTT_MS = 300;
export const AUTO_BITRATE_LOSS_PCT = 0.5;

/** The limits of `row` that the numbers break. */
function broken(row: Row, rtt: number, loss: number, down: number | null): GradeReason[] {
  const out: GradeReason[] = [];
  if (rtt > row.rtt) out.push({ metric: "rtt", value: rtt, limit: row.rtt, row: row.grade });
  if (loss > row.loss) out.push({ metric: "loss", value: loss, limit: row.loss, row: row.grade });
  if (down !== null && down < row.down) {
    out.push({ metric: "down", value: down, limit: row.down, row: row.grade });
  }
  return out;
}

export function gradeNetwork(input: GradeInput): GradeResult | null {
  const { udpOk, rttMs, lossPct, downKbps, downCounts } = input;
  const estimated = lossPct === null || udpOk === null || (downCounts && downKbps === null);
  const result = (grade: Grade, reasons: GradeReason[], boundary = false): GradeResult => ({
    grade,
    boundary,
    estimated: grade === "D" ? false : estimated,
    reasons,
    downlinkOnly: false,
    autoBitrate:
      grade === "B" &&
      ((rttMs ?? 0) > AUTO_BITRATE_RTT_MS || (lossPct ?? 0) > AUTO_BITRATE_LOSS_PCT),
  });
  if (udpOk === false) {
    return result("D", [{ metric: "udp", value: null, limit: 3478, row: "D" }]);
  }
  if (rttMs === null || !Number.isFinite(rttMs)) return null;
  const down = downCounts ? downKbps : null;
  const loss = lossPct ?? 0;
  const triggers: GradeReason[] = [];
  if (loss >= C_LOSS) triggers.push({ metric: "loss", value: loss, limit: C_LOSS, row: "C" });
  if (rttMs >= C_RTT) triggers.push({ metric: "rtt", value: rttMs, limit: C_RTT, row: "C" });
  if (down !== null && down < C_DOWN) {
    triggers.push({ metric: "down", value: down, limit: C_DOWN, row: "C" });
  }
  if (triggers.length) {
    const graded = result("C", triggers);
    if (triggers.every((r) => r.metric === "down")) {
      const rest = gradeNetwork({ ...input, downCounts: false })?.grade;
      // Only worth saying when the other numbers alone give a better start.
      if (rest && rest !== "C") {
        graded.downlinkOnly = true;
        graded.withoutDownlink = rest;
      }
    }
    return graded;
  }
  for (const [i, row] of ROWS.entries()) {
    if (broken(row, rttMs, loss, down).length === 0) {
      return result(row.grade, i === 0 ? [] : broken(ROWS[i - 1], rttMs, loss, down));
    }
  }
  return result("C", broken(ROWS[ROWS.length - 1], rttMs, loss, down), true);
}
