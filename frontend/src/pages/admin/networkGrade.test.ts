/** The A-to-E grade (docs/network-grades.md): every row of the table, its edges and its gaps. */
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
    [{ rttMs: 300, lossPct: 0.5, downKbps: 2000 }, "B"],
    [{ rttMs: 100, downKbps: 3999 }, "B"],
    [{ rttMs: 301 }, "C"],
    [{ rttMs: 500, lossPct: 1, downKbps: 1500 }, "C"],
    [{ lossPct: 0.6 }, "C"],
    [{ lossPct: 3 }, "D"],
    [{ rttMs: 600 }, "D"],
    [{ downKbps: 999 }, "D"],
  ])("%o is %s", (over, grade) => {
    const result = gradeNetwork(net(over));
    expect(result?.grade).toBe(grade);
    expect(result?.boundary).toBe(false);
  });

  it.each([[{ rttMs: 550 }], [{ lossPct: 2 }], [{ downKbps: 1200 }]])(
    "%o falls between C and D: graded D, marked as a boundary",
    (over) => {
      expect(gradeNetwork(net(over))).toEqual({ grade: "D", boundary: true, estimated: false });
    },
  );

  it("UDP 3478 blocked is E whatever the rest says", () => {
    expect(gradeNetwork(net({ udpOk: false, rttMs: 20 }))?.grade).toBe("E");
  });

  it("downlink that is not a capacity reading does not grade", () => {
    expect(gradeNetwork(net({ rttMs: 250, downKbps: 846, downCounts: false }))?.grade).toBe("B");
  });

  it("something unmeasured makes it an estimate", () => {
    expect(gradeNetwork(net({ lossPct: null }))?.estimated).toBe(true);
    expect(gradeNetwork(net({ udpOk: null }))?.estimated).toBe(true);
    expect(gradeNetwork(net({ downKbps: null }))?.estimated).toBe(true);
    expect(gradeNetwork(net({}))?.estimated).toBe(false);
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
    expect(interviewGrade(photo)).toEqual({ grade: "B", boundary: false, estimated: false });
  });

  it("a video avatar's downlink counts", () => {
    const video = { ...photo, media: { ...photo.media!, resolution: "1920x1080" } };
    expect(interviewGrade(video)?.grade).toBe("D");
  });

  it("an avatar that never connected, or a fallback to voice over the WebSocket, is E", () => {
    const failed = {
      ...photo,
      media: null,
      avatar: { connected: 0, failed: 2, via_relay: 0, voice_over_ws: 0 },
    };
    expect(interviewGrade(failed)?.grade).toBe("E");
    const ws = {
      ...photo,
      media: null,
      avatar: { connected: 0, failed: 0, via_relay: 0, voice_over_ws: 1 },
    };
    expect(interviewGrade(ws)?.grade).toBe("E");
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
    rtt: rtts.map((ms, i) => ({ at: i, ms })),
    ws: null,
    stun: { ok: true, ms: 80 },
    stunFailures: 0,
    downKbps: 8000,
    browser: null,
    ...over,
  });

  it("needs three answers, then grades the p95, always as an estimate", () => {
    expect(liveGrade(live([100, null, 100]))).toBeNull();
    expect(liveGrade(live([100, 120, 310]))).toEqual({
      grade: "C",
      boundary: false,
      estimated: true,
    });
  });

  it("STUN blocked twice in a row is E; once is not yet", () => {
    const failed = { ok: false as const, reason: "x" };
    expect(liveGrade(live([50, 50, 50], { stun: failed, stunFailures: 1 }))).toEqual({
      grade: "A",
      boundary: false,
      estimated: true,
    });
    expect(liveGrade(live([50, 50, 50], { stun: failed, stunFailures: 2 }))?.grade).toBe("E");
  });

  it("no grade while the app mostly stops answering", () => {
    expect(liveGrade(live([50, 50, 50, null, null, null]))).toBeNull();
  });

});
