/** AgentEditorPage (Phase 3): login gate → persona list → edit; regions, dropdowns, save, avatar. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n"; // AgentEditorPage uses useTranslation — ensure the i18n singleton is initialized
import { AgentEditorPage } from "./AgentEditorPage";
import * as personas from "../api/personas";
import * as admin from "../api/admin";
import * as auth from "../api/auth";
import * as personaKnowledge from "../api/personaKnowledge";

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AgentEditorPage />
    </FluentProvider>,
  );
}

const ADMIN_USER = {
  id: "u1",
  username: "admin",
  email: "admin@local",
  full_name: "Admin",
  role: "admin",
  is_active: true,
  preferred_language: "zh-CN",
};

const PERSONA: personas.PersonaOut = {
  id: "p1",
  name: "Demo Interviewer",
  character: "lisa",
  style: "casual",
  prompt_fragment: "You are an interviewer.",
  voice_map: '{"zh-CN":"zh-CN-XiaoxiaoNeural"}',
  greeting_map: '{"zh-CN":"你好"}',
  default_locale: "zh-CN",
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
  agent_id: "interviewer-p1",
  agent_version: "3",
  agent_sync_status: "synced",
  agent_sync_error: null,
  default_instructions: "You are Demo Interviewer, an interviewer.",
};

function mockAdminLogin() {
  vi.spyOn(auth, "login").mockImplementation(async () => {
    auth.setToken("jwt-token");
    return "jwt-token";
  });
  vi.spyOn(auth, "me").mockResolvedValue(ADMIN_USER);
}

/** Stub the discovery endpoints the definition panel loads (model + KB config). */
function mockDiscovery() {
  vi.spyOn(admin, "listModelDeployments").mockResolvedValue([
    { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  ]);
  vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
    endpoint: "https://demo.services.ai.azure.com",
    masked_key: "",
    default_project: "demo-prj",
    model_or_deployment: "gpt-5.4-mini",
    knowledge_base: "sop-kb",
    knowledge_source: "sop-ks",
    is_active: true,
  });
  // Reconcile fires in the background on persona open. Default it to the fail-soft path (unavailable
  // Foundry) so it leaves the getPersona result in place; tests that exercise a pull override this.
  vi.spyOn(personas, "reconcilePersona").mockRejectedValue(new Error("offline"));
}

/** Stub the per-persona knowledge endpoints the Knowledge section loads on select. */
function mockKnowledge(configs: personaKnowledge.PersonaKnowledgeConfig[] = []) {
  vi.spyOn(personaKnowledge, "listPersonaKnowledge").mockResolvedValue(configs);
  vi.spyOn(personaKnowledge, "listKbConnections").mockResolvedValue([]);
  vi.spyOn(personaKnowledge, "listKnowledgeBases").mockResolvedValue([]);
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("agent-username-input"), "admin");
  await user.type(screen.getByTestId("agent-password-input"), "pw");
  await user.click(screen.getByTestId("agent-login"));
}

/** Persona selection is a top-bar dropdown: open it, then click the persona's option. */
async function pickPersona(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(await screen.findByTestId("persona-select"));
  await user.click(await screen.findByTestId(`persona-item-${id}`));
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("AgentEditorPage", () => {
  it("gates on login, then lists personas after admin sign-in", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    const listSpy = vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);

    renderPage();
    expect(screen.getByTestId("agent-username-input")).toBeInTheDocument();
    await signIn(user);

    // The persona list loaded into the top-bar switcher.
    await waitFor(() => expect(screen.getByTestId("persona-select")).toBeInTheDocument());
    expect(listSpy).toHaveBeenCalled();
    // The enabled default is auto-selected on entry (no manual pick needed).
    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"));
  });

  it("auto-selects the enabled default persona on entry", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    // Two personas; only the second is the enabled default → it must be the one auto-selected.
    const notDefault = { ...PERSONA, id: "p0", name: "Other", is_default: false };
    const theDefault = { ...PERSONA, id: "p1", name: "The Default", is_default: true };
    vi.spyOn(personas, "listPersonas").mockResolvedValue([notDefault, theDefault]);
    const getPersona = vi
      .spyOn(personas, "getPersona")
      .mockImplementation(async (id) => (id === "p1" ? theDefault : notDefault));

    renderPage();
    await signIn(user);

    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("The Default"));
    expect(getPersona).toHaveBeenCalledWith("p1");
    expect(screen.queryByTestId("editor-empty")).not.toBeInTheDocument();
  });

  it("falls back to the first persona when none is the enabled default", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    const first = { ...PERSONA, id: "p0", name: "First", is_default: false };
    const second = { ...PERSONA, id: "p1", name: "Second", is_default: false };
    vi.spyOn(personas, "listPersonas").mockResolvedValue([first, second]);
    const getPersona = vi
      .spyOn(personas, "getPersona")
      .mockImplementation(async (id) => (id === "p0" ? first : second));

    renderPage();
    await signIn(user);

    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("First"));
    expect(getPersona).toHaveBeenCalledWith("p0");
  });

  it("shows the empty state when there are no personas", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([]);

    renderPage();
    await signIn(user);

    await waitFor(() => expect(screen.getByTestId("persona-select")).toBeInTheDocument());
    expect(screen.getByTestId("editor-empty")).toBeInTheDocument();
  });

  it("rejects a non-admin user", async () => {
    const user = userEvent.setup();
    vi.spyOn(auth, "login").mockImplementation(async () => {
      auth.setToken("jwt-token");
      return "jwt-token";
    });
    vi.spyOn(auth, "me").mockResolvedValue({ ...ADMIN_USER, role: "user" });

    renderPage();
    await signIn(user);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Administrator/));
    expect(auth.getToken()).toBe("");
  });

  it("falls back to the login gate when a residual token is invalid (no 401 storm)", async () => {
    // Regression: a leftover token in sessionStorage used to flip the page straight to authed, which
    // then fired listPersonas() with a dead bearer → 401s. Now we validate via me() first, and an
    // invalid token drops us to the login form without ever calling the personas API.
    sessionStorage.setItem("admin_api_token", "stale-token");
    vi.spyOn(auth, "me").mockResolvedValue(null); // me() clears the token and returns null on 401
    const listSpy = vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);

    renderPage();

    await waitFor(() => expect(screen.getByTestId("agent-username-input")).toBeInTheDocument());
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("selecting a persona renders the definition panel + config drawer regions", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");

    // Center definition panel populated from the persona.
    await waitFor(() =>
      expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"),
    );
    expect(screen.getByTestId("persona-instructions")).toHaveValue("You are an interviewer.");
    // Model dropdown populated from discovery.
    await waitFor(() => expect(screen.getByTestId("model-dropdown")).toBeInTheDocument());
    // Per-persona Knowledge section renders; this persona has no attached KB yet.
    await waitFor(() => expect(screen.getByTestId("knowledge-section")).toBeInTheDocument());
    expect(screen.getByTestId("knowledge-none")).toBeInTheDocument();
    // Agent sync status.
    expect(screen.getByTestId("agent-sync-badge")).toHaveTextContent(/synced/i);

    // The configuration rail is a permanent 3rd column (no Configure gate) — regions present.
    await waitFor(() => expect(screen.getByTestId("configuration-rail-body")).toBeInTheDocument());
    expect(screen.getByTestId("config-language")).toBeInTheDocument();
    expect(screen.getByTestId("avatar-grid")).toBeInTheDocument();
  });

  it("save calls updatePersona with edited fields (maps stringified)", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);
    const update = vi.spyOn(personas, "updatePersona").mockResolvedValue(PERSONA);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"));

    const name = screen.getByTestId("persona-name");
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByTestId("persona-save"));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const [id, payload] = update.mock.calls[0];
    expect(id).toBe("p1");
    expect(payload.name).toBe("Renamed");
    expect(typeof payload.voice_map).toBe("string"); // maps serialized back to JSON strings
    expect(JSON.parse(payload.voice_map!)["zh-CN"]).toBe("zh-CN-XiaoxiaoNeural");
  });

  it("avatar grid selection sets character/style on save", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);
    const update = vi.spyOn(personas, "updatePersona").mockResolvedValue(PERSONA);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"));

    // Avatar grid lives in the always-visible config rail (no drawer to open).
    // Harry is a video avatar → one tile per style; the first tile is his default style.
    await user.click((await screen.findAllByTestId("avatar-option-harry"))[0]);
    await user.click(screen.getByTestId("persona-save"));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const payload = update.mock.calls[0][1];
    expect(payload.character).toBe("harry");
    expect(payload.style).toBe("business"); // harry's first tile / default style
  });

  it("adding a tool via the Add menu saves it into tools_config", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);
    const update = vi.spyOn(personas, "updatePersona").mockResolvedValue(PERSONA);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"));

    // Add ▾ → Code interpreter (a supported, connection-free tool).
    await user.click(screen.getByTestId("tools-add-menu"));
    await user.click(await screen.findByTestId("tools-add-code-interpreter"));
    await user.click(screen.getByTestId("persona-save"));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const payload = update.mock.calls[0][1];
    expect(JSON.parse(payload.tools_config!)).toEqual([{ type: "code_interpreter" }]);
  });

  it("retry-sync calls retrySyncPersona", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    const failed = { ...PERSONA, agent_sync_status: "failed" as const, agent_sync_error: "boom" };
    vi.spyOn(personas, "listPersonas").mockResolvedValue([failed]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(failed);
    const retry = vi.spyOn(personas, "retrySyncPersona").mockResolvedValue(PERSONA);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() => expect(screen.getByTestId("agent-sync-error")).toHaveTextContent("boom"));

    await user.click(screen.getByTestId("agent-retry-sync"));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("p1"));
  });

  it("New persona shows an empty form and creates on save", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([]);
    const create = vi.spyOn(personas, "createPersona").mockResolvedValue(PERSONA);

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("persona-new"));

    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue(""));
    await user.type(screen.getByTestId("persona-name"), "Fresh");
    await user.click(screen.getByTestId("persona-save"));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].name).toBe("Fresh");
  });

  it("shows a persona's attached knowledge bases and removes one", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge([
      {
        id: "k1",
        persona_id: "p1",
        connection_name: "search-conn",
        connection_target: "https://s.search.windows.net",
        index_name: "sop-kb",
        server_label: "knowledge-base-sop-kb",
        is_enabled: true,
      },
    ]);
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);
    const remove = vi.spyOn(personaKnowledge, "removePersonaKnowledge").mockResolvedValue(undefined);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"));

    // The attached KB shows in the Knowledge section.
    await waitFor(() => expect(screen.getByTestId("knowledge-item-k1")).toBeInTheDocument());
    expect(screen.getByTestId("knowledge-item-k1")).toHaveTextContent("sop-kb");

    // Removing it calls the API with the config id.
    await user.click(screen.getByTestId("knowledge-remove-k1"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("k1"));
  });

  it("reconciles on open and applies a Portal-pulled model + version", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);
    // The live Foundry agent drifted: bumped to v9 running a different model. Reconcile pulls it.
    const pulled = { ...PERSONA, agent_version: "9", model: "gpt-5" };
    const reconcile = vi
      .spyOn(personas, "reconcilePersona")
      .mockResolvedValue(pulled);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"));

    await waitFor(() => expect(reconcile).toHaveBeenCalledWith("p1"));
    // The pulled version reaches the sync card…
    await waitFor(() => expect(screen.getByText(/version:\s*9/)).toBeInTheDocument());
    // …and the pulled model is now the persona's selection, so a save persists it.
    const update = vi.spyOn(personas, "updatePersona").mockResolvedValue(pulled);
    await user.click(screen.getByTestId("persona-save"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].model).toBe("gpt-5");
  });

  it("shows the auto-generated default instructions when prompt_fragment is empty (Portal parity)", async () => {
    // An empty Instructions field is what the FOUNDRY agent runs the generated default for — the
    // editor must show that default (placeholder + hint), not a silent blank, so what the operator
    // sees here matches what the Azure Portal displays.
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    const blank = { ...PERSONA, prompt_fragment: "" };
    vi.spyOn(personas, "listPersonas").mockResolvedValue([blank]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(blank);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() => expect(screen.getByTestId("persona-name")).toHaveValue("Demo Interviewer"));

    const textarea = screen.getByTestId("persona-instructions");
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute(
      "placeholder",
      "You are Demo Interviewer, an interviewer.",
    );
    expect(screen.getByTestId("persona-instructions-default-hint")).toBeInTheDocument();
  });

  it("hides the default-instructions hint once custom instructions exist", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");
    await waitFor(() =>
      expect(screen.getByTestId("persona-instructions")).toHaveValue("You are an interviewer."),
    );
    expect(screen.queryByTestId("persona-instructions-default-hint")).not.toBeInTheDocument();
  });

  it("reconcile pulls Portal-edited instructions into the field", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    mockDiscovery();
    mockKnowledge();
    vi.spyOn(personas, "listPersonas").mockResolvedValue([PERSONA]);
    vi.spyOn(personas, "getPersona").mockResolvedValue(PERSONA);
    // Portal edit changed the instructions (and bumped the version) — reconcile pulls both.
    const pulled = {
      ...PERSONA,
      agent_version: "9",
      prompt_fragment: "You are a strict interviewer. Ask follow-ups.",
    };
    vi.spyOn(personas, "reconcilePersona").mockResolvedValue(pulled);

    renderPage();
    await signIn(user);
    await pickPersona(user, "p1");

    await waitFor(() =>
      expect(screen.getByTestId("persona-instructions")).toHaveValue(
        "You are a strict interviewer. Ask follow-ups.",
      ),
    );
  });
});
