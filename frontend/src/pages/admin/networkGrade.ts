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

export interface GradeResult {
  grade: Grade;
  /** Between two rows of the table (e.g. RTT 500 to 600 ms): graded as the worse one, the safer
   * start. */
  boundary: boolean;
  /** Something the grade needed was not measured, so it may be better or worse than shown. */
  estimated: boolean;
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

export function gradeNetwork(input: GradeInput): GradeResult | null {
  const { udpOk, rttMs, lossPct, downKbps, downCounts } = input;
  const estimated = lossPct === null || udpOk === null || (downCounts && downKbps === null);
  if (udpOk === false) return { grade: "E", boundary: false, estimated: false };
  if (rttMs === null || !Number.isFinite(rttMs)) return null;
  const down = downCounts ? downKbps : null;
  const loss = lossPct ?? 0;
  if (loss >= D_LOSS || rttMs >= D_RTT || (down !== null && down < D_DOWN)) {
    return { grade: "D", boundary: false, estimated };
  }
  for (const row of ROWS) {
    if (rttMs <= row.rtt && loss <= row.loss && (down === null || down >= row.down)) {
      return { grade: row.grade, boundary: false, estimated };
    }
  }
  return { grade: "D", boundary: true, estimated };
}
