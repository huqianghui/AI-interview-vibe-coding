/** The admin page's Connection tab: the Azure AI Foundry runtime config and the external
 * interview API (low-frequency setup, kept out of the daily content-editing path). */
import {
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Dropdown,
  Input,
  Option,
  Spinner,
  Switch,
  Text,
  Title3,
} from "@fluentui/react-components";
import * as admin from "../../api/admin";
import { useAdminStyles, type Guard } from "./shared";
import type { ConnectionTabState } from "./useConnectionTab";

export function ConnectionTab({ state, guard }: { state: ConnectionTabState; guard: Guard }) {
  const styles = useAdminStyles();
  const {
    cfg,
    cfgEndpoint,
    setCfgEndpoint,
    cfgProject,
    setCfgProject,
    cfgModel,
    setCfgModel,
    cfgKb,
    setCfgKb,
    cfgKs,
    setCfgKs,
    cfgKey,
    setCfgKey,
    cfgStatus,
    setCfgStatus,
    cfgVoiceModel,
    setCfgVoiceModel,
    cfgVoiceByom,
    setCfgVoiceByom,
    cfgVoiceProfile,
    setCfgVoiceProfile,
    modelOverrides,
    byomDeployments,
    modelOptions,
    voiceModelOptions,
    probing,
    kbOptions,
    extCfg,
    extEndpoint,
    setExtEndpoint,
    extUserTag,
    setExtUserTag,
    extKey,
    setExtKey,
    extStatus,
    setExtStatus,
    extRevealed,
    setExtRevealed,
    refreshConfig,
    refreshExternalConfig,
    loadOptions,
    reprobeVoiceModels,
    foundryPayload,
  } = state;

  return (
    <>
      {/* Azure AI Foundry config — the runtime source of truth (DB > .env > default) */}
      <Card className={styles.card}>
        <CardHeader header={<Title3>Azure AI Foundry connection</Title3>} />
        <Body1>
          Saved here and used at runtime — overrides <code>.env</code>. The API key is optional:
          leave it blank to authenticate with Entra ID / Managed Identity (required for
          key-disabled resources); a saved key is used as fallback. The key is write-only; blank
          keeps the existing key.
        </Body1>
        <div className={styles.fieldGrid}>
          <Input
            value={cfgEndpoint}
            placeholder="Endpoint (https://…services.ai.azure.com)"
            onChange={(_, d) => setCfgEndpoint(d.value)}
            data-testid="cfg-endpoint"
          />
          <Input
            value={cfgProject}
            placeholder="Default project"
            onChange={(_, d) => setCfgProject(d.value)}
            data-testid="cfg-project"
          />
          <Input
            type="password"
            value={cfgKey}
            placeholder={
              cfg?.masked_key
                ? `API key (saved: ${cfg.masked_key})`
                : "API key — optional (blank = Entra ID / Managed Identity)"
            }
            onChange={(_, d) => setCfgKey(d.value)}
            data-testid="cfg-key"
          />
          {/* Auth-mode line: make the effective credential visible — a saved key is easy to
              forget and reads like a requirement; keyless is the normal state on key-disabled
              resources. Clearing is a deliberate separate action (blank on Save = keep key). */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {cfg?.masked_key ? (
              <>
                <Text data-testid="cfg-auth-mode">
                  API key saved ({cfg.masked_key}) — used as fallback; Entra ID / Managed
                  Identity is tried first.
                </Text>
                <Button
                  size="small"
                  data-testid="cfg-clear-key"
                  onClick={() =>
                    guard(async () => {
                      setCfgStatus(null);
                      await admin.updateAiFoundryConfig(
                        foundryPayload({ api_key: "", clear_api_key: true }),
                      );
                      setCfgKey("");
                      setCfgStatus("API key cleared — using Entra ID / Managed Identity.");
                      await refreshConfig();
                    })
                  }
                >
                  Clear key
                </Button>
              </>
            ) : (
              <Text data-testid="cfg-auth-mode">
                No API key saved — authenticating with Entra ID / Managed Identity.
              </Text>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button data-testid="cfg-load-options" onClick={loadOptions} disabled={probing}>
              Load models & knowledge bases
            </Button>
            {probing && <Spinner size="tiny" label="Probing the region…" />}
          </div>

          <Text weight="semibold">
            Inference model — judge and scoring always; the agent only as a fallback
          </Text>
          <Body1>
            A <strong>deployment</strong> in this resource — judge, scoring and the Foundry agent
            all address models by deployment name, so your own deployments are exactly right here.
            Judge and scoring always use this value. The digital-human agent uses it only when its
            persona has no model of its own: a model picked in the agent editor overrides it, and a
            synced persona usually has one, because reconcile pulls the live agent's model onto the
            persona. Changing this does not rewrite those — that would erase a deliberate choice.
          </Body1>

          {/* Model: dropdown once options are loaded, else a text input fallback. */}
          {modelOptions.length > 0 ? (
            <Dropdown
              aria-label="Model deployment"
              data-testid="cfg-model-dropdown"
              selectedOptions={cfgModel ? [cfgModel] : []}
              value={cfgModel}
              onOptionSelect={(_, d) => setCfgModel(d.optionValue ?? "")}
            >
              {modelOptions.map((o) => (
                <Option key={o.value} value={o.value}>
                  {o.label}
                </Option>
              ))}
            </Dropdown>
          ) : (
            <Input
              value={cfgModel}
              placeholder="Model / deployment (e.g. gpt-5-mini) — or Load options above"
              onChange={(_, d) => setCfgModel(d.value)}
              data-testid="cfg-model"
            />
          )}

          {modelOverrides.length > 0 ? (
            <Caption1 data-testid="cfg-model-overrides">
              {modelOverrides.length} persona(s) carry their own model and are NOT affected by this
              setting:{" "}
              {modelOverrides.map((o) => `${o.name} (${o.model})`).join(", ")}. Change those in the
              agent editor.
            </Caption1>
          ) : (
            <Caption1 data-testid="cfg-model-overrides-none">
              No persona overrides this — every persona's agent follows the model above.
            </Caption1>
          )}

          {/* The Voice Live SESSION model — a separate setting, because its legal values are a
              different set. Keeping it in one field with the inference model is what produced
              "Model X is not supported in this region" on every voice session. */}
          <Text weight="semibold">Voice session model — Voice Live</Text>
          <Switch
            label="Use my own model (bring your own model)"
            checked={cfgVoiceByom}
            data-testid="cfg-voice-byom"
            onChange={(_, d) => {
              const byom = !!d.checked;
              setCfgVoiceByom(byom);
              // Switching to BYOM, the voice session runs on a deployment — the same kind of name
              // the inference model uses — so default to it rather than leaving a native model
              // name behind that this path would reject.
              const stale =
                !cfgVoiceModel || voiceModelOptions.some((o) => o.value === cfgVoiceModel);
              if (byom && stale) setCfgVoiceModel(cfgModel.trim());
            }}
          />
          {cfgVoiceByom ? (
            <>
              <Body1>
                The voice session connects to <strong>your deployment</strong>. Note the voice leg
                never asks a model to think (it reads prepared text), so this changes the session
                host and billing path, not interview behaviour.
              </Body1>
              {cfgVoiceProfile === "byom-azure-openai-realtime" && (
                <Caption1 data-testid="cfg-byom-realtime-warning">
                  Measured: this works only if the interviewer persona has{" "}
                  <strong>text end-of-utterance detection turned off</strong> — it is ON by
                  default, and saving is refused while it is. Speech-native passthrough sends audio
                  straight to your model, so Voice Live runs no speech recognizer and cannot do
                  text-based end-of-utterance detection. Turn it off in the agent editor
                  (Configuration) and you lose the cleaner answer segmentation it gives the
                  transcript buffer and the judge&apos;s silence trigger. Input transcription is
                  fine either way.
                </Caption1>
              )}
              <Caption1 data-testid="cfg-byom-kind">
                Listing{" "}
                {admin.deploymentKindForProfile(cfgVoiceProfile) === "realtime"
                  ? "realtime deployments (not chat-capable, so they are absent from the inference list above)"
                  : admin.deploymentKindForProfile(cfgVoiceProfile) === "chat"
                    ? "chat-capable deployments"
                    : "every deployment — no filter can be verified for this profile"}
                .
              </Caption1>
              <Dropdown
                aria-label="BYOM profile"
                data-testid="cfg-byom-profile"
                selectedOptions={[cfgVoiceProfile]}
                value={
                  admin.BYOM_PROFILES.find((pr) => pr.value === cfgVoiceProfile)?.label ??
                  cfgVoiceProfile
                }
                onOptionSelect={(_, d) =>
                  setCfgVoiceProfile(d.optionValue ?? admin.DEFAULT_BYOM_PROFILE)
                }
              >
                {admin.BYOM_PROFILES.map((pr) => (
                  <Option key={pr.value} value={pr.value} text={pr.label}>
                    {pr.label}
                  </Option>
                ))}
              </Dropdown>
            </>
          ) : (
            <Body1 data-testid="cfg-voice-native-hint">
              The voice session runs on a model <strong>Azure hosts for Voice Live</strong> in this
              region. Those are not deployments in your resource, so judge / scoring / the agent
              cannot use them — <strong>these are two separate settings and both need a value</strong>.
            </Body1>
          )}
          {/* Native mode lists only models a real connection ACCEPTED here; BYOM mode lists your
              deployments. Either way the options are legal for the leg that uses them — and there
              is deliberately NO free-text box, since that is how an unsupported model got saved. */}
          {(cfgVoiceByom ? byomDeployments : voiceModelOptions).length > 0 ? (
            <Dropdown
              aria-label="Voice session model"
              data-testid="cfg-voice-model-dropdown"
              selectedOptions={cfgVoiceModel ? [cfgVoiceModel] : []}
              value={cfgVoiceModel}
              onOptionSelect={(_, d) => setCfgVoiceModel(d.optionValue ?? "")}
            >
              {(cfgVoiceByom ? byomDeployments : voiceModelOptions).map((o) => (
                <Option key={o.value} value={o.value}>
                  {o.label}
                </Option>
              ))}
            </Dropdown>
          ) : (
            <Caption1 data-testid="cfg-voice-model-empty">
              No options yet — use “Load models &amp; knowledge bases” above.
            </Caption1>
          )}
          {cfgVoiceModel &&
            !cfgVoiceByom &&
            voiceModelOptions.length > 0 &&
            !voiceModelOptions.some((o) => o.value === cfgVoiceModel) && (
              <Caption1 data-testid="cfg-voice-model-illegal">
                “{cfgVoiceModel}” is not in this region’s accepted list — voice sessions will fail
                with “not supported in this region”. Pick one above.
              </Caption1>
            )}
          {!cfgVoiceByom && (
            <Button
              size="small"
              onClick={reprobeVoiceModels}
              disabled={probing}
              data-testid="cfg-voice-reprobe"
            >
              Re-probe the region
            </Button>
          )}

          {/* Knowledge base: dropdown once loaded, else text input. */}
          {kbOptions.length > 0 ? (
            <Dropdown
              aria-label="Knowledge base"
              data-testid="cfg-kb-dropdown"
              selectedOptions={cfgKb ? [cfgKb] : []}
              value={cfgKb}
              onOptionSelect={(_, d) => setCfgKb(d.optionValue ?? "")}
            >
              {kbOptions.map((o) => (
                <Option key={o.value} value={o.value}>
                  {o.label}
                </Option>
              ))}
            </Dropdown>
          ) : (
            <Input
              value={cfgKb}
              placeholder="Foundry IQ knowledge base — or Load options above"
              onChange={(_, d) => setCfgKb(d.value)}
              data-testid="cfg-kb"
            />
          )}
          <Input
            value={cfgKs}
            placeholder="Knowledge source name (≠ knowledge base)"
            onChange={(_, d) => setCfgKs(d.value)}
            data-testid="cfg-ks"
          />

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button
              appearance="primary"
              data-testid="cfg-save"
              onClick={() =>
                guard(async () => {
                  setCfgStatus(null);
                  const saved = await admin.updateAiFoundryConfig(foundryPayload());
                  // The backend live-checks a changed voice model before committing, so a
                  // region-rejected choice never gets here (it is a 422 surfaced by guard).
                  setCfgStatus(saved.voice_model_check || "Saved.");
                  await refreshConfig();
                })
              }
            >
              Save
            </Button>
            <Button
              data-testid="cfg-test"
              onClick={() =>
                guard(async () => {
                  const r = await admin.testAiFoundryConfig();
                  setCfgStatus(r.message);
                })
              }
            >
              Test connection
            </Button>
            {cfgStatus && <Text data-testid="cfg-status">{cfgStatus}</Text>}
          </div>
        </div>
      </Card>

      {/* External interview API/server — Phase 2, vendor-neutral. Resolved live from the DB on
          every turn (DB > .env); a save takes effect on the next interview, no restart. */}
      <Card className={styles.card}>
        <CardHeader header={<Title3>External interview API</Title3>} />
        <Body1>
          The external interview server that drives personas set to the "External interview API"
          brain. Resolved at runtime — overrides <code>.env</code>. Must be an HTTPS endpoint. The
          API key is write-only; leave it blank to keep the existing key.
        </Body1>
        <div className={styles.fieldGrid}>
          <Input
            value={extEndpoint}
            placeholder="Endpoint (https://…)"
            onChange={(_, d) => setExtEndpoint(d.value)}
            data-testid="ext-endpoint"
          />
          <Input
            value={extUserTag}
            placeholder="User tag (per-deployment label, no PII) — optional"
            onChange={(_, d) => setExtUserTag(d.value)}
            data-testid="ext-user-tag"
          />
          <Input
            type="password"
            value={extKey}
            placeholder={extCfg?.masked_key ? `API key (saved: ${extCfg.masked_key})` : "API key"}
            onChange={(_, d) => setExtKey(d.value)}
            data-testid="ext-key"
          />

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button
              appearance="primary"
              data-testid="ext-save"
              onClick={() =>
                guard(async () => {
                  setExtStatus(null);
                  await admin.updateExternalConfig({
                    endpoint: extEndpoint.trim(),
                    api_key: extKey,
                    user_tag: extUserTag.trim(),
                  });
                  setExtStatus("Saved.");
                  await refreshExternalConfig();
                })
              }
            >
              Save
            </Button>
            <Button
              data-testid="ext-test"
              onClick={() =>
                guard(async () => {
                  const r = await admin.testExternalConfig();
                  setExtStatus(r.message);
                })
              }
            >
              Test connection
            </Button>
            <Button
              data-testid="ext-reveal"
              onClick={() =>
                guard(async () => {
                  if (extRevealed !== null) {
                    setExtRevealed(null);
                    return;
                  }
                  const r = await admin.revealExternalKey();
                  setExtRevealed(r.api_key || "(no key configured)");
                })
              }
            >
              {extRevealed !== null ? "Hide key" : "Reveal key"}
            </Button>
            {extStatus && <Text data-testid="ext-status">{extStatus}</Text>}
          </div>
          {extRevealed !== null && (
            <Text data-testid="ext-revealed" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
              {extRevealed}
            </Text>
          )}
        </div>
      </Card>
    </>
  );
}
