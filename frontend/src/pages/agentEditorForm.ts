/**
 * Shared editable form-state for the Agent editor (Phase 3) + mappers to/from the wire types.
 *
 * The backend stores `voice_map`/`greeting_map` as JSON strings; the editor holds them as parsed
 * `Record<locale, string>` so the language selector can edit one locale at a time. Mappers convert
 * at the edges (load: PersonaOut → form; save: form → PersonaCreate/PersonaUpdate).
 */
import {
  BANK_TURN_MODES,
  parseLocaleMap,
  stringifyLocaleMap,
  type BankTurnMode,
  type PersonaCreate,
  type PersonaOut,
} from "../api/personas";
import { parseToolsConfig, stringifyToolsConfig, type ToolConfig } from "../data/agentTools";

/** Locales this project supports (mirrors i18n SUPPORTED_LANGUAGES). */
export const EDITOR_LOCALES = ["en-US", "zh-CN"] as const;
export type EditorLocale = (typeof EDITOR_LOCALES)[number];

/** Coerce a stored locale string to a supported EditorLocale, falling back to the first. */
export function normalizeLocale(value: string | null | undefined): EditorLocale {
  return (EDITOR_LOCALES as readonly string[]).includes(value ?? "")
    ? (value as EditorLocale)
    : EDITOR_LOCALES[0];
}

/** The mutable slice the editor edits (no server-owned id / agent-sync bookkeeping). */
export interface PersonaFormState {
  name: string;
  character: string;
  style: string;
  prompt_fragment: string;
  // EXTERNAL-mode reader prompt — INDEPENDENT of prompt_fragment (two separate config items, never
  // one swapped by interviewBrain). Empty here means "use the generated default" (the proxy treats
  // blank and NULL identically — both fall back to default_external_reader_prompt). Both fields
  // persist independently, so toggling the brain never clears either.
  externalReaderPrompt: string;
  voiceMap: Record<string, string>;
  greetingMap: Record<string, string>;
  defaultLocale: EditorLocale; // remembered "Language" selector locale (persisted, round-trips)
  enabled: boolean;
  is_default: boolean;
  turn_detection: string;
  eou_detection: boolean;
  noise_suppression: boolean;
  echo_cancellation: boolean;
  interim_response: boolean;
  proactive_engagement: boolean;
  voice_temperature: number;
  playback_speed: number;
  // Silence auto-submit, one independent pair per engine (bank OFF / external ON by default).
  // The rail edits only the active interviewBrain's pair; both persist so toggling the brain
  // never clears or copies either.
  bank_auto_submit_enabled: boolean;
  bank_auto_submit_silence_seconds: number;
  external_auto_submit_enabled: boolean;
  external_auto_submit_silence_seconds: number;
  // Bank-session turn contract ("linear" default / "model"). Bank-only: the rail shows it for the
  // bank engine and it persists untouched while the persona runs external.
  bank_turn_mode: BankTurnMode;
  model: string; // per-persona Foundry model deployment ("" → global default)
  interviewBrain: string; // "bank" (built-in question bank) | "external" (external interview API)
  tools: ToolConfig[];
}

/** A blank persona for the "New persona" flow (backend-default voice knobs). */
export function emptyPersonaForm(): PersonaFormState {
  return {
    name: "",
    character: "",
    style: "",
    prompt_fragment: "",
    externalReaderPrompt: "",
    voiceMap: {},
    greetingMap: {},
    defaultLocale: EDITOR_LOCALES[0],
    enabled: true,
    is_default: false,
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
    model: "",
    interviewBrain: "bank",
    tools: [],
  };
}

/** Coerce a stored turn mode to a known BankTurnMode; unknown/missing (older backend) ⇒ linear. */
export function normalizeBankTurnMode(value: string | null | undefined): BankTurnMode {
  return (BANK_TURN_MODES as readonly string[]).includes(value ?? "")
    ? (value as BankTurnMode)
    : "linear";
}

/** Load a persona into editable form state (parses the two JSON-string maps). */
export function personaToForm(p: PersonaOut): PersonaFormState {
  return {
    name: p.name,
    character: p.character,
    style: p.style,
    prompt_fragment: p.prompt_fragment,
    externalReaderPrompt: p.external_reader_prompt ?? "",
    voiceMap: parseLocaleMap(p.voice_map),
    greetingMap: parseLocaleMap(p.greeting_map),
    defaultLocale: normalizeLocale(p.default_locale),
    enabled: p.enabled,
    is_default: p.is_default,
    turn_detection: p.turn_detection,
    eou_detection: p.eou_detection,
    noise_suppression: p.noise_suppression,
    echo_cancellation: p.echo_cancellation,
    interim_response: p.interim_response,
    proactive_engagement: p.proactive_engagement,
    voice_temperature: p.voice_temperature,
    playback_speed: p.playback_speed,
    bank_auto_submit_enabled: p.bank_auto_submit_enabled ?? false,
    bank_auto_submit_silence_seconds: p.bank_auto_submit_silence_seconds ?? 3,
    external_auto_submit_enabled: p.external_auto_submit_enabled ?? true,
    external_auto_submit_silence_seconds: p.external_auto_submit_silence_seconds ?? 3,
    bank_turn_mode: normalizeBankTurnMode(p.bank_turn_mode),
    model: p.model ?? "",
    interviewBrain: p.interview_brain ?? "bank",
    tools: parseToolsConfig(p.tools_config),
  };
}

/** Serialize form state to the create/update payload (stringifies the two maps). */
export function formToPayload(form: PersonaFormState): PersonaCreate {
  return {
    name: form.name,
    character: form.character,
    style: form.style,
    prompt_fragment: form.prompt_fragment,
    external_reader_prompt: form.externalReaderPrompt,
    voice_map: stringifyLocaleMap(form.voiceMap),
    greeting_map: stringifyLocaleMap(form.greetingMap),
    default_locale: form.defaultLocale,
    enabled: form.enabled,
    is_default: form.is_default,
    turn_detection: form.turn_detection,
    eou_detection: form.eou_detection,
    noise_suppression: form.noise_suppression,
    echo_cancellation: form.echo_cancellation,
    interim_response: form.interim_response,
    proactive_engagement: form.proactive_engagement,
    voice_temperature: form.voice_temperature,
    playback_speed: form.playback_speed,
    bank_auto_submit_enabled: form.bank_auto_submit_enabled,
    bank_auto_submit_silence_seconds: form.bank_auto_submit_silence_seconds,
    external_auto_submit_enabled: form.external_auto_submit_enabled,
    external_auto_submit_silence_seconds: form.external_auto_submit_silence_seconds,
    bank_turn_mode: form.bank_turn_mode,
    model: form.model,
    interview_brain: form.interviewBrain,
    tools_config: stringifyToolsConfig(form.tools),
  };
}
