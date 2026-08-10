/** AdminPage (SPEC F2b/F3b): token gate, then bank list + create. Admin API mocked. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { AdminPage } from "./AdminPage";
import * as admin from "../api/admin";

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <AdminPage />
    </FluentProvider>,
  );
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
  it("gates on the admin token, then lists banks after sign-in", async () => {
    const user = userEvent.setup();
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
    // Token gate is shown first.
    expect(screen.getByTestId("admin-token-input")).toBeInTheDocument();

    await user.type(screen.getByTestId("admin-token-input"), "secret-token");
    await user.click(screen.getByTestId("admin-login"));

    // After sign-in the bank list renders.
    await waitFor(() => expect(screen.getByText("Demo Bank")).toBeInTheDocument());
    expect(listBanks).toHaveBeenCalled();
    // Token was persisted for subsequent admin calls.
    expect(admin.getAdminToken()).toBe("secret-token");
  });

  it("shows an error when the token is rejected", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listBanks").mockRejectedValue(new admin.AdminApiError("401 Unauthorized", 401));

    renderPage();
    await user.type(screen.getByTestId("admin-token-input"), "wrong");
    await user.click(screen.getByTestId("admin-login"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/401/));
    // Still on the gate (not authed).
    expect(screen.getByTestId("admin-token-input")).toBeInTheDocument();
  });

  it("loads the AI Foundry config (masked key) and saves an update", async () => {
    const user = userEvent.setup();
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
    await user.type(screen.getByTestId("admin-token-input"), "secret-token");
    await user.click(screen.getByTestId("admin-login"));

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
    await user.type(screen.getByTestId("admin-token-input"), "secret-token");
    await user.click(screen.getByTestId("admin-login"));

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
