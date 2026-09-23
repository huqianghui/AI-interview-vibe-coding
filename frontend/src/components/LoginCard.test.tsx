/**
 * LoginCard: the shared sign-in card extracted for #102 (admin + candidate login gates render the
 * identical Fluent structure/behavior). Exercises the contract callers depend on: exact
 * `${testIdPrefix}-*` testids, Enter-to-submit, disabled-while-busy, and the inline error banner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../i18n";
import { LoginCard } from "./LoginCard";

function renderCard(props: Partial<React.ComponentProps<typeof LoginCard>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <LoginCard
        title="Sign in"
        body="Body copy"
        error={null}
        busy={false}
        onSubmit={onSubmit}
        testIdPrefix="test"
        {...props}
      />
    </FluentProvider>,
  );
  return { onSubmit };
}

afterEach(() => vi.restoreAllMocks());

describe("LoginCard", () => {
  it("renders the title and body copy", () => {
    renderCard({ title: "Candidate sign-in", body: "Sign in to start your interview." });
    expect(screen.getByText("Candidate sign-in")).toBeInTheDocument();
    expect(screen.getByText("Sign in to start your interview.")).toBeInTheDocument();
  });

  it("uses the exact ${testIdPrefix}-* testids for both inputs and the button", () => {
    renderCard({ testIdPrefix: "candidate" });
    expect(screen.getByTestId("candidate-username-input")).toBeInTheDocument();
    expect(screen.getByTestId("candidate-password-input")).toBeInTheDocument();
    expect(screen.getByTestId("candidate-login")).toBeInTheDocument();
  });

  it("calls onSubmit with the trimmed username and the password on button click", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderCard();
    await user.type(screen.getByTestId("test-username-input"), "  user1  ");
    await user.type(screen.getByTestId("test-password-input"), "pw123");
    await user.click(screen.getByTestId("test-login"));
    expect(onSubmit).toHaveBeenCalledWith("user1", "pw123");
  });

  it("submits on Enter in the password field", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderCard();
    await user.type(screen.getByTestId("test-username-input"), "user1");
    await user.type(screen.getByTestId("test-password-input"), "pw123{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("user1", "pw123");
  });

  it("disables both inputs and the button while busy", () => {
    renderCard({ busy: true });
    expect(screen.getByTestId("test-username-input")).toBeDisabled();
    expect(screen.getByTestId("test-password-input")).toBeDisabled();
    expect(screen.getByTestId("test-login")).toBeDisabled();
  });

  it("shows the error message with role=alert when present", () => {
    renderCard({ error: "Incorrect username or password." });
    expect(screen.getByRole("alert")).toHaveTextContent("Incorrect username or password.");
  });

  it("renders no alert when error is null", () => {
    renderCard({ error: null });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
