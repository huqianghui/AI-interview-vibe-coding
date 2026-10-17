/** The A-to-D grade (docs/network-grades.md): every row of the table, its edges and its gaps. */
import { describe, expect, it } from "vitest";
import { gradeNetwork, type GradeInput } from "./networkGrade";
import type { InterviewNetwork } from "../../api/admin";
import { interviewGrade, isVideoAvatar, liveGrade, type LiveNetwork } from "./usePerformanceTab";

const net = (over: Partial<GradeInput>): GradeInput => ({
  udpOk: true,
  rttMs: 100,
  lossPct: 0,
  downKbps: 5000,
  downCounts: true,
  ...over,
});

describe("gradeNetwork", () => {
  it.each([
    [{ rttMs: 150, lossPct: 0.5, downKbps: 4000 }, "A"],
    [{ rttMs: 151 }, "B"],
    [{ rttMs: 300 }, "B"],
    [{ rttMs: 301 }, "B"], // the study's C is now B's upper half
    [{ rttMs: 500, lossPct: 1, downKbps: 1500 }, "B"],
    [{ lossPct: 0.6 }, "B"],
    [{ rttMs: 100, downKbps: 3999 }, "B"],
    [{ lossPct: 3 }, "C"],
    [{ rttMs: 600 }, "C"],
    [{ downKbps: 999 }, "C"],
  ])("%o is %s", (over, grade) => {
    const result = gradeNetwork(net(over));
    expect(result?.grade).toBe(grade);
    expect(result?.boundary).toBe(false);
  });

  it.each([[{ rttMs: 550 }], [{ lossPct: 2 }], [{ downKbps: 1200 }]])(
    "%o falls between B and C: graded C, marked as a boundary",
    (over) => {
      expect(gradeNetwork(net(over))).toMatchObject({
        grade: "C",
        boundary: true,
        estimated: false,
      });
    },
  );

  it("UDP 3478 blocked is D whatever the rest says", () => {
    expect(gradeNetwork(net({ udpOk: false, rttMs: 20 }))?.grade).toBe("D");
  });

  it("downlink that is not a capacity reading does not grade", () => {
    expect(gradeNetwork(net({ rttMs: 250, downKbps: 846, downCounts: false }))?.grade).toBe("B");
  });

  it("marks B's upper half, where the backend lowers a photo avatar's bitrate", () => {
    expect(gradeNetwork(net({ rttMs: 250 }))?.autoBitrate).toBe(false);
    expect(gradeNetwork(net({ rttMs: 300, lossPct: 0.5 }))?.autoBitrate).toBe(false);
    expect(gradeNetwork(net({ rttMs: 310 }))?.autoBitrate).toBe(true);
    expect(gradeNetwork(net({ rttMs: 200, lossPct: 0.8 }))?.autoBitrate).toBe(true);
    expect(gradeNetwork(net({ rttMs: 100 }))?.autoBitrate).toBe(false); // A
  });

  it("something unmeasured makes it an estimate", () => {
    expect(gradeNetwork(net({ lossPct: null }))?.estimated).toBe(true);
    expect(gradeNetwork(net({ udpOk: null }))?.estimated).toBe(true);
    expect(gradeNetwork(net({ downKbps: null }))?.estimated).toBe(true);
    expect(gradeNetwork(net({}))?.estimated).toBe(false);
  });

  it("says why: the limits of the grade above, or C's own triggers", () => {
    expect(gradeNetwork(net({ rttMs: 100 }))?.reasons).toEqual([]);
    expect(gradeNetwork(net({ rttMs: 400, lossPct: 0.8 }))?.reasons).toEqual([
      { metric: "rtt", value: 400, limit: 150, row: "A" },
      { metric: "loss", value: 0.8, limit: 0.5, row: "A" },
    ]);
    expect(gradeNetwork(net({ rttMs: 700, lossPct: 4 }))?.reasons).toEqual([
      { metric: "loss", value: 4, limit: 3, row: "C" },
      { metric: "rtt", value: 700, limit: 600, row: "C" },
    ]);
    expect(gradeNetwork(net({ rttMs: 550 }))?.reasons).toEqual([
      { metric: "rtt", value: 550, limit: 500, row: "B" },
    ]);
    expect(gradeNetwork(net({ udpOk: false }))?.reasons).toEqual([
      { metric: "udp", value: null, limit: 3478, row: "D" },
    ]);
  });

  it("a C caused only by the downlink says so, and what the rest gives", () => {
    const onlyDown = gradeNetwork(net({ rttMs: 250, downKbps: 800 }));
    expect(onlyDown).toMatchObject({ grade: "C", downlinkOnly: true, withoutDownlink: "B" });
    const notOnly = gradeNetwork(net({ rttMs: 700, downKbps: 800 }));
    expect(notOnly).toMatchObject({ grade: "C", downlinkOnly: false });
    expect(notOnly?.withoutDownlink).toBeUndefined();
  });

  it("a downlink-only C in B's upper half keeps that for the advice", () => {
    expect(gradeNetwork(net({ rttMs: 420, downKbps: 800 }))).toMatchObject({
      grade: "C",
      withoutDownlink: "B",
      withoutDownlinkAutoBitrate: true,
    });
  });

  it("not 'downlink only' in the downlink gap, nor when the rest is C anyway", () => {
    expect(gradeNetwork(net({ rttMs: 250, downKbps: 1200 }))).toMatchObject({
      grade: "C",
      boundary: true,
      downlinkOnly: false,
    });
    expect(gradeNetwork(net({ rttMs: 550, downKbps: 800 }))).toMatchObject({
      grade: "C",
      downlinkOnly: false,
    });
  });

  it("no RTT (or not a number), no grade", () => {
    expect(gradeNetwork(net({ rttMs: null }))).toBeNull();
    expect(gradeNetwork(net({ rttMs: Number.NaN }))).toBeNull();
  });
});

describe("an interview's grade", () => {
  const photo: InterviewNetwork = {
    status: "found",
    media: {
      samples: 5,
      rtt_p95_ms: 294,
      audio_loss_pct: 0,
      available_in_p50_kbps: 846,
      resolution: "512x512",
    },
    avatar: { connected: 1, failed: 0, via_relay: 1, voice_over_ws: 0 },
  };

  it("a photo avatar is graded on RTT and loss (the owner's own interview: B)", () => {
    expect(interviewGrade(photo)).toMatchObject({ grade: "B", boundary: false, estimated: false });
    // Why not A: the RTT, against A's limit.
    expect(interviewGrade(photo)?.reasons).toEqual([
      { metric: "rtt", value: 294, limit: 150, row: "A" },
    ]);
  });

  it("a video avatar's downlink counts", () => {
    const video = { ...photo, media: { ...photo.media!, resolution: "1920x1080" } };
    expect(interviewGrade(video)?.grade).toBe("C");
  });

  it("an avatar that never connected, or a fallback to voice over the WebSocket, is D", () => {
    const failed = {
      ...photo,
      media: null,
      avatar: { connected: 0, failed: 2, via_relay: 0, voice_over_ws: 0 },
    };
    expect(interviewGrade(failed)?.grade).toBe("D");
    const ws = {
      ...photo,
      media: null,
      avatar: { connected: 0, failed: 0, via_relay: 0, voice_over_ws: 1 },
    };
    expect(interviewGrade(ws)?.grade).toBe("D");
  });

  it("an avatar that failed once and then connected passed the UDP gate", () => {
    const retried = {
      ...photo,
      avatar: { connected: 1, failed: 1, via_relay: 1, voice_over_ws: 0 },
    };
    expect(interviewGrade(retried)?.grade).toBe("B");
  });

  it("no media and nothing failed: no grade", () => {
    expect(interviewGrade({ ...photo, media: { ...photo.media!, samples: 0 } })).toBeNull();
  });

  it("isVideoAvatar reads the resolution", () => {
    expect(isVideoAvatar("1920x1080")).toBe(true);
    expect(isVideoAvatar("512x512")).toBe(false);
    expect(isVideoAvatar(null)).toBe(false);
  });
});

describe("this browser's grade", () => {
  const live = (rtts: (number | null)[], over: Partial<LiveNetwork> = {}): LiveNetwork => ({
    // Taken just now, 2 s apart: the grade reads the last minute by time.
    rtt: rtts.map((ms, i) => ({ at: Date.now() - (rtts.length - i) * 2000, ms })),
    ws: null,
    stun: { ok: true, ms: 80 },
    stunFailures: 0,
    downKbps: 8000,
    ...over,
  });

  it("needs three answers, then grades the p95, always as an estimate", () => {
    expect(liveGrade(live([100, null, 100]))).toBeNull();
    expect(liveGrade(live([100, 120, 310]))).toMatchObject({
      grade: "B",
      boundary: false,
      estimated: true,
    });
  });

  it("STUN blocked twice in a row is D; once is not yet", () => {
    const failed = { ok: false as const, reason: "x" };
    expect(liveGrade(live([50, 50, 50], { stun: failed, stunFailures: 1 }))).toMatchObject({
      grade: "A",
      boundary: false,
      estimated: true,
    });
    expect(liveGrade(live([50, 50, 50], { stun: failed, stunFailures: 2 }))?.grade).toBe("D");
  });

  it("no grade while the app mostly stops answering", () => {
    expect(liveGrade(live([50, 50, 50, null, null, null]))).toBeNull();
  });

});
