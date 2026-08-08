/** API client tests — session bootstrap + header injection, with fetch mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _internal, ensureSession, startInterview } from "./client";

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
