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
  Subtitle2,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AvatarGrid } from "./AvatarGrid";
import { EDITOR_LOCALES, type EditorLocale, type PersonaFormState } from "../../pages/agentEditorForm";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, minWidth: "300px" },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
});

/** A minimal voice set per locale (portal offers many; this is a sane, offline default list). */
const VOICE_OPTIONS: Record<EditorLocale, string[]> = {
  "zh-CN": ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-XiaoyiNeural"],
  "en-US": ["en-US-AvaNeural", "en-US-AndrewNeural", "en-US-EmmaNeural"],
};

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
