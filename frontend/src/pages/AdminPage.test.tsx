/** AdminPage (Phase 1 + F2b/F3b): login gate, then bank list + config. Admin/auth API mocked. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../i18n"; // AdminPage uses useTranslation — ensure the i18n singleton is initialized (en-US default)
import { AdminPage } from "./AdminPage";
import * as admin from "../api/admin";
import * as auth from "../api/auth";
import * as personas from "../api/personas";

// AdminPage now uses react-router `Link` (top-bar nav to /admin/agent), so it must render inside a
// router. A stub route for /admin/agent lets the nav test assert navigation lands there.
function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/agent" element={<div>Agent editor page</div>} />
        </Routes>
      </MemoryRouter>
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

/** Mock a successful admin login (login stores a token; me() returns an admin). */
function mockAdminLogin() {
  vi.spyOn(auth, "login").mockImplementation(async () => {
    auth.setAdminToken("jwt-token");
    return "jwt-token";
  });
  vi.spyOn(auth, "me").mockResolvedValue(ADMIN_USER);
}

/** Fill username/password and click 登录. */
async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("admin-username-input"), "admin");
  await user.type(screen.getByTestId("admin-password-input"), "pw");
  await user.click(screen.getByTestId("admin-login"));
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const EMPTY_CFG = {
  endpoint: "",
  masked_key: "",
  default_project: "",
  model_or_deployment: "",
  knowledge_base: "",
  knowledge_source: "",
  is_active: false,
};

describe("AdminPage", () => {
  it("gates on login, then lists banks after admin sign-in", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    const listBanks = vi.spyOn(admin, "listBanks").mockResolvedValue([
      {
        bank_id: "b1",
        name: "Demo Bank",
        description: "",
        language: "zh-CN",
        enabled: true,
        is_default: true,
      },
    ]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue(EMPTY_CFG);

    renderPage();
    // Login gate is shown first.
    expect(screen.getByTestId("admin-username-input")).toBeInTheDocument();

    await signIn(user);

    // After sign-in the bank list renders.
    await waitFor(() => expect(screen.getByText("Demo Bank")).toBeInTheDocument());
    expect(listBanks).toHaveBeenCalled();
    expect(auth.getAdminToken()).toBe("jwt-token");
  });

  it("shows an error when login credentials are rejected", async () => {
    const user = userEvent.setup();
    vi.spyOn(auth, "login").mockRejectedValue(new auth.AuthError("用户名或密码错误", 401));

    renderPage();
    await user.type(screen.getByTestId("admin-username-input"), "admin");
    await user.type(screen.getByTestId("admin-password-input"), "wrong");
    await user.click(screen.getByTestId("admin-login"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/密码错误/));
    // Still on the gate (not authed).
    expect(screen.getByTestId("admin-username-input")).toBeInTheDocument();
  });

  it("rejects a non-admin user (role gate on the client)", async () => {
    const user = userEvent.setup();
    vi.spyOn(auth, "login").mockImplementation(async () => {
      auth.setAdminToken("jwt-token");
      return "jwt-token";
    });
    vi.spyOn(auth, "me").mockResolvedValue({ ...ADMIN_USER, role: "user" });

    renderPage();
    await signIn(user);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Administrator/));
    expect(screen.getByTestId("admin-username-input")).toBeInTheDocument();
    expect(auth.getAdminToken()).toBe(""); // token cleared on role rejection
  });

  it("falls back to the login gate when a residual token is invalid (no 401 storm)", async () => {
    // Regression: a leftover token in sessionStorage used to flip the page straight to authed, which
    // then fired protected requests with a dead bearer → a wall of 401s. Now we validate via me()
    // first, and an invalid token drops us to the login form without ever calling the admin API.
    sessionStorage.setItem(auth.ADMIN_TOKEN_KEY, "stale-token");
    vi.spyOn(auth, "me").mockResolvedValue(null); // me() clears the token and returns null on 401
    const listBanks = vi.spyOn(admin, "listBanks").mockResolvedValue([]);

    renderPage();

    await waitFor(() => expect(screen.getByTestId("admin-username-input")).toBeInTheDocument());
    expect(listBanks).not.toHaveBeenCalled();
  });

  it("loads the AI Foundry config (masked key) and saves an update", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      endpoint: "https://demo.services.ai.azure.com",
      masked_key: "****1234",
      default_project: "demo-prj",
      model_or_deployment: "gpt-4o-mini",
      knowledge_base: "",
      knowledge_source: "",
      is_active: true,
    });
    const update = vi
      .spyOn(admin, "updateAiFoundryConfig")
      .mockResolvedValue({ ...EMPTY_CFG, endpoint: "https://demo.services.ai.azure.com" });

    renderPage();
    await signIn(user);

    // Connection config lives under the "Azure 连接" tab now — switch to it first.
    await user.click(await screen.findByTestId("admin-tab-connection"));

    // The saved endpoint loads into the panel and the key shows masked (never the raw secret).
    await waitFor(() =>
      expect(screen.getByTestId("cfg-endpoint")).toHaveValue("https://demo.services.ai.azure.com"),
    );
    expect(screen.getByTestId("cfg-key")).toHaveValue(""); // key never prefilled
    expect(screen.getByTestId("cfg-key")).toHaveAttribute("placeholder", expect.stringContaining("****1234"));

    // Change the model and save → the client is called with the new value + empty key (preserve).
    await user.clear(screen.getByTestId("cfg-model"));
    await user.type(screen.getByTestId("cfg-model"), "gpt-5.4-mini");
    await user.click(screen.getByTestId("cfg-save"));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ model_or_deployment: "gpt-5.4-mini", api_key: "" }),
    );
    await waitFor(() => expect(screen.getByTestId("cfg-status")).toHaveTextContent(/saved/i));
  });

  it("shows the effective auth mode and clears the saved key on demand", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    const savedCfg = {
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      masked_key: "****1234",
      is_active: true,
    };
    // First load: key saved; after the clear, the refresh returns a keyless config.
    const getCfg = vi
      .spyOn(admin, "getAiFoundryConfig")
      .mockResolvedValueOnce(savedCfg)
      .mockResolvedValue({ ...savedCfg, masked_key: "" });
    const update = vi.spyOn(admin, "updateAiFoundryConfig").mockResolvedValue(savedCfg);

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));

    // With a saved key, the auth-mode line names it as the fallback and offers the clear action.
    await waitFor(() =>
      expect(screen.getByTestId("cfg-auth-mode")).toHaveTextContent(/API key saved \(\*\*\*\*1234\)/),
    );
    await user.click(screen.getByTestId("cfg-clear-key"));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ clear_api_key: true, api_key: "" }),
    );
    expect(getCfg.mock.calls.length).toBeGreaterThan(1); // refreshed after the clear
    // Keyless state: the auth-mode line flips to Entra ID / Managed Identity, no clear button.
    await waitFor(() =>
      expect(screen.getByTestId("cfg-auth-mode")).toHaveTextContent(/Entra ID \/ Managed Identity/),
    );
    expect(screen.queryByTestId("cfg-clear-key")).not.toBeInTheDocument();
    expect(screen.getByTestId("cfg-status")).toHaveTextContent(/cleared/i);
  });

  it("edits a question's max follow-ups inline (issue #114), committing on Enter", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue(EMPTY_CFG);
    vi.spyOn(admin, "listBanks").mockResolvedValue([
      {
        bank_id: "b1",
        name: "Demo Bank",
        description: "",
        language: "zh-CN",
        enabled: true,
        is_default: true,
      },
    ]);
    vi.spyOn(admin, "listBankQuestions").mockResolvedValue([
      {
        question_id: "q1",
        text: "How are you?",
        language: "zh-CN",
        order_index: 0,
        enabled: true,
        expected_points: [],
        max_follow_ups: 0,
        checklist_item_count: 2,
      },
    ]);
    const edit = vi.spyOn(admin, "editQuestion").mockResolvedValue({
      question_id: "q1",
      text: "How are you?",
      language: "zh-CN",
      order_index: 0,
      enabled: true,
      expected_points: [],
      max_follow_ups: 2,
      checklist_item_count: 2,
    });
    renderPage();
    await signIn(user);
    await user.click(await screen.findByText("Demo Bank"));
    const input = await screen.findByTestId("max-follow-ups-q1");
    expect(input).toHaveValue(0);
    await user.clear(input);
    await user.type(input, "7{Enter}"); // clamped to the 0–3 range
    await waitFor(() => expect(edit).toHaveBeenCalledWith("q1", { max_follow_ups: 3 }));
  });

  it("edits and saves a question's checklist (rubric), round-tripping the normalized result", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue(EMPTY_CFG);
    vi.spyOn(admin, "listBanks").mockResolvedValue([
      {
        bank_id: "b1",
        name: "Demo Bank",
        description: "",
        language: "zh-CN",
        enabled: true,
        is_default: true,
      },
    ]);
    vi.spyOn(admin, "listBankQuestions").mockResolvedValue([
      {
        question_id: "q1",
        text: "How are you?",
        language: "zh-CN",
        order_index: 0,
        enabled: true,
        expected_points: [],
        max_follow_ups: 0,
        checklist_item_count: 2,
      },
    ]);
    vi.spyOn(admin, "getChecklist").mockResolvedValue({
      checklist_id: "c1",
      question_id: "q1",
      prompt_version: "v1",
      weights_sum: 100,
      items: [
        { kind: "required", text: "on topic", weight: 60, source_quote: "", source_page: null, order_index: 0 },
        { kind: "recommended", text: "specific", weight: 40, source_quote: "", source_page: null, order_index: 1 },
      ],
    });
    const editItems = vi.spyOn(admin, "editChecklistItems").mockResolvedValue({
      checklist_id: "c1",
      question_id: "q1",
      prompt_version: "v1",
      weights_sum: 100,
      items: [
        { kind: "required", text: "on topic and complete", weight: 100, source_quote: "", source_page: null, order_index: 0 },
      ],
    });

    renderPage();
    await signIn(user);

    // Open the bank → its questions, with the rubric-status marker showing the item count.
    await user.click(await screen.findByText("Demo Bank"));
    await waitFor(() => expect(screen.getByTestId("rubric-status-q1")).toHaveTextContent(/2/));

    // Open the rubric editor for the question.
    await user.click(screen.getByTestId("rubric-btn-q1"));
    await waitFor(() => expect(screen.getByTestId("checklist-text-0")).toHaveValue("on topic"));

    // Edit the first item's text and save → editChecklistItems is called with the working set.
    await user.clear(screen.getByTestId("checklist-text-0"));
    await user.type(screen.getByTestId("checklist-text-0"), "on topic and complete");
    await user.click(screen.getByTestId("checklist-save"));

    await waitFor(() => expect(editItems).toHaveBeenCalled());
    expect(editItems).toHaveBeenCalledWith(
      "c1",
      expect.arrayContaining([
        expect.objectContaining({ kind: "required", text: "on topic and complete" }),
      ]),
    );
    // The normalized server response is adopted (1 item, w=100).
    await waitFor(() => expect(screen.getByTestId("checklist-text-0")).toHaveValue("on topic and complete"));
    expect(screen.queryByTestId("checklist-text-1")).not.toBeInTheDocument();
  });

  it("loads model + knowledge-base options from the Foundry API into dropdowns", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      is_active: true,
    });
    const listModels = vi
      .spyOn(admin, "listModelDeployments")
      .mockResolvedValue([{ value: "gpt-5.4-mini", label: "gpt-5.4-mini (gpt-5.4-mini)" }]);
    const listKbs = vi
      .spyOn(admin, "listKnowledgeBases")
      .mockResolvedValue([{ value: "sop-kb", label: "SOP KB" }]);
    const listVoice = vi
      .spyOn(admin, "listVoiceLiveModels")
      .mockResolvedValue([{ value: "gpt-5-mini", label: "gpt-5-mini" }]);

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));

    // Before loading: text-input fallbacks are shown, not dropdowns.
    await waitFor(() => expect(screen.getByTestId("cfg-model")).toBeInTheDocument());
    expect(screen.queryByTestId("cfg-model-dropdown")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("cfg-load-options"));

    // After loading: the API was called and dropdowns replace the text inputs.
    await waitFor(() => expect(screen.getByTestId("cfg-model-dropdown")).toBeInTheDocument());
    expect(screen.getByTestId("cfg-kb-dropdown")).toBeInTheDocument();
    expect(listModels).toHaveBeenCalled();
    expect(listKbs).toHaveBeenCalled();
    // The native voice list is a THIRD source: the deployments API cannot answer "what does Voice
    // Live accept in this region", so both are fetched and they feed different dropdowns.
    expect(listVoice).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("cfg-status")).toHaveTextContent(
        /1 deployment.*1 native voice model.*1 knowledge base/i,
      ),
    );
  });

  // --- The voice session model is a SEPARATE setting from the inference model -------------------
  // One field used to feed both and their legal values differ: judge / scoring / the Foundry agent
  // address models by DEPLOYMENT NAME, while Voice Live MODEL mode accepts only models it hosts
  // natively in the region. Saving an own deployment broke every voice session with
  // "Model X is not supported in this region".

  /** Sign in, open the connection tab, and load all three option sources. */
  async function openConnectionWithOptions(
    user: ReturnType<typeof userEvent.setup>,
    cfg: Partial<admin.AiFoundryConfig> = {},
  ) {
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      model_or_deployment: "my-own-deployment",
      is_active: true,
      ...cfg,
    } as admin.AiFoundryConfig);
    vi.spyOn(admin, "listModelDeployments").mockResolvedValue([
      { value: "my-own-deployment", label: "my-own-deployment (gpt-5.4-mini)" },
    ]);
    vi.spyOn(admin, "listKnowledgeBases").mockResolvedValue([]);
    vi.spyOn(admin, "listVoiceLiveModels").mockResolvedValue([
      { value: "gpt-5-mini", label: "gpt-5-mini" },
    ]);
    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));
    await waitFor(() => expect(screen.getByTestId("cfg-load-options")).toBeInTheDocument());
    await user.click(screen.getByTestId("cfg-load-options"));
    await waitFor(() => expect(screen.getByTestId("cfg-model-dropdown")).toBeInTheDocument());
  }

  it("offers the region's probed native models for the voice session, not the deployments", async () => {
    const user = userEvent.setup();
    await openConnectionWithOptions(user);

    // Native mode (default): the voice dropdown lists what a real connection ACCEPTED here, which
    // is a different set from the resource's deployments.
    expect(screen.getByTestId("cfg-voice-native-hint")).toHaveTextContent(
      /two separate settings and both need a value/i,
    );
    await user.click(screen.getByTestId("cfg-voice-model-dropdown"));
    expect(await screen.findByRole("option", { name: "gpt-5-mini" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /my-own-deployment/ })).not.toBeInTheDocument();
  });

  it("switches the voice dropdown to your deployments and defaults it to the inference model on BYOM", async () => {
    const user = userEvent.setup();
    await openConnectionWithOptions(user);

    // No profile picker while the platform hosts the session — a profile there is a different
    // connection path entirely.
    expect(screen.queryByTestId("cfg-byom-profile")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("cfg-voice-byom"));

    // BYOM needs the protocol stated: it is not inferable from the deployment name.
    expect(await screen.findByTestId("cfg-byom-profile")).toBeInTheDocument();
    // And the voice model defaults to the inference model, because BYOM takes the same kind of name.
    expect(screen.getByTestId("cfg-voice-model-dropdown")).toHaveValue("my-own-deployment");
    await user.click(screen.getByTestId("cfg-voice-model-dropdown"));
    expect(await screen.findByRole("option", { name: /my-own-deployment/ })).toBeInTheDocument();
  });

  it("sends the voice settings on BOTH save paths, including clear-key", async () => {
    const user = userEvent.setup();
    await openConnectionWithOptions(user, { masked_key: "****1234", voice_model: "gpt-5-mini" });
    const update = vi
      .spyOn(admin, "updateAiFoundryConfig")
      .mockResolvedValue({ ...EMPTY_CFG, voice_model_check: "verified" } as admin.AiFoundryConfig);

    await user.click(screen.getByTestId("cfg-save"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        model_or_deployment: "my-own-deployment",
        voice_model: "gpt-5-mini",
        voice_model_mode: "native",
        voice_byom_profile: "",
      }),
    );

    // Clearing the key is a full save too. It spelled the payload out separately before, which is
    // exactly how a newly added field gets silently reset by the path that forgot it.
    update.mockClear();
    await user.click(screen.getByTestId("cfg-clear-key"));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        clear_api_key: true,
        voice_model: "gpt-5-mini",
        voice_model_mode: "native",
      }),
    );
  });

  it("surfaces the live check result after saving, and flags a stored value the region rejects", async () => {
    const user = userEvent.setup();
    // A migrated install can carry a voice model that is not in this region's accepted list; it
    // stays visible (not silently swapped) but must be called out.
    await openConnectionWithOptions(user, { voice_model: "gpt-5.4-mini" });
    expect(screen.getByTestId("cfg-voice-model-illegal")).toHaveTextContent(
      /not supported in this region/i,
    );

    vi.spyOn(admin, "updateAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      voice_model_check: "Voice model gpt-5-mini verified against the live service.",
    } as admin.AiFoundryConfig);
    await user.click(screen.getByTestId("cfg-save"));
    await waitFor(() =>
      expect(screen.getByTestId("cfg-status")).toHaveTextContent(
        /verified against the live service/i,
      ),
    );
  });

  it("re-probes the region on demand", async () => {
    const user = userEvent.setup();
    await openConnectionWithOptions(user);
    const reprobe = vi
      .spyOn(admin, "listVoiceLiveModels")
      .mockResolvedValue([{ value: "gpt-5-mini", label: "gpt-5-mini" }]);

    await user.click(screen.getByTestId("cfg-voice-reprobe"));
    // refresh=true: the cached answer can be up to 6h old, so a just-rolled-out model needs a sweep.
    await waitFor(() => expect(reprobe).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByTestId("cfg-status")).toHaveTextContent(/re-probed/i));
  });

  // --- The inference model is the agent's FALLBACK, not its source ---------------------------
  // judge and scoring always read the admin value; the Foundry agent reads persona.model first and
  // only falls back to it (azure_agent_sync: `persona.model or global`), and reconcile backfills the
  // live agent's model onto the persona — so a synced persona usually overrides it. The page says so
  // and names the overriding personas instead of silently rewriting them.

  function personaRow(name: string, model: string | null) {
    return {
      id: name,
      name,
      model,
      enabled: true,
      is_default: false,
      agent_id: "a:1",
      agent_version: "1",
      agent_sync_status: "synced",
    } as unknown as Awaited<ReturnType<typeof personas.listPersonas>>[number];
  }

  it("names the personas whose own model ignores the inference setting", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      model_or_deployment: "gpt-5-mini",
      is_active: true,
    });
    vi.spyOn(personas, "listPersonas").mockResolvedValue([
      personaRow("Interviewer", "gpt-5-mini"),
      personaRow("Repro Photo Avatar", ""),
      personaRow("Legacy", null),
    ]);

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));

    const notice = await screen.findByTestId("cfg-model-overrides");
    // Only the persona with a non-empty model is listed; "" and null mean "follow the global".
    expect(notice).toHaveTextContent(/1 persona\(s\) carry their own model/i);
    expect(notice).toHaveTextContent("Interviewer (gpt-5-mini)");
    expect(notice).not.toHaveTextContent("Repro Photo Avatar");
    expect(notice).not.toHaveTextContent("Legacy");
  });

  it("says so plainly when no persona overrides the inference model", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      is_active: true,
    });
    vi.spyOn(personas, "listPersonas").mockResolvedValue([personaRow("Fresh", "")]);

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));

    expect(await screen.findByTestId("cfg-model-overrides-none")).toBeInTheDocument();
    expect(screen.queryByTestId("cfg-model-overrides")).not.toBeInTheDocument();
  });

  it("keeps the config panel usable when the persona list cannot be read", async () => {
    // The notice is informational; a failing persona list must not take the connection panel down.
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      is_active: true,
    });
    vi.spyOn(personas, "listPersonas").mockRejectedValue(new Error("boom"));

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));

    await waitFor(() =>
      expect(screen.getByTestId("cfg-endpoint")).toHaveValue("https://demo.services.ai.azure.com"),
    );
    expect(screen.getByTestId("cfg-model-overrides-none")).toBeInTheDocument();
  });

  // --- The BYOM deployment list must follow the chosen profile -----------------------------------
  // The bug this guards: the BYOM voice dropdown reused the chat-only deployment list, and a
  // realtime deployment is NOT chat-capable (measured: capabilities {chat_completion:"false",
  // completion:"false"}), so byom-azure-openai-realtime had nothing selectable — unreachable from the
  // UI even though both gpt-realtime-1.5 and gpt-realtime-2.1 are live-verified under that profile.

  it("asks for realtime deployments when the realtime profile is chosen", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      model_or_deployment: "gpt-5-mini",
      is_active: true,
    });
    vi.spyOn(personas, "listPersonas").mockResolvedValue([]);
    vi.spyOn(admin, "listKnowledgeBases").mockResolvedValue([]);
    vi.spyOn(admin, "listVoiceLiveModels").mockResolvedValue([]);
    const listDeployments = vi
      .spyOn(admin, "listModelDeployments")
      .mockImplementation(async (kind = "chat") =>
        kind === "realtime"
          ? [{ value: "gpt-realtime-2.1", label: "gpt-realtime-2.1 (gpt-realtime-2.1)" }]
          : [{ value: "gpt-5-mini", label: "gpt-5-mini (gpt-5-mini)" }],
      );

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));
    await user.click(await screen.findByTestId("cfg-voice-byom"));

    // Default profile is chat-completion -> the chat list.
    await waitFor(() => expect(listDeployments).toHaveBeenCalledWith("chat"));
    await user.click(screen.getByTestId("cfg-voice-model-dropdown"));
    expect(await screen.findByRole("option", { name: /gpt-5-mini/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Switch to the realtime profile -> the realtime list, which the chat-only list could not show.
    await user.click(screen.getByTestId("cfg-byom-profile"));
    await user.click(await screen.findByRole("option", { name: /Realtime/i }));
    await waitFor(() => expect(listDeployments).toHaveBeenCalledWith("realtime"));
    await user.click(screen.getByTestId("cfg-voice-model-dropdown"));
    expect(await screen.findByRole("option", { name: /gpt-realtime-2\.1/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("cfg-byom-kind")).toHaveTextContent(/realtime deployments/i);
    // The operator is warned BEFORE saving: the save is refused, because this product's session
    // needs text EOU + azure-speech transcription, which passthrough cannot run (measured live).
    expect(screen.getByTestId("cfg-byom-realtime-warning")).toHaveTextContent(
      /text end-of-utterance detection turned off/i,
    );
  });

  it("lists every deployment for the Anthropic profile, since no filter can be verified", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
      ...EMPTY_CFG,
      endpoint: "https://demo.services.ai.azure.com",
      is_active: true,
    });
    vi.spyOn(personas, "listPersonas").mockResolvedValue([]);
    vi.spyOn(admin, "listKnowledgeBases").mockResolvedValue([]);
    vi.spyOn(admin, "listVoiceLiveModels").mockResolvedValue([]);
    const listDeployments = vi.spyOn(admin, "listModelDeployments").mockResolvedValue([]);

    renderPage();
    await signIn(user);
    await user.click(await screen.findByTestId("admin-tab-connection"));
    await user.click(await screen.findByTestId("cfg-voice-byom"));
    await user.click(await screen.findByTestId("cfg-byom-profile"));
    await user.click(await screen.findByRole("option", { name: /Anthropic/i }));

    await waitFor(() => expect(listDeployments).toHaveBeenCalledWith("all"));
    expect(screen.getByTestId("cfg-byom-kind")).toHaveTextContent(/no filter can be verified/i);
  });

  it("links from the top bar to the digital-human agent editor", async () => {
    const user = userEvent.setup();
    mockAdminLogin();
    vi.spyOn(admin, "listBanks").mockResolvedValue([]);
    vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue(EMPTY_CFG);

    renderPage();
    await signIn(user);

    // The top-bar nav link routes to /admin/agent (our stub route renders a marker).
    await user.click(await screen.findByTestId("admin-nav-agent"));
    await waitFor(() => expect(screen.getByText("Agent editor page")).toBeInTheDocument());
  });

  // #102 (eng-review-reduced scope): a read-only Users tab so an admin can hand out the seeded
  // shared-account credentials — no create/reset-password affordances yet.
  describe("Users tab (#102)", () => {
    async function openUsersTab(user: ReturnType<typeof userEvent.setup>) {
      mockAdminLogin();
      vi.spyOn(admin, "listBanks").mockResolvedValue([]);
      vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue(EMPTY_CFG);
      renderPage();
      await signIn(user);
      await user.click(await screen.findByTestId("admin-tab-users"));
    }

    it("loads and renders users with a generated password, a stale password, and no password", async () => {
      const user = userEvent.setup();
      const listUsers = vi.spyOn(admin, "listUsers").mockResolvedValue([
        {
          id: "u1",
          username: "user1",
          role: "user",
          is_active: true,
          generated_password: "abc12345",
          password_stale: false,
        },
        {
          id: "u2",
          username: "user2",
          role: "user",
          is_active: false,
          generated_password: null,
          password_stale: true,
        },
        {
          id: "u3",
          username: "user3",
          role: "user",
          is_active: true,
          generated_password: null,
          password_stale: false,
        },
      ]);

      await openUsersTab(user);

      await waitFor(() => expect(listUsers).toHaveBeenCalled());
      // Active user with a viewable generated password: shown in the clear + a Copy button.
      expect(screen.getByTestId("user-password-user1")).toHaveTextContent("abc12345");
      expect(screen.getByTestId("user-copy-user1")).toBeInTheDocument();
      // Stale password (signing key rotated): the stale message, not the password.
      expect(screen.getByTestId("user-password-stale-user2")).toBeInTheDocument();
      expect(screen.getByText(/password needs reset/i)).toBeInTheDocument();
      expect(screen.getByText(/inactive/i)).toBeInTheDocument();
      // No password on record, not stale: "not viewable".
      expect(screen.getByTestId("user-password-not-viewable-user3")).toBeInTheDocument();
    });

    it("copies the password and shows Copied after the click", async () => {
      const user = userEvent.setup();
      vi.spyOn(admin, "listUsers").mockResolvedValue([
        {
          id: "u1",
          username: "user1",
          role: "user",
          is_active: true,
          generated_password: "abc12345",
          password_stale: false,
        },
      ]);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      await openUsersTab(user);
      await screen.findByTestId("user-copy-user1");
      await user.click(screen.getByTestId("user-copy-user1"));

      expect(writeText).toHaveBeenCalledWith("abc12345");
      await waitFor(() => expect(screen.getByTestId("user-copy-user1")).toHaveTextContent(/copied/i));
    });

    it("shows a loading state while the request is in flight", async () => {
      const user = userEvent.setup();
      let resolveUsers: (value: admin.AdminUser[]) => void = () => {};
      vi.spyOn(admin, "listUsers").mockImplementation(
        () => new Promise((resolve) => (resolveUsers = resolve)),
      );

      await openUsersTab(user);

      expect(screen.getByTestId("users-loading")).toBeInTheDocument();
      resolveUsers([]);
      await waitFor(() => expect(screen.queryByTestId("users-loading")).not.toBeInTheDocument());
    });

    it("shows an error state when the request fails", async () => {
      const user = userEvent.setup();
      vi.spyOn(admin, "listUsers").mockRejectedValue(new admin.AdminApiError(500, "Internal Server Error", "boom", "boom"));

      await openUsersTab(user);

      await waitFor(() => expect(screen.getByTestId("users-error")).toHaveTextContent(/500 Internal Server Error: boom/));
      expect(screen.queryByTestId("users-table")).not.toBeInTheDocument();
    });
  });
});
