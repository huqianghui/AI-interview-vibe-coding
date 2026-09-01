/**
 * Shared editable form-state for the Agent editor (Phase 3) + mappers to/from the wire types.
 *
 * The backend stores `voice_map`/`greeting_map` as JSON strings; the editor holds them as parsed
 * `Record<locale, string>` so the language selector can edit one locale at a time. Mappers convert
 * at the edges (load: PersonaOut → form; save: form → PersonaCreate/PersonaUpdate).
 */
import {
  parseLocaleMap,
  stringifyLocaleMap,
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
  model: string; // per-persona Foundry model deployment ("" → global default)
  tools: ToolConfig[];
}

/** A blank persona for the "New persona" flow (backend-default voice knobs). */
export function emptyPersonaForm(): PersonaFormState {
  return {
    name: "",
    character: "",
    style: "",
    prompt_fragment: "",
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
    model: "",
    tools: [],
  };
}

/** Load a persona into editable form state (parses the two JSON-string maps). */
export function personaToForm(p: PersonaOut): PersonaFormState {
  return {
    name: p.name,
    character: p.character,
    style: p.style,
    prompt_fragment: p.prompt_fragment,
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
    model: p.model ?? "",
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
    model: form.model,
    tools_config: stringifyToolsConfig(form.tools),
  };
}
