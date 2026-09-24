/**
 * Configuration rail — the per-engine voice silence auto-submit pair. Only the active engine's
 * (switch, seconds) pair renders; edits patch ONLY that engine's fields; the seconds input edits a
 * draft and commits (clamped to 1–60) on blur.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { ConfigurationRail } from "./ConfigurationRail";
import { emptyPersonaForm, type PersonaFormState } from "../../pages/agentEditorForm";

function renderRail(over: Partial<PersonaFormState> = {}) {
  const onChange = vi.fn();
  const form = { ...emptyPersonaForm(), ...over };
  render(
    <FluentProvider theme={webLightTheme}>
      <ConfigurationRail
        form={form}
        onChange={onChange}
        activeLocale={form.defaultLocale}
        onLocaleChange={() => undefined}
      />
    </FluentProvider>,
  );
  return { onChange };
}

describe("ConfigurationRail — voice silence auto-submit (one pair per engine)", () => {
  it("bank persona: shows the BANK pair, off by default, seconds input disabled", () => {
    renderRail();
    expect(screen.getByTestId("config-auto-submit-bank")).toBeInTheDocument();
    expect(screen.queryByTestId("config-auto-submit-external")).not.toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: /auto-submit answer after silence/i });
    expect(sw).not.toBeChecked();
    expect(sw).toHaveAccessibleName(/question bank/i);
    expect(screen.getByTestId("config-auto-submit-seconds")).toBeDisabled();
    expect(screen.getByText(/off for question bank/i)).toBeInTheDocument();
  });

  it("bank persona: the switch patches ONLY the bank field", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRail();
    await user.click(screen.getByRole("switch", { name: /auto-submit answer after silence/i }));
    expect(onChange).toHaveBeenCalledWith({ bank_auto_submit_enabled: true });
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ external_auto_submit_enabled: expect.anything() }),
    );
  });

  it("external persona: shows the EXTERNAL pair, on by default, and edits external fields", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRail({ interviewBrain: "external" });
    expect(screen.getByTestId("config-auto-submit-external")).toBeInTheDocument();
    expect(screen.queryByTestId("config-auto-submit-bank")).not.toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: /auto-submit answer after silence/i });
    expect(sw).toBeChecked();
    expect(sw).toHaveAccessibleName(/external interview api/i);
    const input = screen.getByTestId("config-auto-submit-seconds");
    expect(input).toBeEnabled();
    await user.click(sw);
    expect(onChange).toHaveBeenCalledWith({ external_auto_submit_enabled: false });
  });

  it("seconds input: typing edits a draft, blur commits clamped to 1–60", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRail({ interviewBrain: "external" });
    const input = screen.getByTestId("config-auto-submit-seconds");
    // Clearing the field does NOT snap to 1 mid-edit (the old per-keystroke clamp fought typing).
    await user.clear(input);
    expect(input).toHaveValue(null);
    expect(onChange).not.toHaveBeenCalled();
    await user.type(input, "100");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ external_auto_submit_silence_seconds: 60 });
  });

  it("seconds input: negative clamps to 1 on Enter, garbage/empty reverts to the saved value", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRail({ interviewBrain: "external" });
    const input = screen.getByTestId("config-auto-submit-seconds");
    await user.clear(input);
    await user.type(input, "-5{Enter}");
    expect(onChange).toHaveBeenCalledWith({ external_auto_submit_silence_seconds: 1 });
    onChange.mockClear();
    // Empty → revert to the saved value (3), no patch.
    await user.clear(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(3);
  });

  it("seconds input: unchanged value on blur emits no patch", () => {
    const { onChange } = renderRail({
      interviewBrain: "bank",
      bank_auto_submit_enabled: true,
      bank_auto_submit_silence_seconds: 12,
    });
    const input = screen.getByTestId("config-auto-submit-seconds");
    expect(input).toHaveValue(12);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ConfigurationRail — bank turn mode (linear vs the model's own turn)", () => {
  it("bank persona: shows the turn-mode control with linear selected by default", () => {
    renderRail();
    expect(screen.getByTestId("config-turn-mode")).toBeInTheDocument();
    const linear = screen.getByRole("radio", { name: /linear turns/i });
    const model = screen.getByRole("radio", { name: /model has its own turn/i });
    expect(linear).toBeChecked();
    expect(model).not.toBeChecked();
    expect(screen.getByText(/stays silent while the candidate answers/i)).toBeInTheDocument();
  });

  it("bank persona: choosing the model turn patches ONLY bank_turn_mode", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRail();
    await user.click(screen.getByRole("radio", { name: /model has its own turn/i }));
    expect(onChange).toHaveBeenCalledWith({ bank_turn_mode: "model" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("bank persona in model mode: the hint warns it reacts once per pause", () => {
    renderRail({ bank_turn_mode: "model" });
    expect(screen.getByRole("radio", { name: /model has its own turn/i })).toBeChecked();
    expect(screen.getByText(/once per pause, not once per answer/i)).toBeInTheDocument();
  });

  it("external persona: the bank-only control is hidden (external is linear by construction)", () => {
    renderRail({ interviewBrain: "external", bank_turn_mode: "model" });
    expect(screen.queryByTestId("config-turn-mode")).not.toBeInTheDocument();
  });
});
