/**
 * Form-mapper round-trip (regression for the "Language reset on refresh" bug): the editor's
 * "Language" selector is `default_locale`, a persisted persona field. personaToForm must read it
 * and formToPayload must send it, so a Save→reload cycle restores the selected locale instead of
 * snapping back to the hardcoded default locale.
 */
import { describe, expect, it } from "vitest";
import type { PersonaOut } from "../api/personas";
import { emptyPersonaForm, formToPayload, normalizeLocale, personaToForm } from "./agentEditorForm";

const persona = (over: Partial<PersonaOut> = {}): PersonaOut => ({
  id: "p1",
  name: "Interviewer",
  character: "lisa",
  style: "casual",
  prompt_fragment: "",
  external_reader_prompt: null,
  voice_map: '{"zh-CN":"zh-CN-XiaoxiaoNeural","en-US":"en-US-AvaNeural"}',
  greeting_map: '{"zh-CN":"你好","en-US":"Hello"}',
  default_locale: "en-US",
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
  bank_auto_submit_enabled: false,
  bank_auto_submit_silence_seconds: 3,
  external_auto_submit_enabled: true,
  external_auto_submit_silence_seconds: 3,
  bank_turn_mode: "linear",
  judge_silence_seconds: 2,
  judge_max_calls_per_question: 2,
  judge_contract: "JUDGE CONTRACT (fixed by the system)",
  model: null,
  interview_brain: "bank",
  agent_id: null,
  agent_version: null,
  agent_sync_status: "synced",
  agent_sync_error: null,
  default_instructions: "",
  default_external_reader_prompt: "You are Interviewer, the interviewer's voice.",
  ...over,
});

describe("agentEditorForm default_locale round-trip", () => {
  it("loads the saved locale into the form", () => {
    expect(personaToForm(persona({ default_locale: "en-US" })).defaultLocale).toBe("en-US");
  });

  it("includes the locale in the save payload", () => {
    const form = personaToForm(persona({ default_locale: "en-US" }));
    expect(formToPayload(form).default_locale).toBe("en-US");
  });

  it("survives a full save→reload cycle (the bug: it used to reset to zh-CN)", () => {
    const saved = persona({ default_locale: "en-US" });
    // Reload = server returns the persisted payload; the form must reflect it, not the default.
    expect(personaToForm(saved).defaultLocale).toBe("en-US");
  });

  it("falls back to en-US for an unknown or missing stored locale", () => {
    expect(personaToForm(persona({ default_locale: "fr-FR" })).defaultLocale).toBe("en-US");
    expect(normalizeLocale(undefined)).toBe("en-US");
    expect(normalizeLocale("")).toBe("en-US");
  });
});

describe("agentEditorForm externalReaderPrompt round-trip", () => {
  // external_reader_prompt is an INDEPENDENT config item (not prompt_fragment swapped by the brain
  // toggle). The mappers must carry it through both directions and preserve the null ⇄ "" sentinel
  // ("unset, use the generated default") without ever collapsing it onto prompt_fragment.
  it("loads a stored reader prompt into the form", () => {
    const form = personaToForm(persona({ external_reader_prompt: "read exactly" }));
    expect(form.externalReaderPrompt).toBe("read exactly");
  });

  it("maps a null reader prompt to an empty string (the 'use default' sentinel)", () => {
    expect(personaToForm(persona({ external_reader_prompt: null })).externalReaderPrompt).toBe("");
  });

  it("sends the reader prompt in the save payload, independent of prompt_fragment", () => {
    const form = personaToForm(
      persona({ prompt_fragment: "bank side", external_reader_prompt: "reader side" }),
    );
    const payload = formToPayload(form);
    expect(payload.external_reader_prompt).toBe("reader side");
    expect(payload.prompt_fragment).toBe("bank side");
  });

  it("survives a full save→reload cycle carrying both prompts", () => {
    const form = personaToForm(
      persona({ prompt_fragment: "bank side", external_reader_prompt: "reader side" }),
    );
    expect(form.prompt_fragment).toBe("bank side");
    expect(form.externalReaderPrompt).toBe("reader side");
  });
});

describe("agentEditorForm voice auto-submit pairs (one per engine, never shared)", () => {
  it("new persona defaults: bank OFF / external ON, both 3s", () => {
    const f = emptyPersonaForm();
    expect(f.bank_auto_submit_enabled).toBe(false);
    expect(f.bank_auto_submit_silence_seconds).toBe(3);
    expect(f.external_auto_submit_enabled).toBe(true);
    expect(f.external_auto_submit_silence_seconds).toBe(3);
  });

  it("loads both pairs from the persona and sends both in the payload", () => {
    const form = personaToForm(
      persona({
        bank_auto_submit_enabled: true,
        bank_auto_submit_silence_seconds: 10,
        external_auto_submit_enabled: false,
        external_auto_submit_silence_seconds: 20,
      }),
    );
    expect(form.bank_auto_submit_enabled).toBe(true);
    expect(form.bank_auto_submit_silence_seconds).toBe(10);
    expect(form.external_auto_submit_enabled).toBe(false);
    expect(form.external_auto_submit_silence_seconds).toBe(20);
    const payload = formToPayload(form);
    expect(payload.bank_auto_submit_enabled).toBe(true);
    expect(payload.bank_auto_submit_silence_seconds).toBe(10);
    expect(payload.external_auto_submit_enabled).toBe(false);
    expect(payload.external_auto_submit_silence_seconds).toBe(20);
  });

  it("falls back to the engine defaults when an older backend omits the fields", () => {
    const legacy = persona() as unknown as Record<string, unknown>;
    delete legacy.bank_auto_submit_enabled;
    delete legacy.bank_auto_submit_silence_seconds;
    delete legacy.external_auto_submit_enabled;
    delete legacy.external_auto_submit_silence_seconds;
    const form = personaToForm(legacy as unknown as PersonaOut);
    expect(form.bank_auto_submit_enabled).toBe(false);
    expect(form.bank_auto_submit_silence_seconds).toBe(3);
    expect(form.external_auto_submit_enabled).toBe(true);
    expect(form.external_auto_submit_silence_seconds).toBe(3);
  });

  it("flipping the interview brain carries BOTH pairs untouched (separate config items)", () => {
    const form = personaToForm(
      persona({
        interview_brain: "bank",
        bank_auto_submit_enabled: true,
        bank_auto_submit_silence_seconds: 7,
        external_auto_submit_enabled: false,
        external_auto_submit_silence_seconds: 15,
      }),
    );
    const payload = formToPayload({ ...form, interviewBrain: "external" });
    expect(payload.interview_brain).toBe("external");
    expect(payload.bank_auto_submit_enabled).toBe(true);
    expect(payload.bank_auto_submit_silence_seconds).toBe(7);
    expect(payload.external_auto_submit_enabled).toBe(false);
    expect(payload.external_auto_submit_silence_seconds).toBe(15);
  });
});

describe("agentEditorForm bank turn mode (linear by default, bank-only, never shared)", () => {
  it("new persona defaults to linear turns", () => {
    expect(emptyPersonaForm().bank_turn_mode).toBe("linear");
  });

  it("round-trips the admin's judged opt-in and the two judge knobs", () => {
    const form = personaToForm(
      persona({ bank_turn_mode: "judged", judge_silence_seconds: 5, judge_max_calls_per_question: 0 }),
    );
    expect(form.bank_turn_mode).toBe("judged");
    expect(form.judge_silence_seconds).toBe(5);
    expect(form.judge_max_calls_per_question).toBe(0);
    const payload = formToPayload(form);
    expect(payload.bank_turn_mode).toBe("judged");
    expect(payload.judge_silence_seconds).toBe(5);
    expect(payload.judge_max_calls_per_question).toBe(0);
    expect(emptyPersonaForm().judge_silence_seconds).toBe(2);
    expect(emptyPersonaForm().judge_max_calls_per_question).toBe(2);
  });

  it("falls back to linear when an older backend omits the field or sends garbage", () => {
    const legacy = persona() as unknown as Record<string, unknown>;
    delete legacy.bank_turn_mode;
    expect(personaToForm(legacy as unknown as PersonaOut).bank_turn_mode).toBe("linear");
    expect(
      personaToForm(persona({ bank_turn_mode: "model" as unknown as "judged" })).bank_turn_mode,
    ).toBe("linear");
  });

  it("flipping the interview brain carries the bank turn mode untouched", () => {
    const form = personaToForm(persona({ interview_brain: "bank", bank_turn_mode: "judged" }));
    const flipped = { ...form, interviewBrain: "external" };
    expect(formToPayload(flipped).bank_turn_mode).toBe("judged");
  });
});
