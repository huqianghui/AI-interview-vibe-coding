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
});
