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
    auth.setToken("jwt-token");
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
    expect(auth.getToken()).toBe("jwt-token");
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
      auth.setToken("jwt-token");
      return "jwt-token";
    });
    vi.spyOn(auth, "me").mockResolvedValue({ ...ADMIN_USER, role: "user" });

    renderPage();
    await signIn(user);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Administrator/));
    expect(screen.getByTestId("admin-username-input")).toBeInTheDocument();
    expect(auth.getToken()).toBe(""); // token cleared on role rejection
  });

  it("falls back to the login gate when a residual token is invalid (no 401 storm)", async () => {
    // Regression: a leftover token in sessionStorage used to flip the page straight to authed, which
    // then fired protected requests with a dead bearer → a wall of 401s. Now we validate via me()
    // first, and an invalid token drops us to the login form without ever calling the admin API.
    sessionStorage.setItem("admin_api_token", "stale-token");
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
    await waitFor(() =>
      expect(screen.getByTestId("cfg-status")).toHaveTextContent(/1 model.*1 knowledge base/i),
    );
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
});
