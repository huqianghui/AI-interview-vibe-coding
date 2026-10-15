/**
 * The A-to-E network grade of docs/network-grades.md (from the Voice Live weak-network study,
 * §7.6.2): three numbers (RTT, UDP loss, downlink) plus a UDP gate pick the starting form of the
 * interview. Used twice: on an interview's own WebRTC telemetry (authoritative) and on this
 * browser's quick check (an estimate: no UDP loss, TCP RTT to the region instead of the media
 * path).
 */

export type Grade = "A" | "B" | "C" | "D" | "E";

export interface GradeInput {
  /** UDP 3478 reachable (false = E); null = not known. */
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
  /** Why it is not one grade better (for D: what triggered it; empty for A). */
  reasons: GradeReason[];
  /** D only because of the downlink: on the browser check, a measurement that underestimates a
   * distant link. */
  downlinkOnly: boolean;
  /** With `downlinkOnly`: the grade the other numbers alone give. */
  withoutDownlink?: Grade;
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
  { grade: "B", rtt: 300, loss: 0.5, down: 2000 },
  { grade: "C", rtt: 500, loss: 1, down: 1500 },
];
// D: any one of these.
const D_LOSS = 3;
const D_RTT = 600;
const D_DOWN = 1000;

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
    estimated: grade === "E" ? false : estimated,
    reasons,
    downlinkOnly: false,
  });
  if (udpOk === false) {
    return result("E", [{ metric: "udp", value: null, limit: 3478, row: "E" }]);
  }
  if (rttMs === null || !Number.isFinite(rttMs)) return null;
  const down = downCounts ? downKbps : null;
  const loss = lossPct ?? 0;
  const triggers: GradeReason[] = [];
  if (loss >= D_LOSS) triggers.push({ metric: "loss", value: loss, limit: D_LOSS, row: "D" });
  if (rttMs >= D_RTT) triggers.push({ metric: "rtt", value: rttMs, limit: D_RTT, row: "D" });
  if (down !== null && down < D_DOWN) {
    triggers.push({ metric: "down", value: down, limit: D_DOWN, row: "D" });
  }
  if (triggers.length) {
    const graded = result("D", triggers);
    if (triggers.every((r) => r.metric === "down")) {
      const rest = gradeNetwork({ ...input, downCounts: false })?.grade;
      // Only worth saying when the other numbers alone give a better start.
      if (rest && rest !== "D") {
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
  return result("D", broken(ROWS[ROWS.length - 1], rttMs, loss, down), true);
}
