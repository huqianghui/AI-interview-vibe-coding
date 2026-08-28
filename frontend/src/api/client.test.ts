/** API client tests — session bootstrap + header injection, with fetch mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _internal, ensureSession, getReportStream, startInterview } from "./client";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("api client", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates and stores a session token on first ensureSession", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ session_id: "s1", token: "tok-123", expires_at: "later" }),
    );
    const token = await ensureSession();
    expect(token).toBe("tok-123");
    expect(localStorage.getItem(_internal.TOKEN_KEY)).toBe("tok-123");
  });

  it("reuses an existing token instead of creating a new session", async () => {
    localStorage.setItem(_internal.TOKEN_KEY, "existing");
    const fetchSpy = mockFetchOnce({});
    vi.stubGlobal("fetch", fetchSpy);
    const token = await ensureSession();
    expect(token).toBe("existing");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends X-Anon-Session header on authed calls", async () => {
    localStorage.setItem(_internal.TOKEN_KEY, "tok-abc");
    const fetchSpy = mockFetchOnce({
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: { question_id: "q1", prompt: "hi", index: 0, total: 2 },
    });
    vi.stubGlobal("fetch", fetchSpy);

    const iv = await startInterview();
    expect(iv.interview_session_id).toBe("iv1");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Anon-Session")).toBe("tok-abc");
  });

  it("throws on a non-ok response", async () => {
    localStorage.setItem(_internal.TOKEN_KEY, "tok");
    vi.stubGlobal("fetch", mockFetchOnce({ detail: "boom" }, false, 409));
    await expect(startInterview()).rejects.toThrow(/409/);
  });
});

/** Build a fetch mock whose body is a ReadableStream of the given NDJSON chunks — exercises the
 * incremental line-splitting (a chunk may end mid-line; the remainder must carry over). */
function mockStreamFetch(chunks: string[], ok = true, status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return vi.fn().mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    body,
    text: async () => chunks.join(""),
  });
}

describe("getReportStream", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(_internal.TOKEN_KEY, "tok-stream");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const reportLine = JSON.stringify({
    type: "report",
    report: { interview_session_id: "iv1", status: "scored", per_question: [] },
  });

  it("invokes onProgress per progress line and resolves with the report", async () => {
    const fetchSpy = mockStreamFetch([
      '{"type":"progress","done":0,"total":2,"question_id":"q1"}\n',
      // Chunk boundary mid-line: the second progress line arrives split across two chunks.
      '{"type":"progress","done":1,',
      `"total":2,"question_id":"q2"}\n${reportLine}\n`,
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const progress: Array<{ done: number; total: number }> = [];
    const report = await getReportStream("iv1", false, (p) => progress.push(p));

    expect(progress.map((p) => p.done)).toEqual([0, 1]);
    expect(report.status).toBe("scored");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/report/stream");
    expect(new Headers(init.headers).get("X-Anon-Session")).toBe("tok-stream");
  });

  it("rejects on an in-band error line", async () => {
    vi.stubGlobal(
      "fetch",
      mockStreamFetch(['{"type":"error","detail":"scoring exploded"}\n']),
    );
    await expect(getReportStream("iv1")).rejects.toThrow(/scoring exploded/);
  });

  it("rejects when the stream ends without a report", async () => {
    vi.stubGlobal(
      "fetch",
      mockStreamFetch(['{"type":"progress","done":0,"total":1,"question_id":"q1"}\n']),
    );
    await expect(getReportStream("iv1")).rejects.toThrow(/without a report/);
  });

  it("rejects on a non-ok response", async () => {
    vi.stubGlobal("fetch", mockStreamFetch(["conflict"], false, 409));
    await expect(getReportStream("iv1")).rejects.toThrow(/409/);
  });
});
