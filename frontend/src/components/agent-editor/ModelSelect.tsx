/**
 * Model-deployment dropdown (Phase 3) — informational.
 *
 * Lists the Foundry resource's real model deployments (from the admin config endpoint). This repo's
 * InterviewerPersona has no per-persona model column, so the selection is NOT persisted per persona
 * — the agent model resolves from the global AI Foundry config (DB > .env > default). The dropdown
 * exists for portal parity + visibility; a caption states the informational-only behaviour.
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
import { listModelDeployments, type ConfigOption } from "../../api/admin";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
});

export function ModelSelect() {
  const styles = useStyles();
  const [options, setOptions] = useState<ConfigOption[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    listModelDeployments()
      .then((opts) => {
        if (!active) return;
        setOptions(opts);
        if (opts.length > 0) setSelected(opts[0].value);
      })
      .catch(() => {
        /* discovery is best-effort; leave empty */
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className={styles.root} data-testid="model-select">
      <Field label="Model deployment">
        {loading ? (
          <Spinner size="tiny" label="Loading models…" />
        ) : options.length > 0 ? (
          <Dropdown
            aria-label="Model deployment"
            data-testid="model-dropdown"
            selectedOptions={selected ? [selected] : []}
            value={selected}
            onOptionSelect={(_, d) => setSelected(d.optionValue ?? "")}
          >
            {options.map((o) => (
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
        Model is set at the Foundry connection level; per-persona selection is not persisted.
      </Caption1>
    </div>
  );
}
