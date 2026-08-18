/** personas API client: each fn hits the right path/method; local-map helpers round-trip. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as personas from "./personas";
import * as admin from "./admin";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const SAMPLE: personas.PersonaOut = {
  id: "p1",
  name: "Interviewer",
  character: "lisa",
  style: "casual",
  prompt_fragment: "You are an interviewer.",
  voice_map: '{"zh-CN":"zh-CN-XiaoxiaoNeural"}',
  greeting_map: '{"zh-CN":"你好"}',
  enabled: true,
  is_default: true,
  tools_config: "[]",
  turn_detection: "azure_semantic_vad",
  eou_detection: true,
  noise_suppression: true,
  echo_cancellation: true,
  interim_response: true,
  proactive_engagement: false,
  voice_temperature: 0.8,
  playback_speed: 1.0,
  model: null,
  agent_id: "interviewer-p1",
  agent_version: "3",
  agent_sync_status: "synced",
  agent_sync_error: null,
  default_instructions: "You are Interviewer, an interviewer.",
};

/** Mock fetch to capture requests and return `body` as a fresh 200 JSON response each call
 * (a Response body can only be read once, so multi-call tests need a new Response per call). */
function mockFetch(body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe("personas client", () => {
  it("listPersonas GETs /admin/personas with the admin bearer", async () => {
    admin.setAdminToken("jwt-1");
    const f = mockFetch([SAMPLE]);
    const result = await personas.listPersonas();
    expect(result).toEqual([SAMPLE]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/admin/personas");
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer jwt-1");
  });

  it("getPersona GETs the id path", async () => {
    const f = mockFetch(SAMPLE);
    await personas.getPersona("p1");
    expect(f.mock.calls[0][0]).toBe("/api/admin/personas/p1");
  });

  it("createPersona POSTs the body", async () => {
    const f = mockFetch(SAMPLE);
    const body = { ...SAMPLE } as unknown as personas.PersonaCreate;
    await personas.createPersona(body);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/admin/personas");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string).name).toBe("Interviewer");
  });

  it("updatePersona PUTs partial changes to the id path", async () => {
    const f = mockFetch(SAMPLE);
    await personas.updatePersona("p1", { name: "Renamed" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/admin/personas/p1");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "Renamed" });
  });

  it("setDefaultPersona and retrySyncPersona POST their action paths", async () => {
    const f = mockFetch(SAMPLE);
    await personas.setDefaultPersona("p1");
    expect(f.mock.calls[0][0]).toBe("/api/admin/personas/p1/set-default");
    expect(f.mock.calls[0][1]?.method).toBe("POST");

    await personas.retrySyncPersona("p1");
    expect(f.mock.calls[1][0]).toBe("/api/admin/personas/p1/retry-sync");
    expect(f.mock.calls[1][1]?.method).toBe("POST");
  });
});

describe("locale-map helpers", () => {
  it("parseLocaleMap parses a valid map and returns {} on bad/empty input", () => {
    expect(personas.parseLocaleMap('{"zh-CN":"v","en-US":"w"}')).toEqual({
      "zh-CN": "v",
      "en-US": "w",
    });
    expect(personas.parseLocaleMap("")).toEqual({});
    expect(personas.parseLocaleMap("not json")).toEqual({});
    expect(personas.parseLocaleMap("null")).toEqual({});
  });

  it("stringifyLocaleMap round-trips with parseLocaleMap", () => {
    const map = { "zh-CN": "a", "en-US": "b" };
    expect(personas.parseLocaleMap(personas.stringifyLocaleMap(map))).toEqual(map);
    expect(personas.stringifyLocaleMap({})).toBe("{}");
  });
});
