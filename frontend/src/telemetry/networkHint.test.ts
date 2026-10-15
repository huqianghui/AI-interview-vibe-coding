/** The network hint the voice WebSocket carries (the backend picks a photo avatar's bitrate). */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_FRESH_MS,
  measurePreconnect,
  networkHint,
  recordMediaWindow,
  resetNetworkHintForTests,
} from "./networkHint";

afterEach(() => {
  resetNetworkHintForTests();
  vi.restoreAllMocks();
});

describe("networkHint", () => {
  it("knows nothing at first", () => {
    expect(networkHint()).toEqual({ rttMs: null, lossPct: null });
  });

  it("remembers this browser's media windows: RTT p95 and mean loss", () => {
    [280, 300, 320, 900].forEach((rtt, i) => recordMediaWindow(rtt, i === 3 ? 2 : 0));
    expect(networkHint()).toEqual({ rttMs: 900, lossPct: 0.5 });
  });

  it("a window without a reading adds nothing for it", () => {
    recordMediaWindow(undefined, 0.4);
    recordMediaWindow(250, undefined);
    expect(networkHint()).toEqual({ rttMs: 250, lossPct: 0.4 });
  });

  it("forgets media numbers after a day", () => {
    recordMediaWindow(450, 0.8);
    expect(networkHint(Date.now() + MEDIA_FRESH_MS + 1)).toEqual({ rttMs: null, lossPct: null });
  });

  it("the pre-connect round trip counts, and the worse of the two wins", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error("lost");
      return new Response("{}");
    }) as unknown as typeof fetch;
    await measurePreconnect(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const pre = networkHint().rttMs;
    expect(pre).toEqual(expect.any(Number));
    recordMediaWindow(5000, 0);
    expect(networkHint().rttMs).toBe(5000);
  });

  it("storage that refuses changes nothing and never throws", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => recordMediaWindow(300, 0)).not.toThrow();
    expect(networkHint()).toEqual({ rttMs: null, lossPct: null });
  });
});
