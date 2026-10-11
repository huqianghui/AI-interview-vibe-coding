import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import "../../i18n";
import i18n from "../../i18n";
import * as admin from "../../api/admin";
import { JobsTab } from "./JobsTab";
import { duration } from "./jobsTable";
import { useJobsTab } from "./useJobsTab";

function job(over: Partial<admin.JobItem>): admin.JobItem {
  return {
    job_id: "j1",
    kind: "score_interview",
    target_id: "iv-1",
    target_label: "user1",
    status: "running",
    attempts: 1,
    max_attempts: 3,
    done: 2,
    total: 5,
    error: "",
    created_by: "candidate",
    created_at: "2026-10-11T06:00:00",
    started_at: "2026-10-11T06:00:00",
    finished_at: null,
    ...over,
  };
}

function Harness() {
  return <JobsTab state={useJobsTab(true)} />;
}

function renderTab() {
  render(
    <FluentProvider theme={webLightTheme}>
      <Harness />
    </FluentProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("JobsTab", () => {
  it("lists jobs with what they work on, their progress, and the first filter", async () => {
    await i18n.changeLanguage("en-US");
    const list = vi.spyOn(admin, "listJobs").mockResolvedValue({
      items: [
        job({}),
        job({
          job_id: "j2",
          kind: "sop_build",
          target_label: "",
          target_id: "doc-9",
          done: null,
          total: null,
          status: "failed",
          error: "TimeoutError: slow",
        }),
      ],
      total: 2,
    });
    renderTab();
    const table = await screen.findByTestId("jobs-table");
    expect(table).toHaveTextContent("Score interview");
    expect(table).toHaveTextContent("user1");
    expect(table).toHaveTextContent("2/5");
    expect(table).toHaveTextContent("doc-9"); // no label: the id
    expect(table).toHaveTextContent("TimeoutError: slow");
    expect(screen.getByTestId("job-status-j2")).toHaveTextContent("Failed");
    // First view: what is going on and what went wrong.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["queued", "running", "failed"], offset: 0 }),
    );
  });

  it("retries a failed job and cancels a running one, saying so above the table", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    vi.spyOn(admin, "listJobs").mockResolvedValue({
      items: [
        job({}),
        job({ job_id: "j2", status: "failed", target_label: "Widget.pdf", kind: "sop_build" }),
      ],
      total: 2,
    });
    vi.spyOn(admin, "retryJob").mockResolvedValue(
      job({ job_id: "j3", status: "queued", target_label: "Widget.pdf", kind: "sop_build" }),
    );
    const cancel = vi.spyOn(admin, "cancelJob").mockResolvedValue(job({ status: "running" }));
    renderTab();
    await user.click(await screen.findByTestId("job-retry-j2"));
    expect(await screen.findByTestId("jobs-notice")).toHaveTextContent(
      "Convert SOP for Widget.pdf queued again.",
    );
    await user.click(screen.getByTestId("job-cancel-j1"));
    expect(cancel).toHaveBeenCalledWith("j1");
    await waitFor(() =>
      expect(screen.getByTestId("jobs-notice")).toHaveTextContent("cancel asked"),
    );
  });

  it("filters by kind and status, and a failed action is an alert, not a row", async () => {
    await i18n.changeLanguage("en-US");
    const user = userEvent.setup();
    const list = vi.spyOn(admin, "listJobs").mockResolvedValue({
      items: [job({ status: "failed" })],
      total: 1,
    });
    vi.spyOn(admin, "retryJob").mockRejectedValue(new Error("The same work is already queued"));
    renderTab();
    await user.selectOptions(await screen.findByTestId("jobs-filter-kind"), "citation_run");
    await user.click(screen.getByTestId("jobs-filter-status-succeeded"));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: ["citation_run"],
          status: ["queued", "running", "failed", "succeeded"],
        }),
      ),
    );
    await user.click(screen.getByTestId("job-retry-j1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The same work is already queued");
  });

  it("reports how long a job ran, or has been running", () => {
    const done = job({ started_at: "2026-10-11T06:00:00", finished_at: "2026-10-11T06:03:05" });
    expect(duration(done)).toBe("3 min 5 s");
    const running = job({ started_at: "2026-10-11T06:00:00", finished_at: null });
    expect(duration(running, Date.parse("2026-10-11T06:00:42Z"))).toBe("42 s");
    expect(duration(job({ started_at: null }))).toBe("—");
  });
});
