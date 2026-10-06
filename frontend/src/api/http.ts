/**
 * The one fetch path every API module goes through (admin, auth, candidate). Each caller says which
 * credential it carries — an `Authorization: Bearer` JWT (admin or candidate) or the anonymous
 * interview session's `X-Anon-Session` header — and gets back either an ok `Response` or an
 * {@link HttpError} carrying the status and the server's detail. Keeping the credential an explicit
 * argument is what keeps an admin token off a candidate call: nothing here reads a token store.
 */

export const API_BASE = "/api";

export interface Credentials {
  /** Sent as `Authorization: Bearer <token>` when non-empty. */
  bearer?: string | null;
  /** Sent as `X-Anon-Session` when non-empty (the candidate's interview session). */
  anonSession?: string | null;
}

/** A non-2xx response. `message` keeps the `"<status> <statusText>: <body>"` shape callers show;
 * `detail` is the JSON body's `detail` string when there is one, else the raw body text. */
export class HttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, statusText: string, body: string, detail: string) {
    super(`${status} ${statusText}: ${body}`);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

/** The `detail` field of a JSON error body when present, otherwise the raw text. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return body;
}

/** Build the request headers: the caller's own, then the JSON content type unless turned off, then
 * whichever credentials are present. */
function buildHeaders(init: RequestInit, credentials: Credentials, json: boolean): Headers {
  const headers = new Headers(init.headers);
  if (json) headers.set("Content-Type", "application/json");
  if (credentials.bearer) headers.set("Authorization", `Bearer ${credentials.bearer}`);
  if (credentials.anonSession) headers.set("X-Anon-Session", credentials.anonSession);
  return headers;
}

/**
 * Fetch `API_BASE + path` and return the ok response; throw {@link HttpError} otherwise. `json`
 * (default true) sets `Content-Type: application/json`; pass false for a plain GET of bytes.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  credentials: Credentials = {},
  { json = true }: { json?: boolean } = {},
): Promise<Response> {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders(init, credentials, json),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new HttpError(resp.status, resp.statusText, body, errorDetail(body));
  }
  return resp;
}

/** Parse a JSON response body; a 204 has none and yields `undefined`. */
export async function readJson<T>(resp: Response): Promise<T> {
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

/** {@link apiFetch} + {@link readJson}: the common case of a JSON call. */
export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  credentials: Credentials = {},
): Promise<T> {
  return readJson<T>(await apiFetch(path, init, credentials));
}
