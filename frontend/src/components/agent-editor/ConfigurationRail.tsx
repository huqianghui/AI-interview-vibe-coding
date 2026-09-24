/**
 * Configuration rail (Phase 3) — the drawer body mirroring the portal's right rail.
 *
 * Language selector drives which locale of voice_map/greeting_map is edited; speech voice +
 * greeting bind to that active locale. Interim/proactive toggles + the avatar grid bind to their
 * persona fields. Turn-detection + audio-processing knobs live under a collapsible Advanced block
 * (the portal's named controls are the top-level ones; these are secondary).
 */
import { useEffect, useState } from "react";
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
import type { BankTurnMode } from "../../api/personas";
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
        <Switch
          label="Interim response"
          checked={form.interim_response}
          onChange={(_, d) => onChange({ interim_response: d.checked })}
          data-testid="config-interim"
        />
        <Switch
          label="Proactive engagement"
          checked={form.proactive_engagement}
          onChange={(_, d) => onChange({ proactive_engagement: d.checked })}
          data-testid="config-proactive"
        />
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

      {/* Turn control — BANK engine only. Does the model get a generative turn of its own between
          questions? "linear" (default): no — the digital human only reads each question and is
          silent in between (the "Thank you. Thank you." fix: server-VAD used to open a model turn on
          EVERY pause). "model": the pre-v0.38.2.0 hands-free turn, governed by the instructions.
          External sessions are linear by construction (no brain of their own), so nothing to show. */}
      {form.interviewBrain !== "external" && (
        <TurnModeControls mode={form.bank_turn_mode} onChange={onChange} />
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
              <Switch
                label="Echo cancellation"
                checked={form.echo_cancellation}
                onChange={(_, d) => onChange({ echo_cancellation: d.checked })}
                data-testid="config-echo"
              />
              <Field label="Voice temperature">
                <Input
                  type="number"
                  value={String(form.voice_temperature)}
                  min={0}
                  max={2}
                  step={0.1}
                  onChange={(_, d) => onChange({ voice_temperature: Number(d.value) })}
                  data-testid="config-temperature"
                />
              </Field>
              <Field label="Playback speed">
                <Input
                  type="number"
                  value={String(form.playback_speed)}
                  min={0.5}
                  max={2}
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
  // The seconds input edits a local DRAFT string and commits (parsed + clamped to 1–60) on blur /
  // Enter — clamping on every keystroke snapped an emptied field to "1" and fought the next digit.
  const [draft, setDraft] = useState(String(seconds));
  useEffect(() => {
    setDraft(String(seconds));
  }, [seconds]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || draft.trim() === "") {
      setDraft(String(seconds)); // garbage / empty → revert to the saved value
      return;
    }
    const clamped = Math.min(AUTO_SUBMIT_MAX_SECONDS, Math.max(AUTO_SUBMIT_MIN_SECONDS, n));
    setDraft(String(clamped));
    if (clamped !== seconds) onChange({ [fields.seconds]: clamped });
  };
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
        <Input
          type="number"
          value={draft}
          min={AUTO_SUBMIT_MIN_SECONDS}
          max={AUTO_SUBMIT_MAX_SECONDS}
          step={1}
          disabled={!enabled}
          onChange={(_, d) => setDraft(d.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          data-testid="config-auto-submit-seconds"
        />
      </Field>
    </div>
  );
}

interface TurnModeControlsProps {
  mode: BankTurnMode;
  onChange: (patch: Partial<PersonaFormState>) => void;
}

/** The bank engine's turn contract: linear (silent between questions) vs the model's own turn. */
function TurnModeControls({ mode, onChange }: TurnModeControlsProps) {
  const styles = useStyles();
  return (
    <div className={styles.section} data-testid="config-turn-mode">
      <Field
        label="Between questions (question bank)"
        hint={
          mode === "linear"
            ? "The interviewer only reads each question aloud and stays silent while the candidate answers — no acknowledgments, no follow-ups of its own. The next question starts on \"I'm done\" (or auto-submit)."
            : "After every pause the model gets a turn of its own and may acknowledge (\"Thank you.\"), say \"please go on\", or follow up — governed by the instructions. It can react once per pause, not once per answer."
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
            value="model"
            label="Model has its own turn — may acknowledge or follow up"
            data-testid="config-turn-mode-model"
          />
        </RadioGroup>
      </Field>
    </div>
  );
}
