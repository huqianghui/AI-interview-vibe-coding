/** Every candidate wrapper sends the method, path and body its backend route expects, carrying the
 * anon session; plus the resume rules for a saved interview id. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "./client";

const TOKEN_KEY = client._internal.TOKEN_KEY;
const INTERVIEW_KEY = "interview_session_id";

type Call = () => Promise<unknown>;

const judgeBody = {
  question_id: "q1",
  follow_ups_asked: 0,
  draft_text: "so far",
  trigger: "voice_silence" as const,
};
const applyBody = { event_id: "e1", question_id: "q1", follow_ups_asked: 0 };

// [name, call, method, path, body (undefined = no body)]
const ROUTES: Array<[string, Call, string, string, unknown]> = [
  [
    "submitAnswer (default text)",
    () => client.submitAnswer("iv1", "hello"),
    "POST",
    "/api/candidate/interview/iv1/answer",
    { text: "hello", source: "text" },
  ],
  [
    "submitAnswer (voice)",
    () => client.submitAnswer("iv1", "hello", "voice"),
    "POST",
    "/api/candidate/interview/iv1/answer",
    { text: "hello", source: "voice" },
  ],
  [
    "recoverInterview",
    () => client.recoverInterview("iv1"),
    "POST",
    "/api/candidate/interview/iv1/recover",
    undefined,
  ],
  [
    "judgeInterview",
    () => client.judgeInterview("iv1", judgeBody),
    "POST",
    "/api/candidate/interview/iv1/judge",
    judgeBody,
  ],
  [
    "applyJudge",
    () => client.applyJudge("iv1", applyBody),
    "POST",
    "/api/candidate/interview/iv1/judge/apply",
    applyBody,
  ],
  [
    "getReport (default)",
    () => client.getReport("iv1"),
    "POST",
    "/api/candidate/interview/iv1/report",
    { sop_coverage_check: false },
  ],
  [
    "getReport (coverage on)",
    () => client.getReport("iv1", true),
    "POST",
    "/api/candidate/interview/iv1/report",
    { sop_coverage_check: true },
  ],
  ["getReview", () => client.getReview("iv1"), "GET", "/api/candidate/interview/iv1/review", undefined],
  ["listMyInterviews", () => client.listMyInterviews(), "GET", "/api/candidate/interviews", undefined],
  ["getMyInterview", () => client.getMyInterview("iv1"), "GET", "/api/candidate/interviews/iv1", undefined],
  [
    "fetchMySopDocument",
    () => client.fetchMySopDocument("iv1", "doc/1"),
    "GET",
    "/api/candidate/interviews/iv1/sop/doc%2F1",
    undefined,
  ],
];

function okJson(body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

describe("candidate route wrappers", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(TOKEN_KEY, "anon-1");
    // The SOP-document wrapper returns a blob URL; jsdom has no createObjectURL.
    Object.assign(URL, { createObjectURL: vi.fn().mockReturnValue("blob:x") });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(ROUTES)("%s", async (_name, call, method, path, body) => {
    const fetchSpy = okJson({});
    vi.stubGlobal("fetch", fetchSpy);
    await call();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(path);
    expect(init.method ?? "GET").toBe(method);
    expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(body);
    const headers = init.headers as Headers;
    expect(headers.get("X-Anon-Session")).toBe("anon-1");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("restartInterview saves the NEW session's id so a reload resumes it", async () => {
    localStorage.setItem(INTERVIEW_KEY, "old");
    const fetchSpy = okJson({ interview_session_id: "new", status: "in_progress" });
    vi.stubGlobal("fetch", fetchSpy);
    await client.restartInterview("old");
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/candidate/interview/old/restart");
    expect(fetchSpy.mock.calls[0][1].method).toBe("POST");
    expect(localStorage.getItem(INTERVIEW_KEY)).toBe("new");
  });

  it("startInterview saves the interview id", async () => {
    vi.stubGlobal("fetch", okJson({ interview_session_id: "iv9", status: "in_progress" }));
    await client.startInterview();
    expect(localStorage.getItem(INTERVIEW_KEY)).toBe("iv9");
  });
});

describe("resumeInterview", () => {
  const question = { question_id: "q1", prompt: "p", index: 0, total: 1 };

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("returns null without a saved id, and does not fetch", async () => {
    const fetchSpy = okJson({});
    vi.stubGlobal("fetch", fetchSpy);
    await expect(client.resumeInterview()).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null without an anon token, and does not fetch", async () => {
    localStorage.setItem(INTERVIEW_KEY, "iv1");
    const fetchSpy = okJson({});
    vi.stubGlobal("fetch", fetchSpy);
    await expect(client.resumeInterview()).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resumes a live bank session that has a current question", async () => {
    localStorage.setItem(INTERVIEW_KEY, "iv1");
    localStorage.setItem(TOKEN_KEY, "anon");
    const iv = { interview_session_id: "iv1", status: "in_progress", current_question: question };
    const fetchSpy = okJson(iv);
    vi.stubGlobal("fetch", fetchSpy);
    await expect(client.resumeInterview()).resolves.toEqual(iv);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/candidate/interview/iv1");
  });

  it("resumes a live external session mid-turn even with no current question", async () => {
    localStorage.setItem(INTERVIEW_KEY, "iv1");
    localStorage.setItem(TOKEN_KEY, "anon");
    const iv = {
      interview_session_id: "iv1",
      status: "in_progress",
      current_question: null,
      external_phase: "awaiting",
    };
    vi.stubGlobal("fetch", okJson(iv));
    await expect(client.resumeInterview()).resolves.toEqual(iv);
    expect(localStorage.getItem(INTERVIEW_KEY)).toBe("iv1");
  });

  it("clears the saved id for a finished session", async () => {
    localStorage.setItem(INTERVIEW_KEY, "iv1");
    localStorage.setItem(TOKEN_KEY, "anon");
    vi.stubGlobal(
      "fetch",
      okJson({ interview_session_id: "iv1", status: "completed", current_question: null }),
    );
    await expect(client.resumeInterview()).resolves.toBeNull();
    expect(localStorage.getItem(INTERVIEW_KEY)).toBeNull();
  });

  it("clears the saved id when the interview is gone or not owned (404)", async () => {
    localStorage.setItem(INTERVIEW_KEY, "iv1");
    localStorage.setItem(TOKEN_KEY, "anon");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(client.resumeInterview()).resolves.toBeNull();
    expect(localStorage.getItem(INTERVIEW_KEY)).toBeNull();
  });
});

describe("ensureSession on a server error", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("throws the HTTP error as-is and keeps the candidate JWT (it is not an auth failure)", async () => {
    sessionStorage.setItem("candidate_access_token", "cand");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    const err = await client.ensureSession().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(client.CandidateAuthError);
    expect((err as Error).message).toMatch(/^503/);
    expect(sessionStorage.getItem("candidate_access_token")).toBe("cand");
  });
});
