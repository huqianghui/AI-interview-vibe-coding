/** AdminPage (Phase 1 + F2b/F3b): login gate, then bank list + config. Admin/auth API mocked. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { AdminPage } from "./AdminPage";
import * as admin from "../api/admin";
import * as auth from "../api/auth";

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AdminPage />
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

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/管理员/));
    expect(screen.getByTestId("admin-username-input")).toBeInTheDocument();
    expect(auth.getToken()).toBe(""); // token cleared on role rejection
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
});
