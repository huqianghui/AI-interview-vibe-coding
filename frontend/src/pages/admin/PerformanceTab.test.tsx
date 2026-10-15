/** The admin Performance tab (spec-admin-performance-tab): the Operation id lookup and its links,
 * the way in from Interview results, the URL that carries both, and the network check. Admin API
 * mocked; the probe module tested on its own below. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter, useLocation } from "react-router-dom";
import "../../i18n";
import { AdminPage } from "../AdminPage";
import * as admin from "../../api/admin";
import type { InterviewResultItem, OperationLookup } from "../../api/admin";
import * as auth from "../../api/auth";
import * as personas from "../../api/personas";
import * as probe from "./performanceProbe";
import { normalizeOperationId } from "./usePerformanceTab";

const OP = "0af7651916cd43dd8448eb211c80319c";
const INTERVIEW_ID = "0af76519-16cd-43dd-8448-eb211c80319c";

const ROW: InterviewResultItem = {
  id: INTERVIEW_ID,
  status: "scored",
  started_at: "2026-10-15T09:00:00",
  completed_at: "2026-10-15T09:20:00",
  persona_name: "Ava",
  bank_name: "Demo Bank",
  total_score: 80,
  outcome: "Meets Expectations",
  has_report: true,
  user_id: "u2",
  username: "alice",
  persona_id: "p1",
  bank_id: "b1",
  operation_id: OP,
};

const LOOKUP: OperationLookup = {
  operation_id: OP,
  interview: ROW,
  logs_url: "https://portal.azure.com/#@t/blade/logs",
  workbook_url: "https://portal.azure.com/#@t/resource/workbook",
};

let lastSearch = "";
function SearchSpy() {
  lastSearch = useLocation().search;
  return null;
}

function renderAt(path: string) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <MemoryRouter initialEntries={[path]}>
        <AdminPage />
        <SearchSpy />
      </MemoryRouter>
    </FluentProvider>,
  );
}

beforeEach(() => {
  auth.setAdminToken("jwt");
  vi.spyOn(auth, "me").mockResolvedValue({
    id: "u1",
    username: "admin",
    email: "",
    full_name: "",
    role: "admin",
    is_active: true,
    preferred_language: "en-US",
  });
  vi.spyOn(admin, "listBanks").mockResolvedValue([]);
  vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue({
    endpoint: "",
    masked_key: "",
    default_project: "",
    model_or_deployment: "",
    knowledge_base: "",
    knowledge_source: "",
    is_active: false,
  });
  vi.spyOn(admin, "getExternalConfig").mockResolvedValue({
    endpoint: "",
    masked_key: "",
    user_tag: "",
    is_active: false,
  });
  vi.spyOn(admin, "listUsers").mockResolvedValue([]);
  vi.spyOn(admin, "listSopLibraries").mockResolvedValue([]);
  vi.spyOn(personas, "listPersonas").mockResolvedValue([]);
  vi.spyOn(admin, "getPerformanceLinks").mockResolvedValue({
    workbook_url: LOOKUP.workbook_url,
    logs: true,
    transaction: true,
  });
  vi.spyOn(admin, "lookupOperation").mockResolvedValue(LOOKUP);
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("Operation id lookup", () => {
  it("arriving on ?op= looks it up and shows the interview and its links", async () => {
    renderAt(`/admin?tab=performance&op=${OP}`);
    expect(await screen.findByTestId("performance-result-id")).toHaveTextContent(OP);
    expect(admin.lookupOperation).toHaveBeenCalledWith(OP);
    expect(screen.getByTestId("performance-interview")).toHaveTextContent("alice");
    expect(screen.getByTestId("performance-logs")).toHaveAttribute("href", LOOKUP.logs_url);
    expect(screen.getByTestId("performance-workbook")).toHaveAttribute("href", LOOKUP.workbook_url);
  });

  it("a pasted interview id (dashes and all) is looked up as its Operation id, into the URL", async () => {
    const user = userEvent.setup();
    renderAt("/admin?tab=performance");
    await user.type(await screen.findByTestId("performance-operation-input"), INTERVIEW_ID);
    await user.click(screen.getByTestId("performance-lookup"));
    await waitFor(() => expect(admin.lookupOperation).toHaveBeenCalledWith(OP));
    expect(lastSearch).toContain(`op=${OP}`);
  });

  it("a malformed id is refused without asking the backend", async () => {
    const user = userEvent.setup();
    renderAt("/admin?tab=performance");
    await user.type(await screen.findByTestId("performance-operation-input"), "nope");
    await user.click(screen.getByTestId("performance-lookup"));
    expect(await screen.findByText(/32 hexadecimal characters/)).toBeInTheDocument();
    expect(admin.lookupOperation).not.toHaveBeenCalled();
  });

  it("an id that is no interview's still gets its links", async () => {
    vi.mocked(admin.lookupOperation).mockResolvedValue({ ...LOOKUP, interview: null });
    renderAt(`/admin?tab=performance&op=${OP}`);
    expect(await screen.findByTestId("performance-no-interview")).toBeInTheDocument();
    expect(screen.getByTestId("performance-logs")).toBeInTheDocument();
  });

  it("finds the end-to-end transaction on demand", async () => {
    const user = userEvent.setup();
    const find = vi
      .spyOn(admin, "getTransactionLink")
      .mockResolvedValue({ status: "found", url: "https://portal.azure.com/#view/e2e" });
    renderAt(`/admin?tab=performance&op=${OP}`);
    await user.click(await screen.findByTestId("performance-transaction-find"));
    expect(find).toHaveBeenCalledWith(OP);
    expect(await screen.findByTestId("performance-transaction-link")).toHaveAttribute(
      "href",
      "https://portal.azure.com/#view/e2e",
    );
  });

  it.each([
    [{ status: "not_found" as const }, /Not in App Insights yet/],
    [{ status: "unavailable" as const, reason: "needs a role" }, /Unavailable: needs a role/],
  ])("says why there is no transaction link (%o)", async (link, text) => {
    const user = userEvent.setup();
    vi.spyOn(admin, "getTransactionLink").mockResolvedValue(link);
    renderAt(`/admin?tab=performance&op=${OP}`);
    await user.click(await screen.findByTestId("performance-transaction-find"));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("opens the interview's result from the lookup", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listInterviewResults").mockResolvedValue({
      items: [ROW],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const detail = vi.spyOn(admin, "getInterview").mockResolvedValue({
      item: ROW,
      report: null,
      transcript: [],
    });
    renderAt(`/admin?tab=performance&op=${OP}`);
    await user.click(await screen.findByTestId("performance-open-result"));
    await waitFor(() => expect(detail).toHaveBeenCalledWith(INTERVIEW_ID));
    expect(await screen.findByTestId("results-tab")).toBeInTheDocument();
  });
});

describe("Interview results → Performance", () => {
  it("a row's Operation id opens the Performance tab on it, without opening the row", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listInterviewResults").mockResolvedValue({
      items: [ROW],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const detail = vi.spyOn(admin, "getInterview");
    renderAt("/admin?tab=results");
    expect(await screen.findByTestId(`result-operation-${INTERVIEW_ID}`)).toHaveTextContent(
      OP.slice(0, 8),
    );
    await user.click(screen.getByTestId(`result-operation-open-${INTERVIEW_ID}`));
    expect(await screen.findByTestId("performance-tab")).toBeInTheDocument();
    await waitFor(() => expect(admin.lookupOperation).toHaveBeenCalledWith(OP));
    expect(lastSearch).toContain("tab=performance");
    expect(detail).not.toHaveBeenCalled();
  });
});

describe("network check", () => {
  it("shows the API round trip, the voice socket and the browser estimate", async () => {
    const user = userEvent.setup();
    vi.spyOn(probe, "measureApi").mockResolvedValue({ median: 42, p95: 90, failed: 1, total: 10 });
    vi.spyOn(probe, "measureWs").mockResolvedValue({ ok: true, ms: 120 });
    vi.spyOn(probe, "browserNetwork").mockReturnValue(null);
    renderAt("/admin?tab=performance");
    await user.click(await screen.findByTestId("performance-run-check"));
    expect(await screen.findByTestId("performance-api")).toHaveTextContent(
      "median 42 ms · p95 90 ms · 1 of 10 failed",
    );
    expect(probe.measureWs).toHaveBeenCalledWith("jwt");
    expect(screen.getByTestId("performance-ws")).toHaveTextContent("reachable, 120 ms to open");
    expect(screen.getByTestId("performance-browser")).toHaveTextContent("Not available");
  });
});

describe("probe helpers", () => {
  it("normalizes an Operation id or an interview id", () => {
    expect(normalizeOperationId(` ${INTERVIEW_ID.toUpperCase()} `)).toBe(OP);
    expect(normalizeOperationId("xyz")).toBeNull();
    expect(normalizeOperationId("0".repeat(32))).toBeNull();
  });

  it("percentile is nearest-rank", () => {
    expect(probe.percentile([], 50)).toBe(0);
    expect(probe.percentile([30, 10, 20], 50)).toBe(20);
    expect(probe.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
  });

  it("measureApi times each call and counts the failures", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error("down");
      return new Response("{}", { status: n === 3 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const result = await probe.measureApi(4, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
    expect(result.total).toBe(4);
    expect(result.failed).toBe(2);
  });

  it("measureWs resolves ok on probe.ok and reports a close otherwise", async () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      url: string;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((e: { code: number }) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const ok = probe.measureWs("tok");
    expect(sockets[0].url).toMatch(/\/api\/voice-live\/ws\?token=tok&probe=1$/);
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "probe.ok" }) });
    expect(await ok).toEqual({ ok: true, ms: expect.any(Number) });

    const refused = probe.measureWs("tok");
    sockets[1].onclose?.({ code: 1008 });
    expect(await refused).toEqual({ ok: false, reason: "closed (1008)" });
    vi.unstubAllGlobals();
  });

  it("browserNetwork reads navigator.connection where there is one", () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { effectiveType: "4g", rtt: 50, downlink: 10 },
    });
    expect(probe.browserNetwork()).toEqual({ type: "4g", rtt: 50, downlink: 10 });
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    expect(probe.browserNetwork()).toBeNull();
  });
});
