/** API client tests — session bootstrap + header injection, with fetch mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CandidateAuthError,
  _internal,
  ensureSession,
  fetchSopDocument,
  getReportStream,
  resetCandidateSession,
  signOutCandidate,
  startInterview,
} from "./client";
import * as auth from "./auth";

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

// #102: ensureSession() now requires the candidate's own JWT to mint/reuse the anon session.
describe("ensureSession candidate auth (#102)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("sends the candidate JWT as a bearer when minting a session", async () => {
    auth.setCandidateToken("candidate-jwt");
    const fetchSpy = mockFetchOnce({ session_id: "s1", token: "tok-123", expires_at: "later" });
    vi.stubGlobal("fetch", fetchSpy);

    await ensureSession();

    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer candidate-jwt");
  });

  it("reuses a cached anon token without sending a candidate bearer (idempotent per user)", async () => {
    localStorage.setItem(_internal.TOKEN_KEY, "existing");
    auth.setCandidateToken("candidate-jwt");
    const fetchSpy = mockFetchOnce({});
    vi.stubGlobal("fetch", fetchSpy);

    const token = await ensureSession();

    expect(token).toBe("existing");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws CandidateAuthError and clears both tokens on 401 (missing/invalid/expired candidate JWT)", async () => {
    auth.setCandidateToken("stale-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => JSON.stringify({ detail: "Not authenticated" }),
      }),
    );

    await expect(ensureSession()).rejects.toBeInstanceOf(CandidateAuthError);
    expect(auth.getCandidateToken()).toBe("");
    expect(localStorage.getItem(_internal.TOKEN_KEY)).toBeNull();
  });

  it("throws CandidateAuthError with the backend detail verbatim on 403 (admin account)", async () => {
    auth.setCandidateToken("admin-jwt");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => JSON.stringify({ detail: "Admin accounts cannot take interviews" }),
      }),
    );

    await expect(ensureSession()).rejects.toMatchObject({
      detail: "Admin accounts cannot take interviews",
      status: 403,
    });
    expect(auth.getCandidateToken()).toBe("");
    expect(localStorage.getItem(_internal.TOKEN_KEY)).toBeNull();
  });
});

describe("signOutCandidate (#102)", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("clears exactly the candidate token, the anon session token, and the saved interview id", () => {
    auth.setCandidateToken("candidate-jwt");
    localStorage.setItem(_internal.TOKEN_KEY, "anon-tok");
    localStorage.setItem("interview_session_id", "iv1");
    localStorage.setItem("unrelated_key", "keep-me");

    signOutCandidate();

    expect(auth.getCandidateToken()).toBe("");
    expect(localStorage.getItem(_internal.TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("interview_session_id")).toBeNull();
    expect(localStorage.getItem("unrelated_key")).toBe("keep-me");
  });
});

describe("resetCandidateSession (#102, decision 1A)", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("drops the inherited anon token and saved interview id but keeps the candidate JWT", () => {
    auth.setCandidateToken("candidate-jwt");
    localStorage.setItem(_internal.TOKEN_KEY, "previous-visitor-anon-tok");
    localStorage.setItem("interview_session_id", "previous-visitor-iv");

    resetCandidateSession();

    expect(auth.getCandidateToken()).toBe("candidate-jwt");
    expect(localStorage.getItem(_internal.TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("interview_session_id")).toBeNull();
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

  it("reports the coverage audit on its own callback, with its own smaller total", async () => {
    // The audit runs after grading and has a different denominator: only a question with a linked
    // SOP passage costs a call. Two questions scored, one audited. Heartbeat pings carry nothing and
    // must not be mistaken for progress.
    vi.stubGlobal(
      "fetch",
      mockStreamFetch([
        '{"type":"progress","done":2,"total":2,"question_id":"q2"}\n',
        '{"type":"coverage","done":0,"total":1}\n',
        '{"type":"ping","done":0,"total":1}\n',
        `{"type":"coverage","done":1,"total":1,"question_id":"q1"}\n${reportLine}\n`,
      ]),
    );

    const scoring: Array<{ done: number; total: number }> = [];
    const coverage: Array<{ done: number; total: number }> = [];
    const report = await getReportStream(
      "iv1",
      true,
      (p) => scoring.push(p),
      (c) => coverage.push(c),
    );

    expect(scoring.map((p) => `${p.done}/${p.total}`)).toEqual(["2/2"]);
    expect(coverage.map((c) => `${c.done}/${c.total}`)).toEqual(["0/1", "1/1"]);
    expect(report.status).toBe("scored");
  });

  it("ignores an unknown line type rather than failing the stream", async () => {
    // Forward compatibility: the backend may add event types (it added "coverage" in v0.45.0.0),
    // and an older frontend must still get its report.
    vi.stubGlobal(
      "fetch",
      mockStreamFetch([`{"type":"something_new","x":1}\n${reportLine}\n`]),
    );
    await expect(getReportStream("iv1")).resolves.toMatchObject({ status: "scored" });
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

describe("anon-session self-heal", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const unauthorized = {
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: async () => "",
  };
  const freshSession = {
    ok: true,
    status: 200,
    json: async () => ({ session_id: "s2", token: "fresh", expires_at: "later" }),
  };
  const interview = { interview_session_id: "iv1", status: "in_progress", current_question: null };

  it("drops a stale token on 401, mints a fresh session and retries once with it", async () => {
    localStorage.setItem(_internal.TOKEN_KEY, "stale");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(freshSession)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => interview });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(startInterview()).resolves.toMatchObject({ interview_session_id: "iv1" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1][0]).toBe("/api/public/candidate/session");
    const retried = fetchSpy.mock.calls[2][1].headers as Headers;
    expect(retried.get("X-Anon-Session")).toBe("fresh");
  });

  it("does not retry a 401 a second time", async () => {
    localStorage.setItem(_internal.TOKEN_KEY, "stale");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(freshSession)
      .mockResolvedValueOnce(unauthorized);
    vi.stubGlobal("fetch", fetchSpy);

    await expect(startInterview()).rejects.toThrow(/401/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-401 failure", async () => {
    localStorage.setItem(_internal.TOKEN_KEY, "tok");
    const fetchSpy = mockFetchOnce({ detail: "gone" }, false, 404);
    vi.stubGlobal("fetch", fetchSpy);
    await expect(startInterview()).rejects.toThrow(/404/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("fetchSopDocument", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(_internal.TOKEN_KEY, "tok-sop");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("GETs the encoded document path with the anon session and returns a blob URL", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("pdf-bytes", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    // jsdom has no createObjectURL, so define one rather than spy on it.
    const createObjectURL = vi.fn().mockReturnValue("blob:doc");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });

    await expect(fetchSopDocument("iv1", "doc/1")).resolves.toBe("blob:doc");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/candidate/interview/iv1/sop/doc%2F1");
    const headers = init.headers as Headers;
    expect(headers.get("X-Anon-Session")).toBe("tok-sop");
    expect(headers.has("Content-Type")).toBe(false);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("rejects on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    await expect(fetchSopDocument("iv1", "x")).rejects.toThrow(/404/);
  });
});

describe("sectionName", () => {
  it("names a section, a run of sections and a piece of one long section", async () => {
    const { sectionName } = await import("./client");
    expect(sectionName({ section: "4.2", title: "Approval" })).toBe("4.2 Approval");
    expect(sectionName({ section: "1", through: "3", title: "PURPOSE" })).toBe("1–3 PURPOSE");
    expect(sectionName({ section: "5", title: "VISITS", piece: 2 })).toBe("5 VISITS (part 2)");
    expect(sectionName({ section: "§2", title: "Tips", piece: 1 })).toBe("Tips (part 1)");
  });
});
