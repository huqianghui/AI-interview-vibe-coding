/**
 * LIVE BYOM voice sessions, end to end in a real browser (opt-in, real Azure — NOT part of CI).
 *
 * The gap this closes: the BYOM branch had only mocked vitest coverage. Nothing had ever driven the
 * whole path — tick "use my own model" in Admin, pick a profile, save, then run a real interview —
 * against real Azure. The backend connection was verified with a probe CLI; the browser never was.
 *
 * Each case configures the voice leg through the real admin API, runs a real candidate interview, and
 * asserts on the frames the backend proxy relays over /api/voice-live/ws. `proxy.connected` carries
 * `byom_profile`, which is the only way to tell path ② from path ① on the wire — BYOM reuses the same
 * `model=` slot as native.
 *
 * The config is always restored in a finally: a failed run must not leave the deployment on BYOM.
 *
 * Run (from frontend/):
 *   LIVE_VOICE=1 BASE=http://localhost:5173 E2E_API=http://127.0.0.1:8000/api \
 *   E2E_ADMIN_USERNAME=… E2E_ADMIN_PASSWORD=… \
 *   npx playwright test byom-voice-live --config=e2e/live.config.ts
 *
 * Deployment names come from the environment so this is not pinned to one resource:
 *   BYOM_CHAT_MODEL      (default gpt-5-mini)      — a chat-capable deployment
 *   BYOM_REALTIME_MODEL  (default gpt-realtime-2.1) — a realtime deployment
 * `byom-foundry-anthropic-messages` is deliberately absent: it needs a Claude deployment, which the
 * reference tenant cannot create, so there is nothing to verify (docs/voice-live-model-support.md §4.5).
 */
import { test, expect } from "@playwright/test";
import {
  adminApi,
  enterVoiceChannel,
  primeCandidateLogin,
  waitForInterviewStage,
} from "./helpers/candidateLogin";

const LIVE = process.env.LIVE_VOICE === "1";
const BASE = process.env.BASE || "http://localhost:5173";
const CHAT_MODEL = process.env.BYOM_CHAT_MODEL || "gpt-5-mini";
const REALTIME_MODEL = process.env.BYOM_REALTIME_MODEL || "gpt-realtime-2.1";

type VoiceCfg = {
  voice_model: string;
  voice_model_mode: string;
  voice_byom_profile: string;
};

/** The frames a voice session produced, as the browser saw them. */
type Observed = {
  connected: Record<string, unknown> | null;
  errorFrame: string | null;
  avatarIce: boolean;
  transcript: boolean;
  types: Set<string>;
};

function watchVoiceWs(page: import("@playwright/test").Page): Observed {
  const o: Observed = {
    connected: null,
    errorFrame: null,
    avatarIce: false,
    transcript: false,
    types: new Set(),
  };
  page.on("websocket", (ws) => {
    if (!/voice-live\/ws/.test(ws.url())) return;
    ws.on("framereceived", (f) => {
      const data = typeof f.payload === "string" ? f.payload : "";
      if (!data) return;
      try {
        const msg = JSON.parse(data) as Record<string, unknown>;
        const type = msg.type as string | undefined;
        if (!type) return;
        o.types.add(type);
        if (type === "proxy.connected") o.connected = msg;
        if (type === "session.updated") {
          const session = msg.session as Record<string, unknown> | undefined;
          const avatar = session?.avatar as Record<string, unknown> | undefined;
          if (avatar && ((avatar.ice_servers as unknown[]) ?? []).length > 0) o.avatarIce = true;
        }
        if (type === "response.audio_transcript.delta") o.transcript = true;
        if (type === "error" || type.endsWith(".error")) o.errorFrame = data.slice(0, 400);
      } catch {
        /* non-JSON / binary frame */
      }
    });
  });
  return o;
}

/** Read the saved voice settings, so the test can put them back exactly as they were. */
async function readVoiceCfg(): Promise<VoiceCfg & Record<string, unknown>> {
  const { api, headers } = await adminApi();
  try {
    const r = await api.get("/admin/config/ai-foundry", { headers });
    if (!r.ok()) throw new Error(`read config failed: ${r.status()} ${await r.text()}`);
    return (await r.json()) as VoiceCfg & Record<string, unknown>;
  } finally {
    await api.dispose();
  }
}

/** Save the voice settings. Returns the status + body so a REJECTION can be asserted, not thrown. */
async function putVoiceCfg(
  current: Record<string, unknown>,
  patch: Partial<VoiceCfg>,
): Promise<{ status: number; body: string }> {
  const { api, headers } = await adminApi();
  try {
    const r = await api.put("/admin/config/ai-foundry", {
      headers,
      data: {
        endpoint: current.endpoint,
        api_key: "", // empty preserves the stored key
        default_project: current.default_project,
        model_or_deployment: current.model_or_deployment,
        knowledge_base: current.knowledge_base,
        knowledge_source: current.knowledge_source,
        voice_model: current.voice_model ?? "",
        voice_model_mode: current.voice_model_mode ?? "native",
        voice_byom_profile: current.voice_byom_profile ?? "",
        ...patch,
      },
    });
    return { status: r.status(), body: await r.text() };
  } finally {
    await api.dispose();
  }
}

/** Save and require success — for the cases where the config is expected to land. */
async function writeVoiceCfg(
  current: Record<string, unknown>,
  patch: Partial<VoiceCfg>,
): Promise<Record<string, unknown>> {
  const { status, body } = await putVoiceCfg(current, patch);
  if (status < 200 || status >= 300) throw new Error(`save config failed: ${status} ${body}`);
  return JSON.parse(body) as Record<string, unknown>;
}

/** Seconds Azure asked us to wait, when the error frame is the avatar creation rate limit.

AVATAR creation is rate-limited to roughly 3 connections per 60s (measured; voice-only is ~120/min),
and this spec opens several avatar sessions back to back. That is a platform pacing limit, not a
product defect, so a test that fails on it is flaky rather than informative — but it must never be
swallowed: only this specific code is retried, and only using the delay Azure itself states. */
function rateLimitRetryAfter(errorFrame: string | null): number | null {
  if (!errorFrame || !/rate_limit_exceeded/.test(errorFrame)) return null;
  const m = /Retry after ([0-9.]+)s/.exec(errorFrame);
  return m ? Math.ceil(Number(m[1])) + 2 : 45;
}

async function runVoiceSession(page: import("@playwright/test").Page, o: Observed): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await primeCandidateLogin(page); // #102: /interview is login-gated
    await page.goto(`${BASE}/interview`);
    await page.getByRole("button", { name: /开始面试|start interview/i }).click();
    await page.getByRole("button", { name: /我准备好了|i'm ready/i }).click();
    await waitForInterviewStage(page);
    await enterVoiceChannel(page);

    await expect
      .poll(() => (o.connected ? "ok" : o.errorFrame ? `err:${o.errorFrame}` : "pending"), {
        timeout: 45_000,
        message: "the backend proxy never sent proxy.connected",
      })
      .not.toBe("pending");

    // The avatar rate-limit error arrives AFTER proxy.connected (connect succeeds, then the avatar
    // request is refused), so "connected" alone is not success — give the frame a beat to land.
    if (o.connected) await page.waitForTimeout(3_000);
    const waitFor = rateLimitRetryAfter(o.errorFrame);
    if (waitFor === null || attempt === 2) return; // clean, or a real rejection for the caller
    console.log(`[byom] avatar rate-limited, retrying in ${waitFor}s (attempt ${attempt})`);
    o.errorFrame = null;
    o.connected = null;
    await page.waitForTimeout(waitFor * 1000);
  }
}

test.describe("BYOM voice sessions (real Azure)", () => {
  test.skip(!LIVE, "opt-in: set LIVE_VOICE=1 to run against real Azure");
  test.describe.configure({ mode: "serial" }); // one live candidate seat, and one shared config row

  test("BYOM chat-completion (cascaded): the profile reaches the wire and the session runs", async ({
    page,
  }) => {
    const before = await readVoiceCfg();
    const o = watchVoiceWs(page);
    try {
      // 1) Saving is itself a real assertion: the backend live-probes a changed voice model with the
      //    PRODUCTION session shape before committing, so a 200 means Azure accepted this pairing
      //    for the session the app actually sends.
      const saved = await writeVoiceCfg(before, {
        voice_model: CHAT_MODEL,
        voice_model_mode: "byom",
        voice_byom_profile: "byom-azure-openai-chat-completion",
      });
      expect(saved.voice_model).toBe(CHAT_MODEL);
      expect(saved.voice_model_mode).toBe("byom");
      expect(String(saved.voice_model_check)).toMatch(/verified/i);

      // 2) A real interview, in a real browser, on that BYOM session.
      await runVoiceSession(page, o);

      // 3) The profile is on the wire — the only observable separating path ② from path ①, since
      //    BYOM reuses the same `model=` slot as native.
      expect(o.connected?.byom_profile, `proxy.connected: ${JSON.stringify(o.connected)}`).toBe(
        "byom-azure-openai-chat-completion",
      );
      expect(o.connected?.model).toBe(CHAT_MODEL);
      expect(o.connected?.mode).toBe("model"); // BYOM lives on the model path, never agent mode

      // 4) Azure did not reject the session and the page did not fall back to text-only.
      expect(o.errorFrame, `Azure rejected the session: ${o.errorFrame}`).toBeNull();
      await expect(page.getByText(/语音不可用|voice unavailable/i)).toHaveCount(0);

      // Measured for the record (first browser-level BYOM run): avatar ICE arrives on a cascaded
      // BYOM session exactly as on a native one.
      expect(o.avatarIce, "cascaded BYOM must still deliver the avatar handshake").toBe(true);
    } finally {
      await writeVoiceCfg(before, {
        voice_model: String(before.voice_model ?? ""),
        voice_model_mode: String(before.voice_model_mode ?? "native"),
        voice_byom_profile: String(before.voice_byom_profile ?? ""),
      });
    }
  });

  test("BYOM realtime (passthrough) is refused at SAVE, so no interview ever sees it", async () => {
    // This case documents a measured incompatibility rather than a working path.
    //
    // A realtime deployment DOES connect under this profile — the probe's minimal session is
    // ACCEPTED. The production session is not: speech-native passthrough has no Voice Live speech
    // recognizer, and this product's session asks for text end-of-utterance detection plus
    // azure-speech input transcription, which only exist on a cascaded pipeline. Azure says so and
    // names the field.
    //
    // That is why the save-time check sends the PRODUCTION session shape. Checking a minimal session
    // was a false green that would have let an operator save a config under which every voice
    // session fails. The first browser run of this spec is what caught it.
    const before = await readVoiceCfg();
    const { status, body } = await putVoiceCfg(before, {
      voice_model: REALTIME_MODEL,
      voice_model_mode: "byom",
      voice_byom_profile: "byom-azure-openai-realtime",
    });

    expect(status, `expected the save to be refused, got ${status}: ${body}`).toBe(422);
    expect(body).toMatch(/end-of-utterance detection requires a local speech recognizer/i);
    expect(body).toMatch(/cascaded pipelines/i);

    // And the stored config is untouched — a refused save must not half-apply.
    const after = await readVoiceCfg();
    expect(after.voice_model).toBe(before.voice_model);
    expect(after.voice_model_mode).toBe(before.voice_model_mode);
    expect(after.voice_byom_profile).toBe(before.voice_byom_profile);
  });

  test("native control: no profile reaches the wire", async ({ page }) => {
    test.slow(); // avatar creation is rate-limited (~3/60s measured) and this is the 2nd session
    // The other half of the guarantee — a stale stored profile must not leak onto a native session.
    const before = await readVoiceCfg();
    const o = watchVoiceWs(page);
    try {
      const saved = await writeVoiceCfg(before, {
        voice_model: String(before.voice_model || CHAT_MODEL),
        voice_model_mode: "native",
        voice_byom_profile: "byom-azure-openai-chat-completion", // stored, must be ignored
      });
      expect(saved.voice_model_mode).toBe("native");

      await runVoiceSession(page, o);

      expect(o.connected?.byom_profile, "a native session must carry no profile").toBe("");
      expect(o.errorFrame, `Azure rejected the session: ${o.errorFrame}`).toBeNull();
    } finally {
      await writeVoiceCfg(before, {
        voice_model: String(before.voice_model ?? ""),
        voice_model_mode: String(before.voice_model_mode ?? "native"),
        voice_byom_profile: String(before.voice_byom_profile ?? ""),
      });
    }
  });
});
