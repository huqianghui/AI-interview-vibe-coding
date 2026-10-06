/** State and actions of the admin page's Connection tab: the Azure AI Foundry runtime config and the
 * external interview API. Called by AdminPage, so unsaved edits survive a tab switch. */
import { useCallback, useEffect, useState } from "react";
import * as admin from "../../api/admin";
import type { AiFoundryConfig, ConfigOption, ExternalConfig } from "../../api/admin";
import { listPersonas } from "../../api/personas";
import type { Guard } from "./shared";

export function useConnectionTab(guard: Guard) {
  // Azure AI Foundry config (runtime source of truth). api_key is write-only; masked on load.
  const [cfg, setCfg] = useState<AiFoundryConfig | null>(null);
  const [cfgEndpoint, setCfgEndpoint] = useState("");
  const [cfgProject, setCfgProject] = useState("");
  const [cfgModel, setCfgModel] = useState("");
  const [cfgKb, setCfgKb] = useState("");
  const [cfgKs, setCfgKs] = useState("");
  const [cfgKey, setCfgKey] = useState("");
  const [cfgStatus, setCfgStatus] = useState<string | null>(null);
  // The Voice Live SESSION model — a separate setting from the inference model above, because the
  // legal values differ: Voice Live MODEL mode accepts only models it hosts natively in the region,
  // while judge/scoring/the agent address models by deployment name. `cfgVoiceByom` off = platform
  // native (path ①); on = your own deployment via a profile (path ②).
  const [cfgVoiceModel, setCfgVoiceModel] = useState("");
  const [cfgVoiceByom, setCfgVoiceByom] = useState(false);
  const [cfgVoiceProfile, setCfgVoiceProfile] = useState<string>(admin.DEFAULT_BYOM_PROFILE);
  // Personas that carry their OWN model and therefore ignore the inference model below. Read-only:
  // this page deliberately does not push the global value down onto them (that would erase a
  // deliberate per-persona choice), so the honest thing is to show the operator who overrides it.
  const [modelOverrides, setModelOverrides] = useState<{ name: string; model: string }[]>([]);
  // Deployments legal for the CHOSEN BYOM profile. Separate from `modelOptions` (chat-only, for the
  // inference model) because a realtime deployment is not chat-capable: reusing the chat list left
  // byom-azure-openai-realtime with nothing selectable even though that path is live-verified.
  const [byomDeployments, setByomDeployments] = useState<ConfigOption[]>([]);
  // Options pulled from the real Foundry resource; empty until "Load options" fetches them.
  const [modelOptions, setModelOptions] = useState<ConfigOption[]>([]);
  const [voiceModelOptions, setVoiceModelOptions] = useState<ConfigOption[]>([]);
  const [probing, setProbing] = useState(false);
  const [kbOptions, setKbOptions] = useState<ConfigOption[]>([]);

  // External interview API/server config (Phase 2, vendor-neutral). Resolved live from the DB on
  // every turn (DB > .env), so a save takes effect on the next interview — no restart. The key is
  // write-only on load (masked); a separate reveal call fetches the plaintext on a deliberate click.
  const [extCfg, setExtCfg] = useState<ExternalConfig | null>(null);
  const [extEndpoint, setExtEndpoint] = useState("");
  const [extUserTag, setExtUserTag] = useState("");
  const [extKey, setExtKey] = useState("");
  const [extStatus, setExtStatus] = useState<string | null>(null);
  // null = hidden; a string = the revealed plaintext key (shown read-only, never in the edit field).
  const [extRevealed, setExtRevealed] = useState<string | null>(null);

  const refreshConfig = useCallback(
    () =>
      guard(async () => {
        const c = await admin.getAiFoundryConfig();
        setCfg(c);
        setCfgEndpoint(c.endpoint);
        setCfgProject(c.default_project);
        setCfgModel(c.model_or_deployment);
        setCfgVoiceModel(c.voice_model ?? "");
        setCfgVoiceByom((c.voice_model_mode ?? "native") === "byom");
        setCfgVoiceProfile(c.voice_byom_profile || admin.DEFAULT_BYOM_PROFILE);
        setCfgKb(c.knowledge_base);
        setCfgKs(c.knowledge_source);
        setCfgKey(""); // never prefill the (masked) key; empty = keep existing
        // Best-effort: the notice is informational, so a failure here must not break the config
        // panel (and a fresh install has no personas yet).
        try {
          const personas = await listPersonas();
          setModelOverrides(
            personas
              .filter((pp) => (pp.model ?? "").trim())
              .map((pp) => ({ name: pp.name, model: (pp.model ?? "").trim() })),
          );
        } catch {
          setModelOverrides([]);
        }
      }),
    [guard],
  );

  const refreshExternalConfig = useCallback(
    () =>
      guard(async () => {
        const c = await admin.getExternalConfig();
        setExtCfg(c);
        setExtEndpoint(c.endpoint);
        setExtUserTag(c.user_tag);
        setExtKey(""); // never prefill the (masked) key; empty = keep existing
        setExtRevealed(null);
      }),
    [guard],
  );

  // Pull the real model deployments + knowledge bases from the saved Foundry resource, plus the
  // native Voice Live models this REGION actually accepts (measured by real connections — no API
  // lists them and the docs table runs ahead of rollout, so this is the only trustworthy source).
  const loadOptions = () =>
    guard(async () => {
      setCfgStatus(null);
      setProbing(true);
      try {
        const [models, kbs, voiceModels] = await Promise.all([
          admin.listModelDeployments(),
          admin.listKnowledgeBases(),
          admin.listVoiceLiveModels(),
        ]);
        setModelOptions(models);
        setKbOptions(kbs);
        setVoiceModelOptions(voiceModels);
        setCfgStatus(
          `Loaded ${models.length} deployment(s), ${voiceModels.length} native voice model(s), ` +
            `${kbs.length} knowledge base(s).`,
        );
      } finally {
        setProbing(false);
      }
    });

  // The BYOM deployment list follows the chosen profile (chat / realtime / all). Runs only in BYOM
  // mode, so the native path costs nothing.
  useEffect(() => {
    if (!cfgVoiceByom) return;
    let active = true;
    void admin
      .listModelDeployments(admin.deploymentKindForProfile(cfgVoiceProfile))
      .then((opts) => active && setByomDeployments(opts))
      .catch(() => active && setByomDeployments([]));
    return () => {
      active = false;
    };
  }, [cfgVoiceByom, cfgVoiceProfile]);

  // Re-measure the region's native list. The cached answer is ~6h old at worst; this forces a fresh
  // sweep (measured ~10s for 23 candidates) for when a model has just rolled out to the region.
  const reprobeVoiceModels = () =>
    guard(async () => {
      setCfgStatus(null);
      setProbing(true);
      try {
        const voiceModels = await admin.listVoiceLiveModels(true);
        setVoiceModelOptions(voiceModels);
        setCfgStatus(`Re-probed: ${voiceModels.length} native voice model(s) accepted here.`);
      } finally {
        setProbing(false);
      }
    });

  // ONE payload builder for both save buttons (Save and Clear key). They used to spell the body out
  // twice, which is how a newly added field gets silently reset by the path that forgot it.
  const foundryPayload = (extra: Partial<admin.AiFoundryConfigInput> = {}) => ({
    endpoint: cfgEndpoint.trim(),
    api_key: cfgKey,
    default_project: cfgProject.trim(),
    model_or_deployment: cfgModel.trim(),
    voice_model: cfgVoiceModel.trim(),
    voice_model_mode: cfgVoiceByom ? "byom" : "native",
    voice_byom_profile: cfgVoiceByom ? cfgVoiceProfile : "",
    knowledge_base: cfgKb.trim(),
    knowledge_source: cfgKs.trim(),
    ...extra,
  });

  return {
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
  };
}

export type ConnectionTabState = ReturnType<typeof useConnectionTab>;
