/**
 * Model-deployment dropdown (Phase 3) — per-persona.
 *
 * Lists the Foundry resource's real model deployments (from the admin config endpoint) and persists
 * the selection on the persona (`form.model`): different Foundry agent versions can run different
 * models, so the model is tracked per persona. An empty selection means "fall back to the global AI
 * Foundry config" (DB > .env > default); on reconcile the live agent version's model is pulled in
 * here. Controlled by `value` / `onChange` from the definition panel.
 */
import { useEffect, useState } from "react";
import {
  Caption1,
  Dropdown,
  Field,
  Option,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { getAiFoundryConfig, listModelDeployments, type ConfigOption } from "../../api/admin";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
});

interface ModelSelectProps {
  /** The persona's model (`form.model`); "" means "use the global default". */
  value: string;
  onChange: (model: string) => void;
}

export function ModelSelect({ value, onChange }: ModelSelectProps) {
  const styles = useStyles();
  const [options, setOptions] = useState<ConfigOption[]>([]);
  const [configured, setConfigured] = useState(""); // the global fallback model, for the caption
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    // Load the deployment list and the saved global config together. The persona's own model
    // (`value`) is authoritative for the selection; the global config only supplies the fallback
    // label and ensures a persona-set model that isn't in the discovered list stays visible.
    Promise.all([listModelDeployments(), getAiFoundryConfig().catch(() => null)])
      .then(([opts, config]) => {
        if (!active) return;
        setOptions(opts);
        setConfigured(config?.model_or_deployment ?? "");
      })
      .catch(() => {
        /* discovery is best-effort; leave empty */
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // The effective selection: the persona's model, else the global configured model.
  const selected = value || configured;
  // Keep a persona-set (or configured) model visible even if it isn't in the discovered list.
  const shownOptions =
    selected && !options.some((o) => o.value === selected)
      ? [{ value: selected, label: selected }, ...options]
      : options;

  return (
    <div className={styles.root} data-testid="model-select">
      <Field label="Model deployment">
        {loading ? (
          <Spinner size="tiny" label="Loading models…" />
        ) : shownOptions.length > 0 ? (
          <Dropdown
            aria-label="Model deployment"
            data-testid="model-dropdown"
            selectedOptions={selected ? [selected] : []}
            value={selected}
            onOptionSelect={(_, d) => onChange(d.optionValue ?? "")}
          >
            {shownOptions.map((o) => (
              <Option key={o.value} value={o.value}>
                {o.label}
              </Option>
            ))}
          </Dropdown>
        ) : (
          <Caption1 data-testid="model-empty">
            No deployments listed. Configure the AI Foundry connection under Admin.
          </Caption1>
        )}
      </Field>
      <Caption1>
        {value
          ? "This model is saved on the persona and synced to its Foundry agent."
          : `Using the global default${configured ? ` (${configured})` : ""}. Pick a model to set it per persona.`}
      </Caption1>
    </div>
  );
}
