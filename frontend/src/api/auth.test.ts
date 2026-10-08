/** auth API client: login stores token, me() reads it, 401 clears it. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
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
    expect(auth.getAdminToken()).toBe("jwt-1");
  });

  it("login throws AuthError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(auth.login("admin", "bad")).rejects.toBeInstanceOf(auth.AuthError);
    expect(auth.getAdminToken()).toBe("");
  });

  it("a 401 is the localized wrong-credentials message, in the UI language", async () => {
    await i18n.changeLanguage("en-US");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    await expect(auth.login("admin", "bad")).rejects.toThrow("Incorrect username or password.");
  });

  it("another failure carries the server's reason, not just the status", async () => {
    await i18n.changeLanguage("en-US");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "The database is unavailable." }), { status: 503 }),
    );
    const err = await auth.login("admin", "pw").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(auth.AuthError);
    expect((err as auth.AuthError).status).toBe(503);
    expect((err as Error).message).toBe("Sign-in failed (503): The database is unavailable.");
  });

  it("an HTML error page is not echoed into the message", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
    );
    await expect(auth.login("admin", "pw")).rejects.toThrow("登录失败 (502)。");
    await i18n.changeLanguage("en-US");
  });

  it("me returns null and clears token on 401", async () => {
    auth.setAdminToken("stale");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await auth.me()).toBeNull();
    expect(auth.getAdminToken()).toBe(""); // cleared
  });

  it("me returns null without a token (no fetch)", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    expect(await auth.me()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("me returns the current user on 200", async () => {
    auth.setAdminToken("jwt-1");
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
    expect(auth.getAdminToken()).toBe("");
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
    auth.setAdminToken("admin-jwt");
    auth.setCandidateToken("candidate-jwt");
    expect(auth.getAdminToken()).toBe("admin-jwt");
    expect(auth.getCandidateToken()).toBe("candidate-jwt");

    auth.clearCandidateToken();
    expect(auth.getCandidateToken()).toBe("");
    expect(auth.getAdminToken()).toBe("admin-jwt"); // unaffected
  });
});

describe("admin token storage", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the admin JWT under the admin key, not the retired shared-token key", async () => {
    const body = JSON.stringify({ access_token: "jwt-9" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await auth.login("admin", "pw");
    expect(sessionStorage.getItem(auth.ADMIN_TOKEN_KEY)).toBe("jwt-9");
    expect(sessionStorage.getItem("admin_api_token")).toBeNull();
  });

  it("me rethrows a network failure instead of reporting signed-out", async () => {
    auth.setAdminToken("jwt-1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(auth.me()).rejects.toBeInstanceOf(TypeError);
    expect(auth.getAdminToken()).toBe("jwt-1");
  });

  it("me keeps the token on a non-401 failure", async () => {
    auth.setAdminToken("jwt-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(auth.me()).resolves.toBeNull();
    expect(auth.getAdminToken()).toBe("jwt-1");
  });
});
