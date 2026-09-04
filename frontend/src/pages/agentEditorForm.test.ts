/**
 * Form-mapper round-trip (regression for the "Language reset on refresh" bug): the editor's
 * "Language" selector is `default_locale`, a persisted persona field. personaToForm must read it
 * and formToPayload must send it, so a Save→reload cycle restores the selected locale instead of
 * snapping back to the hardcoded default locale.
 */
import { describe, expect, it } from "vitest";
import type { PersonaOut } from "../api/personas";
import { formToPayload, normalizeLocale, personaToForm } from "./agentEditorForm";

const persona = (over: Partial<PersonaOut> = {}): PersonaOut => ({
  id: "p1",
  name: "Interviewer",
  character: "lisa",
  style: "casual",
  prompt_fragment: "",
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
  model: null,
  interview_brain: "bank",
  agent_id: null,
  agent_version: null,
  agent_sync_status: "synced",
  agent_sync_error: null,
  default_instructions: "",
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
