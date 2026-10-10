/**
 * Application Insights in the browser: page views, the page's own `/api` calls (correlated with the
 * backend's traces through W3C `traceparent`), uncaught errors, and the voice timing events from
 * `voiceTimeline.ts`.
 *
 * Off unless the deployment has App Insights: the connection string comes from the backend at run
 * time (`GET /client-config`), because one image is deployed into every environment. The backend
 * hands it only to a signed-in candidate or admin, so telemetry starts at sign-in (or on load, when a
 * session is already stored). The SDK is loaded with a dynamic import so it lands in its own chunk
 * and never delays the first paint or the voice prewarm.
 *
 * Telemetry carries ids, timings, counts and outcomes, never a transcript, an answer, a question or
 * any SOP text. Query strings are stripped from every URL before it leaves the page: some carry a
 * session token.
 */
import { HttpError, requestJson } from "../api/http";

/** `GET /client-config` (pinned against the backend schema in `api/contract.check.ts`). */
export interface ClientConfig {
  app_insights_connection_string?: string | null;
}

type Measurements = Record<string, number>;
type Properties = Record<string, string | number | boolean>;

interface Sink {
  /** `urgent` events leave at once; the rest go with the SDK's next batch. */
  trackEvent(name: string, measurements: Measurements, properties: Properties, urgent: boolean): void;
  /** A browser-side call App Insights does not see by itself (the voice WebSocket). */
  trackDependency?(dependency: {
    id: string;
    name: string;
    target: string;
    type: string;
    duration: number;
    success: boolean;
    responseCode: number;
    startTime: Date;
    properties: Record<string, string | boolean>;
  }, urgent: boolean): void;
  /** Send everything queued with the page-unload transport (a beacon), which survives the page. */
  unloadFlush?(): void;
  /** The page's current trace id (32 hex), or null. */
  traceId?(): string | null;
}

// Events recorded before the SDK is ready (the voice session prewarms on page load, in parallel with
// the config fetch). Bounded so a page that never gets telemetry cannot grow it without limit.
const MAX_BUFFERED = 200;
let buffered: {
  name: string;
  measurements: Measurements;
  properties: Properties;
  urgent: boolean;
}[] = [];
let sink: Sink | null = null;
/** The deployment has no App Insights: nothing will ever be sent, so nothing is buffered either. */
let disabled = false;
/** The start in flight, if any: concurrent callers share it instead of racing it. */
let starting: Promise<boolean> | null = null;
/** The newest signed-in token we were given. Every attempt reads it, so a sign-in that lands while
 * an earlier start is still running (or waiting to retry) is never lost. */
let latestToken = "";
const START_ATTEMPTS = 2;
const START_RETRY_MS = 10_000;

/** Strip the query string (and fragment) from a URL-ish value. */
export function stripQuery(value: string): string {
  return value.replace(/[?#].*$/, "");
}

const URL_FIELDS = ["uri", "refUri", "name", "target", "data", "url"] as const;

/** Remove query strings from every URL field of a telemetry item, in place, and cut an `HttpError`
 * message down to its status: the API layer puts the response body in the message
 * (`api/http.ts`), and a body can carry text. Exported for tests. */
export function scrubItem(item: { baseData?: Record<string, unknown> }): void {
  const data = item.baseData;
  if (!data) return;
  for (const field of URL_FIELDS) {
    const value = data[field];
    if (typeof value === "string") data[field] = stripQuery(value);
  }
  const exceptions = data.exceptions;
  if (Array.isArray(exceptions)) {
    for (const ex of exceptions as { typeName?: string; message?: string }[]) {
      if (ex.typeName === "HttpError" && typeof ex.message === "string") {
        ex.message = ex.message.split(":")[0];
      }
    }
  }
}

/** Record one custom event. Safe to call at any time: before start-up it is buffered, and without
 * App Insights it is dropped. `urgent` (the default) sends it at once; periodic samples pass false
 * and ride the SDK's next batch. */
export function trackEvent(
  name: string,
  measurements: Measurements,
  properties: Properties = {},
  urgent = true,
): void {
  if (sink) {
    try {
      sink.trackEvent(name, measurements, properties, urgent);
    } catch (err) {
      console.debug("[telemetry] trackEvent failed", err);
    }
    return;
  }
  if (!disabled && buffered.length < MAX_BUFFERED) {
    buffered.push({ name, measurements, properties, urgent });
  }
}

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

export interface WebSocketTrace {
  /** W3C `traceparent` for the backend to parent its session span on, or null before the SDK is up. */
  traceparent: string | null;
  /** The session went live on this socket (`session.updated`): only then can its end be a success. */
  markLive(): void;
  /** Report the socket as a dependency. `clean` = the close itself was normal; success needs that AND
   * a session that went live. Idempotent: the first path to end a socket decides. `unloading`: the
   * page is going away, so the record is only queued and {@link flushForUnload} sends it. */
  end(code: number, clean: boolean, reason?: string, unloading?: boolean): void;
}

/**
 * Trace one WebSocket the SDK cannot see by itself. The page passes `traceparent` when it opens the
 * socket (a WebSocket cannot carry headers, so it rides the query string), the backend starts its
 * span as a child of it, and `end()` records the socket as a dependency with that same id: in App
 * Insights the browser's socket and the backend's session become one parent/child pair in the page's
 * trace. The dependency is pinned to the trace it OPENED in (`trace_id`, applied by the telemetry
 * initializer), even if the page has moved to another route by the time it closes. Opened before the
 * SDK has loaded, the socket is still recorded at `end()`, just unlinked.
 */
export function beginWebSocketTrace(name: string, target: string): WebSocketTrace {
  let id = "";
  let traceId: string | null = null;
  try {
    id = randomHex(8);
    const current = sink?.traceId?.() ?? null;
    if (current && /^[0-9a-f]{32}$/.test(current)) traceId = current;
  } catch (err) {
    console.debug("[telemetry] no trace context", err);
  }
  const traceparent = traceId && id ? `00-${traceId}-${id}-01` : null;
  const startTime = new Date();
  const started = performance.now();
  let live = false;
  let ended = false;
  return {
    traceparent,
    markLive() {
      live = true;
    },
    end(code, clean, reason, unloading = false) {
      if (ended) return;
      ended = true;
      try {
        const properties: Record<string, string | boolean> = { live };
        if (reason) properties.close_reason = reason.slice(0, 64);
        if (traceId) properties.trace_id = traceId;
        sink?.trackDependency?.({
          id: id || randomHex(8),
          name,
          target,
          type: "WebSocket",
          duration: performance.now() - started,
          success: live && clean,
          responseCode: code,
          startTime,
          properties,
        }, !unloading);
      } catch (err) {
        console.debug("[telemetry] WebSocket dependency failed", err);
      }
    },
  };
}

/**
 * The page is being hidden for good (`pagehide`: tab closed, navigated away): send what is queued
 * with the SDK's unload transport. An ordinary send started now is cancelled with the page, which is
 * how a tab closed mid-interview lost its socket record and its last quality window (measured live).
 * Call it after queueing the last events, and queue those WITHOUT their usual immediate send, which
 * would move them into a request that dies with the page.
 */
export function flushForUnload(): void {
  try {
    sink?.unloadFlush?.();
  } catch (err) {
    console.debug("[telemetry] unload flush failed", err);
  }
}

/** A WebSocket dependency carries the trace it opened in; put it back on the item, where App Insights
 * reads the operation from (exported for tests). */
export function pinOperation(item: {
  baseData?: Record<string, unknown>;
  tags?: Record<string, unknown>;
}): void {
  const data = item.baseData;
  const props = data?.properties as Record<string, unknown> | undefined;
  const traceId = props?.trace_id;
  if (data?.type !== "WebSocket" || typeof traceId !== "string") return;
  // Set in place: the SDK's `tags` may be its legacy array-backed object, which a spread would break.
  if (!item.tags) item.tags = {};
  item.tags["ai.operation.id"] = traceId;
}

/** Resolve when the main thread is idle (or after `timeoutMs`), so the SDK's download, parse and
 * fetch patching stay out of the way of the voice prewarm that starts on page load. */
function whenIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** With a signed-in user's `token`, fetch the runtime config and, when the deployment has App
 * Insights, load the SDK once the page is idle. Events recorded meanwhile are buffered. Without a
 * token, or with one the backend refuses (expired), nothing starts and the next sign-in tries again;
 * a sign-in during a start in flight is picked up by it. Never throws (telemetry must not break the
 * page). Resolves whether telemetry is running. */
export function startTelemetry(token: string): Promise<boolean> {
  if (token) latestToken = token;
  if (sink) return Promise.resolve(true);
  if (disabled || !latestToken) return Promise.resolve(false);
  if (!starting) {
    starting = runStart().finally(() => {
      starting = null;
    });
  }
  return starting;
}

async function runStart(): Promise<boolean> {
  let failures = 0;
  for (;;) {
    const token = latestToken;
    try {
      const config = await requestJson<ClientConfig>("/client-config", {}, { bearer: token });
      const connectionString = config.app_insights_connection_string;
      if (!connectionString) {
        disabled = true;
        buffered = [];
        return false;
      }
      await loadSdk(connectionString);
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        // Refused (an expired stored session). A newer sign-in since this attempt began gets its
        // turn now; otherwise wait for the next one.
        if (latestToken !== token) continue;
        return false;
      }
      failures += 1;
      if (failures < START_ATTEMPTS) {
        // One transient failure at page load must not switch telemetry off for the interview: keep
        // the buffer and try again (with whatever token is newest by then).
        await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS));
        continue;
      }
      console.info("[telemetry] App Insights not started", err);
      return false;
    }
  }
}

async function loadSdk(connectionString: string): Promise<void> {
  await whenIdle(5_000);
  const { ApplicationInsights, DistributedTracingModes } = await import(
    "@microsoft/applicationinsights-web"
  );
  const ai = new ApplicationInsights({
    config: {
      connectionString,
      enableAutoRouteTracking: true,
      distributedTracingMode: DistributedTracingModes.W3C,
      // No cookies: the voice timings are keyed by interview id, and candidates are not tracked
      // across visits.
      disableCookiesUsage: true,
      disableFlushOnBeforeUnload: false,
    },
  });
  ai.loadAppInsights();
  ai.addTelemetryInitializer((item) => {
    scrubItem(item as { baseData?: Record<string, unknown> });
    pinOperation(item as { baseData?: Record<string, unknown>; tags?: Record<string, unknown> });
  });
  ai.trackPageView();
  sink = {
    // Sent at once rather than with the SDK's next batch (15 s): there is about one voice event
    // per turn, and a candidate closing the tab right after an answer would otherwise lose it
    // (measured live: the last turn of a run went missing that way).
    trackEvent: (name, measurements, properties, urgent) => {
      ai.trackEvent({ name, measurements }, properties);
      if (urgent) ai.flush();
    },
    trackDependency: (dependency, urgent) => {
      ai.trackDependencyData(dependency);
      if (urgent) ai.flush();
    },
    unloadFlush: () => ai.onunloadFlush(),
    traceId: () => ai.getTraceCtx()?.getTraceId() ?? null,
  };
  for (const event of buffered) {
    sink.trackEvent(event.name, event.measurements, event.properties, event.urgent);
  }
  buffered = [];
}

/** Test hook: forget everything. */
export function resetTelemetryForTests(next: Sink | null = null): void {
  sink = next;
  buffered = [];
  disabled = false;
  starting = null;
  latestToken = "";
}
