import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  events: [] as { event: { name: string; measurements?: Record<string, number> }; props?: unknown }[],
  initializers: [] as ((item: unknown) => void)[],
}));
vi.mock("@microsoft/applicationinsights-web", () => ({
  DistributedTracingModes: { W3C: 2 },
  ApplicationInsights: class {
    constructor(opts: { config: Record<string, unknown> }) {
      sdk.config = opts.config;
    }
    loadAppInsights() {}
    trackPageView() {}
    addTelemetryInitializer(fn: (item: unknown) => void) {
      sdk.initializers.push(fn);
    }
    trackEvent(event: { name: string }, props?: unknown) {
      sdk.events.push({ event, props });
    }
  },
}));

import { resetTelemetryForTests, scrubItem, startTelemetry, stripQuery, trackEvent } from "./appInsights";

afterEach(() => {
  vi.unstubAllGlobals();
  resetTelemetryForTests();
});

describe("URL scrubbing", () => {
  it("drops query strings and fragments, where a session token can ride", () => {
    expect(stripQuery("https://h/api/voice-live/ws?token=abc&locale=en")).toBe("https://h/api/voice-live/ws");
    expect(stripQuery("/interview#x")).toBe("/interview");
    expect(stripQuery("/plain")).toBe("/plain");
  });

  it("scrubs every URL field of a telemetry item and leaves the rest alone", () => {
    const item = {
      baseData: {
        name: "GET /api/x?token=1",
        uri: "https://h/p?token=2",
        target: "h/api?x=3",
        data: "https://h/api/x?token=4",
        duration: 12,
      },
    };
    scrubItem(item);
    expect(item.baseData).toEqual({
      name: "GET /api/x",
      uri: "https://h/p",
      target: "h/api",
      data: "https://h/api/x",
      duration: 12,
    });
    scrubItem({}); // no baseData: nothing to do
  });
});

describe("start-up", () => {
  it("loads the SDK with the deployment's string and hands over what was recorded before", async () => {
    sdk.events.length = 0;
    sdk.initializers.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ app_insights_connection_string: "InstrumentationKey=k" }))),
    );
    trackEvent("early", { x: 1 }, { k: "v" });
    expect(await startTelemetry()).toBe(true);
    trackEvent("late", { y: 2 });
    expect(sdk.config).toMatchObject({ connectionString: "InstrumentationKey=k", disableCookiesUsage: true });
    expect(sdk.events.map((e) => e.event.name)).toEqual(["early", "late"]);
    expect(sdk.events[0]).toEqual({ event: { name: "early", measurements: { x: 1 } }, props: { k: "v" } });
    // The scrubber is installed on every item the SDK sends.
    const item = { baseData: { uri: "https://h/p?token=1" } };
    sdk.initializers[0](item);
    expect(item.baseData.uri).toBe("https://h/p");
  });

  it("stays off and drops the buffer when the deployment has no App Insights", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ app_insights_connection_string: null }))),
    );
    trackEvent("early", {});
    expect(await startTelemetry()).toBe(false);
    expect(await startTelemetry()).toBe(false); // idempotent: one config fetch
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/public/client-config", expect.anything());
  });

  it("retries a failed config read once, then gives up without throwing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const result = startTelemetry();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("recovers when the retry succeeds, keeping what was buffered", async () => {
    vi.useFakeTimers();
    sdk.events.length = 0;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1
          ? new Response("busy", { status: 503 })
          : new Response(JSON.stringify({ app_insights_connection_string: "InstrumentationKey=k" })),
      ),
    );
    trackEvent("during-outage", {});
    const result = startTelemetry();
    await vi.advanceTimersByTimeAsync(10_050); // the retry delay, then the idle wait
    expect(await result).toBe(true);
    expect(sdk.events.map((e) => e.event.name)).toContain("during-outage");
    vi.useRealTimers();
  });

  it("cuts an HttpError message down to its status, so a response body never ships", () => {
    const item = {
      baseData: { exceptions: [{ typeName: "HttpError", message: "422 Unprocessable: {\"detail\":\"text\"}" }] },
    };
    scrubItem(item);
    expect(item.baseData.exceptions[0].message).toBe("422 Unprocessable");
  });
});
