/** Admin API client — the request wrapper's auth/error contract and the BYOM deployment filter. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminApiError,
  adminRequest,
  deploymentKindForProfile,
  getAdminToken,
  setAdminToken,
} from "./admin";

function respond(status: number, body: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

describe("adminRequest", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("sends the stored admin token as a bearer and JSON content type", async () => {
    setAdminToken("adm-1");
    const fetchSpy = respond(200, { ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(adminRequest("/admin/users")).resolves.toEqual({ ok: true });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/admin/users");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer adm-1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("keeps the caller's method and body", async () => {
    const fetchSpy = respond(200);
    vi.stubGlobal("fetch", fetchSpy);
    await adminRequest("/admin/x", { method: "PUT", body: "{}" });
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: "PUT", body: "{}" });
  });

  it("maps a non-2xx to AdminApiError carrying the status and the server's detail", async () => {
    vi.stubGlobal("fetch", respond(409, "agent not synced"));
    const err = await adminRequest("/admin/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).status).toBe(409);
    expect((err as AdminApiError).message).toContain("agent not synced");
  });

  it("returns undefined for a 204 instead of parsing an empty body", async () => {
    const res = respond(204);
    vi.stubGlobal("fetch", res);
    await expect(adminRequest("/admin/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("has no token until one is set", () => {
    expect(getAdminToken()).toBe("");
    setAdminToken("t");
    expect(getAdminToken()).toBe("t");
  });
});

describe("deploymentKindForProfile", () => {
  it("restricts the realtime BYOM profile to realtime deployments", () => {
    expect(deploymentKindForProfile("byom-azure-openai-realtime")).toBe("realtime");
  });

  it("restricts the chat-completion BYOM profile to chat deployments", () => {
    expect(deploymentKindForProfile("byom-azure-openai-chat-completion")).toBe("chat");
  });

  it("offers every deployment for a profile it cannot verify (e.g. Anthropic)", () => {
    expect(deploymentKindForProfile("byom-foundry-anthropic-messages")).toBe("all");
    expect(deploymentKindForProfile("")).toBe("all");
  });
});
