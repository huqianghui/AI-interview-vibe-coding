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
  trackEvent(name: string, measurements: Measurements, properties: Properties): void;
}

// Events recorded before the SDK is ready (the voice session prewarms on page load, in parallel with
// the config fetch). Bounded so a page that never gets telemetry cannot grow it without limit.
const MAX_BUFFERED = 200;
let buffered: { name: string; measurements: Measurements; properties: Properties }[] = [];
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
 * App Insights it is dropped. */
export function trackEvent(name: string, measurements: Measurements, properties: Properties = {}): void {
  if (sink) {
    try {
      sink.trackEvent(name, measurements, properties);
    } catch (err) {
      console.debug("[telemetry] trackEvent failed", err);
    }
    return;
  }
  if (!disabled && buffered.length < MAX_BUFFERED) buffered.push({ name, measurements, properties });
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
  });
  ai.trackPageView();
  sink = {
    // Sent at once rather than with the SDK's next batch (15 s): there is about one voice event
    // per turn, and a candidate closing the tab right after an answer would otherwise lose it
    // (measured live: the last turn of a run went missing that way).
    trackEvent: (name, measurements, properties) => {
      ai.trackEvent({ name, measurements }, properties);
      ai.flush();
    },
  };
  for (const event of buffered) sink.trackEvent(event.name, event.measurements, event.properties);
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
