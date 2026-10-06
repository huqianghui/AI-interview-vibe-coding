/**
 * Configuration rail (Phase 3) — the drawer body mirroring the portal's right rail.
 *
 * Language selector drives which locale of voice_map/greeting_map is edited; speech voice +
 * greeting bind to that active locale. Interim/proactive toggles + the avatar grid bind to their
 * persona fields. Turn-detection + audio-processing knobs live under a collapsible Advanced block
 * (the portal's named controls are the top-level ones; these are secondary).
 */
import { useState } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Divider,
  Dropdown,
  Field,
  Input,
  Option,
  Radio,
  RadioGroup,
  Subtitle2,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AvatarGrid } from "./AvatarGrid";
import { BoundedIntInput } from "../BoundedIntInput";
import {
  EDITOR_LOCALES,
  normalizeBankTurnMode,
  type EditorLocale,
  type PersonaFormState,
} from "../../pages/agentEditorForm";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, minWidth: "300px" },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
});

/** A minimal voice set per locale (portal offers many; this is a sane, offline default list). */
const VOICE_OPTIONS: Record<EditorLocale, string[]> = {
  "zh-CN": ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-XiaoyiNeural"],
  "en-US": ["en-US-AvaNeural", "en-US-AndrewNeural", "en-US-EmmaNeural"],
};

// Bounds for the silence auto-submit window — mirror the backend's VOICE_AUTO_SUBMIT_MIN/MAX_SECONDS
// (1s would fire on any breath pause; past a minute is indistinguishable from "off").
const AUTO_SUBMIT_MIN_SECONDS = 1;
const AUTO_SUBMIT_MAX_SECONDS = 60;
// Judge knobs (issue #114) — mirror the backend's JUDGE_SILENCE_* / JUDGE_MAX_CALLS_* bounds.
const JUDGE_SILENCE_MIN_SECONDS = 1;
const JUDGE_SILENCE_MAX_SECONDS = 30;
const JUDGE_MAX_CALLS_MIN = 0;
const JUDGE_MAX_CALLS_MAX = 5;

const TURN_DETECTION_OPTIONS = [
  "azure_semantic_vad",
  "server_vad",
  "none",
];

export interface ConfigurationRailProps {
  form: PersonaFormState;
  onChange: (patch: Partial<PersonaFormState>) => void;
  activeLocale: EditorLocale;
  onLocaleChange: (locale: EditorLocale) => void;
}

export function ConfigurationRail({
  form,
  onChange,
  activeLocale,
  onLocaleChange,
}: ConfigurationRailProps) {
  const styles = useStyles();
  const [advancedOpen, setAdvancedOpen] = useState<string[]>([]);

  const voice = form.voiceMap[activeLocale] ?? "";
  const greeting = form.greetingMap[activeLocale] ?? "";
  const voiceChoices = VOICE_OPTIONS[activeLocale];

  return (
    <div className={styles.root} data-testid="configuration-rail-body">
      {/* Language */}
      <Field label="Language">
        <Dropdown
          aria-label="Language"
          data-testid="config-language"
          selectedOptions={[activeLocale]}
          value={activeLocale}
          onOptionSelect={(_, d) => onLocaleChange((d.optionValue as EditorLocale) ?? activeLocale)}
        >
          {EDITOR_LOCALES.map((l) => (
            <Option key={l} value={l}>
              {l}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <Divider />
      <Subtitle2>Speech output</Subtitle2>

      {/* Speech voice (per active locale) */}
      <Field label={`Speech voice (${activeLocale})`}>
        <Dropdown
          aria-label="Speech voice"
          data-testid="config-voice"
          selectedOptions={voice ? [voice] : []}
          value={voice}
          placeholder="Select a voice"
          onOptionSelect={(_, d) =>
            onChange({ voiceMap: { ...form.voiceMap, [activeLocale]: d.optionValue ?? "" } })
          }
        >
          {voiceChoices.map((v) => (
            <Option key={v} value={v}>
              {v}
            </Option>
          ))}
        </Dropdown>
      </Field>

      {/* Greeting (per active locale) */}
      <Field label={`Greeting (${activeLocale})`}>
        <Textarea
          value={greeting}
          resize="vertical"
          data-testid="config-greeting"
          onChange={(_, d) =>
            onChange({ greetingMap: { ...form.greetingMap, [activeLocale]: d.value } })
          }
        />
      </Field>

      {/* Named top-level toggles */}
      <div className={styles.section}>
        <Field hint="Editor Playground only. A real interview reads every question word for word, so it never uses interim responses.">
          <Switch
            label="Interim response"
            checked={form.interim_response}
            onChange={(_, d) => onChange({ interim_response: d.checked })}
            data-testid="config-interim"
          />
        </Field>
        <Field hint="Editor Playground only: it is part of the Foundry agent, and a real interview does not use the agent.">
          <Switch
            label="Proactive engagement"
            checked={form.proactive_engagement}
            onChange={(_, d) => onChange({ proactive_engagement: d.checked })}
            data-testid="config-proactive"
          />
        </Field>
      </div>

      <Divider />
      <Subtitle2>Answer submission (voice)</Subtitle2>

      {/* Silence auto-submit — ONE INDEPENDENT PAIR PER ENGINE, and only the active engine's pair
          is shown (same rule as the two prompt fields: the other pair keeps its value untouched).
          Bank defaults OFF: a fixed 3s window used to submit while candidates were still thinking,
          so the admin decides whether silence may end a bank answer at all. External defaults ON
          (its hands-free flow). Off ⇒ the turn advances only on the "I'm done" click. */}
      <AutoSubmitControls
        key={form.interviewBrain}
        engine={form.interviewBrain === "external" ? "external" : "bank"}
        form={form}
        onChange={onChange}
      />

      {/* Turn control — BANK engine only. "linear" (default): the digital human only reads each
          question and stays silent in between (the "Thank you. Thank you." fix: server-VAD used to
          open a model turn on EVERY pause). "judged": a backend judge may nudge during the
          candidate's pauses (never a follow-up or redirect since 2026-09-28). The pre-v0.39 "model"
          hands-free turn is retired. External sessions are linear by construction (no brain of their
          own), so nothing to show. */}
      {form.interviewBrain !== "external" && (
        <TurnModeControls form={form} onChange={onChange} />
      )}

      <Divider />
      <Subtitle2>Avatar</Subtitle2>

      {/* Avatar grid */}
      <Field label="Avatar">
        <AvatarGrid
          character={form.character}
          style={form.style}
          onSelect={(character, style) => onChange({ character, style })}
        />
      </Field>

      {/* Advanced */}
      <Accordion
        collapsible
        openItems={advancedOpen}
        onToggle={(_, d) => setAdvancedOpen(d.openItems as string[])}
      >
        <AccordionItem value="advanced">
          <AccordionHeader data-testid="config-advanced-toggle">Advanced</AccordionHeader>
          <AccordionPanel>
            <div className={styles.section}>
              <Field label="Turn detection">
                <Dropdown
                  aria-label="Turn detection"
                  data-testid="config-turn-detection"
                  selectedOptions={[form.turn_detection]}
                  value={form.turn_detection}
                  onOptionSelect={(_, d) =>
                    onChange({ turn_detection: d.optionValue ?? form.turn_detection })
                  }
                >
                  {TURN_DETECTION_OPTIONS.map((t) => (
                    <Option key={t} value={t}>
                      {t}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Switch
                label="End-of-utterance detection"
                checked={form.eou_detection}
                onChange={(_, d) => onChange({ eou_detection: d.checked })}
                data-testid="config-eou"
              />
              <Switch
                label="Noise suppression"
                checked={form.noise_suppression}
                onChange={(_, d) => onChange({ noise_suppression: d.checked })}
                data-testid="config-noise"
              />
              <Field hint="Turn off only when candidates use headsets: without it, the microphone can pick up the interviewer's own voice from the speakers.">
                <Switch
                  label="Echo cancellation"
                  checked={form.echo_cancellation}
                  onChange={(_, d) => onChange({ echo_cancellation: d.checked })}
                  data-testid="config-echo"
                />
              </Field>
              {/* Azure Voice Live bounds: temperature 0–1 (expressiveness of HD voices), rate
                  0.5–1.5. Since v0.39.3.3 these reach the live session, and the API refuses values
                  outside the range — the inputs advertise the same range. */}
              <Field
                label="Voice temperature"
                hint="0–1. Expressiveness of the voice (HD voices): higher is more dynamic, lower is neutral."
              >
                <Input
                  type="number"
                  value={String(form.voice_temperature)}
                  min={0}
                  max={1}
                  step={0.1}
                  onChange={(_, d) => onChange({ voice_temperature: Number(d.value) })}
                  data-testid="config-temperature"
                />
              </Field>
              <Field label="Playback speed" hint="0.5–1.5. Speaking rate; 1 is the voice's natural pace.">
                <Input
                  type="number"
                  value={String(form.playback_speed)}
                  min={0.5}
                  max={1.5}
                  step={0.1}
                  onChange={(_, d) => onChange({ playback_speed: Number(d.value) })}
                  data-testid="config-playback-speed"
                />
              </Field>
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

type AutoSubmitEngine = "bank" | "external";

const AUTO_SUBMIT_FIELDS = {
  bank: {
    enabled: "bank_auto_submit_enabled",
    seconds: "bank_auto_submit_silence_seconds",
    title: "Question bank",
  },
  external: {
    enabled: "external_auto_submit_enabled",
    seconds: "external_auto_submit_silence_seconds",
    title: "External interview API",
  },
} as const;

interface AutoSubmitControlsProps {
  engine: AutoSubmitEngine;
  form: PersonaFormState;
  onChange: (patch: Partial<PersonaFormState>) => void;
}

/** The active engine's (switch, seconds) pair. Mounted with `key={interviewBrain}` by the rail so
 * the seconds draft resets when the admin switches engines. */
function AutoSubmitControls({ engine, form, onChange }: AutoSubmitControlsProps) {
  const styles = useStyles();
  const fields = AUTO_SUBMIT_FIELDS[engine];
  const enabled = form[fields.enabled];
  const seconds = form[fields.seconds];
  return (
    <div className={styles.section} data-testid={`config-auto-submit-${engine}`}>
      <Switch
        label={`Auto-submit answer after silence (${fields.title})`}
        checked={enabled}
        onChange={(_, d) => onChange({ [fields.enabled]: d.checked })}
        data-testid="config-auto-submit"
      />
      <Field
        label="Silence before auto-submit (seconds)"
        hint={
          enabled
            ? "Counted from the end of the candidate's last utterance; speaking again resets it. The \"I'm done\" button still submits immediately."
            : `Off for ${fields.title}: the candidate must click "I'm done" to submit — a thinking pause never ends the answer.`
        }
      >
        <BoundedIntInput
          value={seconds}
          min={AUTO_SUBMIT_MIN_SECONDS}
          max={AUTO_SUBMIT_MAX_SECONDS}
          disabled={!enabled}
          onCommit={(v) => onChange({ [fields.seconds]: v })}
          data-testid="config-auto-submit-seconds"
        />
      </Field>
    </div>
  );
}

interface TurnModeControlsProps {
  form: PersonaFormState;
  onChange: (patch: Partial<PersonaFormState>) => void;
}

/** The bank engine's turn contract (issue #114): linear (silent between questions) or judged (a
 * backend judge may NUDGE — "please go on" — DURING the candidate's pauses; never a follow-up or a
 * redirect since 2026-09-28, never at submit; "I'm done" always advances). The two judge knobs show
 * only for judged. */
function TurnModeControls({ form, onChange }: TurnModeControlsProps) {
  const styles = useStyles();
  const mode = form.bank_turn_mode;
  return (
    <div className={styles.section} data-testid="config-turn-mode">
      <Field
        label="Between questions (question bank)"
        hint={
          mode === "linear"
            ? "The interviewer only reads each question aloud and stays silent while the candidate answers — no acknowledgments, no follow-ups. Questions are read as text-to-speech of the bank text, never generated or rephrased by a model. The next question starts on \"I'm done\" (or auto-submit)."
            : "While the candidate pauses mid-thought, a backend judge may say one encouraging line (\"please go on\") — it never asks a follow-up question, never redirects, and never speaks at submit: \"I'm done\" always moves to the next question. Questions and the judge's words are read as text-to-speech, exactly as written. Tone and patience come from the Instructions prompt; the format rules are fixed."
        }
      >
        <RadioGroup
          value={mode}
          onChange={(_, d) => onChange({ bank_turn_mode: normalizeBankTurnMode(d.value) })}
          aria-label="Between questions (question bank)"
        >
          <Radio
            value="linear"
            label="Linear turns — read the question, then stay silent"
            data-testid="config-turn-mode-linear"
          />
          <Radio
            value="judged"
            label="Judged turns — a gentle nudge when the candidate trails off; never a follow-up"
            data-testid="config-turn-mode-judged"
          />
        </RadioGroup>
      </Field>
      {mode === "judged" ? (
        <>
          <Field
            label="Silence before the judge listens (seconds)"
            hint="Counted from the end of the candidate's last utterance (voice) or last keystroke (text). Each pause that long is one judge check."
          >
            <BoundedIntInput
              value={form.judge_silence_seconds}
              min={JUDGE_SILENCE_MIN_SECONDS}
              max={JUDGE_SILENCE_MAX_SECONDS}
              onCommit={(v) => onChange({ judge_silence_seconds: v })}
              data-testid="config-judge-silence"
            />
          </Field>
          <Field
            label="Max judge checks per question, before submit"
            hint="Caps how many times the judge is consulted on one question (including checks that decide to stay silent). 0 = never. Follow-ups are additionally capped by the question's own max follow-ups."
          >
            <BoundedIntInput
              value={form.judge_max_calls_per_question}
              min={JUDGE_MAX_CALLS_MIN}
              max={JUDGE_MAX_CALLS_MAX}
              onCommit={(v) => onChange({ judge_max_calls_per_question: v })}
              data-testid="config-judge-max-calls"
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}
