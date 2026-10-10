/**
 * Application Insights in the browser: page views, the page's own `/api` calls (correlated with the
 * backend's traces through W3C `traceparent`), uncaught errors, and the voice timing events from
 * `voiceTimeline.ts`.
 *
 * Off unless the deployment has App Insights: the connection string comes from the backend at run
 * time (`GET /public/client-config`), because one image is deployed into every environment. The SDK
 * is loaded with a dynamic import so it lands in its own chunk and never delays the first paint or
 * the voice prewarm.
 *
 * Telemetry carries ids, timings, counts and outcomes, never a transcript, an answer, a question or
 * any SOP text. Query strings are stripped from every URL before it leaves the page: some carry a
 * session token.
 */
import { requestJson } from "../api/http";

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
let started = false;

/** Strip the query string (and fragment) from a URL-ish value. */
export function stripQuery(value: string): string {
  return value.replace(/[?#].*$/, "");
}

const URL_FIELDS = ["uri", "refUri", "name", "target", "data", "url"] as const;

/** Remove query strings from every URL field of a telemetry item, in place. Exported for tests. */
export function scrubItem(item: { baseData?: Record<string, unknown> }): void {
  const data = item.baseData;
  if (!data) return;
  for (const field of URL_FIELDS) {
    const value = data[field];
    if (typeof value === "string") data[field] = stripQuery(value);
  }
}

/** Record one custom event. Safe to call at any time: before start-up it is buffered, and without
 * App Insights it is dropped. */
export function trackEvent(name: string, measurements: Measurements, properties: Properties = {}): void {
  if (sink) {
    sink.trackEvent(name, measurements, properties);
    return;
  }
  if (buffered.length < MAX_BUFFERED) buffered.push({ name, measurements, properties });
}

/** Fetch the runtime config and, when the deployment has App Insights, load the SDK. Idempotent;
 * never throws (telemetry must not break the page). */
export async function startTelemetry(): Promise<boolean> {
  if (started) return sink !== null;
  started = true;
  try {
    const config = await requestJson<{ app_insights_connection_string?: string | null }>(
      "/public/client-config",
    );
    const connectionString = config.app_insights_connection_string;
    if (!connectionString) {
      buffered = [];
      return false;
    }
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
      trackEvent: (name, measurements, properties) =>
        ai.trackEvent({ name, measurements }, properties),
    };
    for (const event of buffered) sink.trackEvent(event.name, event.measurements, event.properties);
    buffered = [];
    return true;
  } catch (err) {
    console.info("[telemetry] App Insights not started", err);
    buffered = [];
    return false;
  }
}

/** Test hook: forget everything. */
export function resetTelemetryForTests(next: Sink | null = null): void {
  sink = next;
  buffered = [];
  started = false;
}
