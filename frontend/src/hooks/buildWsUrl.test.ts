/** The voice WebSocket URL carries this browser's network hint (the backend picks the bitrate). */
import { afterEach, describe, expect, it } from "vitest";
import { buildWsUrl } from "./useInterviewVoice";
import { recordMediaWindow, resetNetworkHintForTests } from "../telemetry/networkHint";

afterEach(() => resetNetworkHintForTests());

const params = (url: string) => new URL(url).searchParams;

describe("buildWsUrl network hint", () => {
  it("no hint, no parameters", () => {
    const p = params(buildWsUrl("tok", undefined, "en-US"));
    expect(p.has("net_rtt")).toBe(false);
    expect(p.has("net_loss")).toBe(false);
  });

  it("sends the remembered RTT and loss", () => {
    recordMediaWindow(420, 0.333);
    const p = params(buildWsUrl("tok", undefined, "en-US"));
    expect(p.get("net_rtt")).toBe("420");
    expect(p.get("net_loss")).toBe("0.33");
  });
});
