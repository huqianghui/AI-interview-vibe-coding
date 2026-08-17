/** ModelSelect (Phase 3): per-persona model dropdown — discovery, selection, persistence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { ModelSelect } from "./ModelSelect";
import * as admin from "../../api/admin";

function renderModelSelect(props: { value: string; onChange: (m: string) => void }) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ModelSelect {...props} />
    </FluentProvider>,
  );
}

function mockDiscovery(configured = "gpt-5.4-mini") {
  vi.spyOn(admin, "listModelDeployments").mockResolvedValue([
    { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
    { value: "gpt-5", label: "gpt-5" },
  ]);
  vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
    endpoint: "https://demo.services.ai.azure.com",
    masked_key: "",
    default_project: "demo-prj",
    model_or_deployment: configured,
    knowledge_base: "",
    knowledge_source: "",
    is_active: true,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ModelSelect", () => {
  it("shows the global configured model when the persona has none", async () => {
    mockDiscovery("gpt-5.4-mini");
    renderModelSelect({ value: "", onChange: vi.fn() });
    const dd = await screen.findByTestId("model-dropdown");
    await waitFor(() => expect(dd).toHaveValue("gpt-5.4-mini"));
    // Caption explains it's falling back to the global default.
    expect(screen.getByText(/global default/i)).toBeInTheDocument();
  });

  it("prefers the persona's own model over the global default", async () => {
    mockDiscovery("gpt-5.4-mini");
    renderModelSelect({ value: "gpt-5", onChange: vi.fn() });
    const dd = await screen.findByTestId("model-dropdown");
    await waitFor(() => expect(dd).toHaveValue("gpt-5"));
    expect(screen.getByText(/saved on the persona/i)).toBeInTheDocument();
  });

  it("emits the chosen model through onChange", async () => {
    const user = userEvent.setup();
    mockDiscovery("gpt-5.4-mini");
    const onChange = vi.fn();
    renderModelSelect({ value: "", onChange });
    await screen.findByTestId("model-dropdown");
    await user.click(screen.getByTestId("model-dropdown"));
    await user.click(await screen.findByRole("option", { name: "gpt-5" }));
    expect(onChange).toHaveBeenCalledWith("gpt-5");
  });

  it("keeps a persona model visible even if it isn't in the discovered list", async () => {
    mockDiscovery("gpt-5.4-mini");
    renderModelSelect({ value: "gpt-legacy-model", onChange: vi.fn() });
    const dd = await screen.findByTestId("model-dropdown");
    await waitFor(() => expect(dd).toHaveValue("gpt-legacy-model"));
  });
});
