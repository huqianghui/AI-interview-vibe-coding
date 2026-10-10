import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  events: [] as { event: { name: string; measurements?: Record<string, number> }; props?: unknown }[],
  initializers: [] as ((item: unknown) => void)[],
  flushes: 0,
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
    flush() {
      sdk.flushes += 1;
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
    expect(await startTelemetry("tok")).toBe(true);
    trackEvent("late", { y: 2 });
    expect(sdk.config).toMatchObject({ connectionString: "InstrumentationKey=k", disableCookiesUsage: true });
    expect(sdk.events.map((e) => e.event.name)).toEqual(["early", "late"]);
    expect(sdk.flushes).toBe(2); // each event leaves at once, not with the next 15 s batch
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
    expect(await startTelemetry("tok")).toBe(false);
    expect(await startTelemetry("tok")).toBe(false); // idempotent: one config fetch
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/client-config", expect.anything());
    // The backend hands the string only to a signed-in user: the token rides as a bearer.
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("does nothing before sign-in, and starts at the first sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ app_insights_connection_string: null }))),
    );
    expect(await startTelemetry("")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await startTelemetry("tok");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a sign-in during a start that is then refused gets its turn, in the same start", async () => {
    sdk.events.length = 0;
    let release!: () => void;
    const tokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const bearer = new Headers(init.headers).get("Authorization") ?? "";
        tokens.push(bearer);
        if (bearer === "Bearer stale") {
          await new Promise<void>((r) => (release = r));
          return new Response("expired", { status: 401 });
        }
        return new Response(JSON.stringify({ app_insights_connection_string: "InstrumentationKey=k" }));
      }),
    );
    const first = startTelemetry("stale"); // a stored session, checked on load
    await Promise.resolve();
    const second = startTelemetry("fresh"); // the candidate signs in meanwhile
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(tokens).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("stops buffering once the deployment turns out to have no App Insights", async () => {
    sdk.events.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ app_insights_connection_string: null }))),
    );
    expect(await startTelemetry("tok")).toBe(false);
    for (let i = 0; i < 5; i++) trackEvent("never-sent", {});
    expect(await startTelemetry("tok2")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // known to be off: no more config reads
  });

  it("waits for the next sign-in when the backend refuses the token (403)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    expect(await startTelemetry("tok")).toBe(false);
    expect(await startTelemetry("tok2")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2); // not latched off, and no 10 s retry
  });

  it("waits for the next sign-in when a stored session has expired", async () => {
    sdk.events.length = 0;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1
          ? new Response("expired", { status: 401 })
          : new Response(JSON.stringify({ app_insights_connection_string: "InstrumentationKey=k" })),
      ),
    );
    trackEvent("before-sign-in", {});
    expect(await startTelemetry("stale")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // no 10 s retry for a refusal
    expect(await startTelemetry("fresh")).toBe(true);
    expect(sdk.events.map((e) => e.event.name)).toContain("before-sign-in");
  });

  it("retries a failed config read once, then gives up without throwing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const result = startTelemetry("tok");
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
    const result = startTelemetry("tok");
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
