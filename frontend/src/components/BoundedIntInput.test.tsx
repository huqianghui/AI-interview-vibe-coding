/** BoundedIntInput — draft/clamp/revert contract shared by every bounded admin knob (review D9). */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoundedIntInput } from "./BoundedIntInput";

function renderInput(value = 3, min = 1, max = 60) {
  const onCommit = vi.fn();
  render(<BoundedIntInput value={value} min={min} max={max} onCommit={onCommit} data-testid="n" />);
  return { onCommit, input: screen.getByTestId("n") };
}

describe("BoundedIntInput", () => {
  it("typing edits a draft; blur commits clamped to max", async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput();
    await user.clear(input);
    expect(input).toHaveValue(null);
    expect(onCommit).not.toHaveBeenCalled();
    await user.type(input, "100");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(60);
  });

  it("negative clamps to min on Enter; empty reverts to the saved value without a commit", async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput();
    await user.clear(input);
    await user.type(input, "-5{Enter}");
    expect(onCommit).toHaveBeenCalledWith(1);
    onCommit.mockClear();
    await user.clear(input);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue(3);
  });

  it("an unchanged value on blur emits nothing; a zero minimum is allowed", async () => {
    const user = userEvent.setup();
    const { onCommit, input } = renderInput(2, 0, 5);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "0{Enter}");
    expect(onCommit).toHaveBeenCalledWith(0);
  });
});
