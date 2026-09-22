/** auth API client: login stores token, me() reads it, 401 clears it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as auth from "./auth";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("auth client", () => {
  it("login stores the JWT and returns it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "jwt-1" }), { status: 200 }),
    );
    const token = await auth.login("admin", "pw");
    expect(token).toBe("jwt-1");
    expect(auth.getToken()).toBe("jwt-1");
  });

  it("login throws AuthError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(auth.login("admin", "bad")).rejects.toBeInstanceOf(auth.AuthError);
    expect(auth.getToken()).toBe("");
  });

  it("me returns null and clears token on 401", async () => {
    auth.setToken("stale");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await auth.me()).toBeNull();
    expect(auth.getToken()).toBe(""); // cleared
  });

  it("me returns null without a token (no fetch)", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    expect(await auth.me()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("me returns the current user on 200", async () => {
    auth.setToken("jwt-1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "u1",
          username: "admin",
          email: "a@local",
          full_name: "A",
          role: "admin",
          is_active: true,
          preferred_language: "zh-CN",
        }),
        { status: 200 },
      ),
    );
    const u = await auth.me();
    expect(u?.role).toBe("admin");
  });
});

// #102: candidates authenticate against the same /auth/login endpoint as admins, but their JWT is
// kept under its own sessionStorage key so it never collides with (or is cleared alongside) an
// admin session.
describe("candidate auth (#102)", () => {
  it("loginCandidate stores the JWT under the candidate key and returns it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "candidate-jwt-1" }), { status: 200 }),
    );
    const token = await auth.loginCandidate("user1", "pw");
    expect(token).toBe("candidate-jwt-1");
    expect(auth.getCandidateToken()).toBe("candidate-jwt-1");
    // Admin token is untouched by a candidate login.
    expect(auth.getToken()).toBe("");
  });

  it("loginCandidate throws AuthError on 401 and stores nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(auth.loginCandidate("user1", "bad")).rejects.toBeInstanceOf(auth.AuthError);
    expect(auth.getCandidateToken()).toBe("");
  });

  it("loginCandidate throws AuthError with the response status for non-401 failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(auth.loginCandidate("user1", "pw")).rejects.toMatchObject({ status: 500 });
  });

  it("setCandidateToken/clearCandidateToken round-trip independently of the admin token", () => {
    auth.setToken("admin-jwt");
    auth.setCandidateToken("candidate-jwt");
    expect(auth.getToken()).toBe("admin-jwt");
    expect(auth.getCandidateToken()).toBe("candidate-jwt");

    auth.clearCandidateToken();
    expect(auth.getCandidateToken()).toBe("");
    expect(auth.getToken()).toBe("admin-jwt"); // unaffected
  });
});
