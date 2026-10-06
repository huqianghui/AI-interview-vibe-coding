/** The shared fetch core: credentials, content type, error shape and the 204 rule. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, errorDetail, HttpError, readJson, requestJson } from "./http";

function respond(status: number, body = "", statusText = status < 300 ? "OK" : "Conflict") {
  return vi.fn().mockResolvedValue(new Response(status === 204 ? null : body, { status, statusText }));
}

function sentHeaders(spy: ReturnType<typeof vi.fn>): Headers {
  return spy.mock.calls[0][1].headers as Headers;
}

describe("apiFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefixes the API base and keeps the caller's method and body", async () => {
    const spy = respond(200, "{}");
    vi.stubGlobal("fetch", spy);
    await apiFetch("/x", { method: "PUT", body: "{}" });
    expect(spy.mock.calls[0][0]).toBe("/api/x");
    expect(spy.mock.calls[0][1]).toMatchObject({ method: "PUT", body: "{}" });
  });

  it("sends JSON content type by default and none when json is off", async () => {
    const on = respond(200, "{}");
    vi.stubGlobal("fetch", on);
    await apiFetch("/x");
    expect(sentHeaders(on).get("Content-Type")).toBe("application/json");

    const off = respond(200, "bytes");
    vi.stubGlobal("fetch", off);
    await apiFetch("/x", {}, {}, { json: false });
    expect(sentHeaders(off).has("Content-Type")).toBe(false);
  });

  it("attaches exactly the credentials it is given", async () => {
    const spy = respond(200, "{}");
    vi.stubGlobal("fetch", spy);
    await apiFetch("/x", {}, { bearer: "jwt", anonSession: "anon" });
    expect(sentHeaders(spy).get("Authorization")).toBe("Bearer jwt");
    expect(sentHeaders(spy).get("X-Anon-Session")).toBe("anon");
  });

  it("omits empty or null credentials", async () => {
    const spy = respond(200, "{}");
    vi.stubGlobal("fetch", spy);
    await apiFetch("/x", {}, { bearer: "", anonSession: null });
    expect(sentHeaders(spy).has("Authorization")).toBe(false);
    expect(sentHeaders(spy).has("X-Anon-Session")).toBe(false);
  });

  it("keeps a caller-supplied header", async () => {
    const spy = respond(200, "{}");
    vi.stubGlobal("fetch", spy);
    await apiFetch("/x", { headers: { "X-Trace": "t1" } });
    expect(sentHeaders(spy).get("X-Trace")).toBe("t1");
  });

  it("throws HttpError with status, the raw-body message and the JSON detail", async () => {
    vi.stubGlobal("fetch", respond(409, '{"detail":"not live"}'));
    const err = (await apiFetch("/x").catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('409 Conflict: {"detail":"not live"}');
    expect(err.detail).toBe("not live");
  });

  it("lets a network failure through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(apiFetch("/x")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("readJson / requestJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses a JSON body", async () => {
    vi.stubGlobal("fetch", respond(200, '{"a":1}'));
    await expect(requestJson("/x")).resolves.toEqual({ a: 1 });
  });

  it("returns undefined for a 204 instead of parsing an empty body", async () => {
    await expect(readJson(new Response(null, { status: 204 }))).resolves.toBeUndefined();
  });
});

describe("errorDetail", () => {
  it("reads a JSON body's string detail", () => {
    expect(errorDetail('{"detail":"nope"}')).toBe("nope");
  });

  it("falls back to the raw text for non-JSON or a non-string detail", () => {
    expect(errorDetail("plain")).toBe("plain");
    expect(errorDetail('{"detail":[{"loc":["body"]}]}')).toBe('{"detail":[{"loc":["body"]}]}');
    expect(errorDetail("")).toBe("");
  });
});
