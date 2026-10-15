/** The admin Performance tab (spec-admin-performance-tab): the Operation id lookup and its links,
 * the way in from Interview results, the URL that carries both, and the network check. Admin API
 * mocked; the probe module tested on its own below. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter, useLocation } from "react-router-dom";
import "../../i18n";
import { AdminPage } from "../AdminPage";
import * as admin from "../../api/admin";
import type { InterviewNetwork, InterviewResultItem, OperationLookup } from "../../api/admin";
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

const NETWORK: InterviewNetwork = {
  status: "found",
  legacy: false,
  operations: [{ operation_id: OP, seen: null, logs_url: LOOKUP.logs_url }],
  media: {
    samples: 5,
    rtt_p95_ms: 294,
    audio_loss_pct: 0,
    available_in_p50_kbps: 846,
    resolution: "512x512",
  },
  avatar: { connected: 1, failed: 0, via_relay: 1, voice_over_ws: 0 },
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
  vi.spyOn(admin, "getInterviewNetwork").mockResolvedValue(NETWORK);
  // The live check: deterministic stand-ins for the network.
  vi.spyOn(probe, "apiRttOnce").mockResolvedValue(42);
  vi.spyOn(probe, "measureWs").mockResolvedValue({ ok: true, ms: 120 });
  vi.spyOn(probe, "measureStun").mockResolvedValue({ ok: true, ms: 80 });
  vi.spyOn(probe, "measureDownlink").mockResolvedValue(8000);
  vi.spyOn(probe, "browserNetwork").mockReturnValue(null);
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

describe("tab URL and states", () => {
  it("an unknown ?tab= opens the default tab", async () => {
    renderAt("/admin?tab=bogus");
    expect(await screen.findByTestId("admin-tab-content")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("performance-tab")).not.toBeInTheDocument();
  });

  it("with no App Insights links at all, says so once instead of on every row", async () => {
    vi.mocked(admin.getPerformanceLinks).mockResolvedValue({
      workbook_url: null,
      logs: false,
      transaction: false,
    });
    vi.mocked(admin.lookupOperation).mockResolvedValue({
      ...LOOKUP,
      logs_url: null,
      workbook_url: null,
    });
    renderAt(`/admin?tab=performance&op=${OP}`);
    expect(await screen.findByTestId("performance-not-configured")).toBeInTheDocument();
    await screen.findByTestId("performance-result");
    expect(screen.getAllByText(/not configured/i)).toHaveLength(1);
    expect(screen.queryByTestId("performance-transaction-find")).not.toBeInTheDocument();
  });

  it("an answer to an older lookup never replaces the newer one", async () => {
    const user = userEvent.setup();
    let release: (v: OperationLookup) => void = () => undefined;
    vi.mocked(admin.lookupOperation).mockImplementationOnce(
      () => new Promise<OperationLookup>((resolve) => (release = resolve)),
    );
    renderAt("/admin?tab=performance");
    const input = await screen.findByTestId("performance-operation-input");
    await user.type(input, OP);
    await user.click(screen.getByTestId("performance-lookup")); // slow, still pending
    await user.clear(input);
    await user.type(input, "nope");
    await user.click(screen.getByTestId("performance-lookup")); // invalid: newer
    release(LOOKUP);
    expect(await screen.findByText(/32 hexadecimal characters/)).toBeInTheDocument();
    expect(screen.queryByTestId("performance-result")).not.toBeInTheDocument();
  });
});

describe("Interview results → Performance", () => {
  it("the copy button copies the full id and does not open the row", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.spyOn(admin, "listInterviewResults").mockResolvedValue({
      items: [ROW],
      total: 1,
      limit: 20,
      offset: 0,
    });
    const detail = vi.spyOn(admin, "getInterview");
    renderAt("/admin?tab=results");
    await user.click(await screen.findByTestId(`result-operation-copy-${INTERVIEW_ID}`));
    expect(writeText).toHaveBeenCalledWith(OP);
    expect(detail).not.toHaveBeenCalled();
  });

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

describe("live network check", () => {
  it("starts on its own when the tab opens, with the chart, every reading and a grade", async () => {
    renderAt("/admin?tab=performance");
    expect(await screen.findByTestId("performance-api")).toHaveTextContent(
      "42 ms now · median 42 · p95 42 · 0 failed",
    );
    expect(screen.getByTestId("performance-live-state")).toHaveTextContent(/live/i);
    expect(screen.getByTestId("performance-rtt-chart")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("performance-ws")).toHaveTextContent("reachable, 120 ms to open"),
    );
    expect(probe.measureWs).toHaveBeenCalledWith("jwt");
    expect(screen.getByTestId("performance-stun")).toHaveTextContent(/open, answered in 80 ms/);
    expect(screen.getByTestId("performance-downlink")).toHaveTextContent("8000 kbit/s");
    expect(screen.getByTestId("performance-browser")).toHaveTextContent("Not available");
  });

  it("keeps sampling, so the chart moves and the grade appears", async () => {
    const { LIVE_CHECK } = await import("./usePerformanceTab");
    const saved = LIVE_CHECK.rttMs;
    LIVE_CHECK.rttMs = 20;
    try {
      renderAt("/admin?tab=performance");
      await waitFor(() => expect(vi.mocked(probe.apiRttOnce).mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(await screen.findByTestId("performance-live-grade-badge")).toHaveTextContent("Grade A");
      expect(screen.getByTestId("performance-live-grade")).toHaveTextContent(/Estimated/);
    } finally {
      LIVE_CHECK.rttMs = saved;
    }
  });

  it("pauses while the page is hidden", async () => {
    renderAt("/admin?tab=performance");
    await screen.findByTestId("performance-api");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByTestId("performance-live-state")).toHaveTextContent(/paused/i);
    visibility.mockRestore();
  });

  it("does not run on any other tab", async () => {
    renderAt("/admin?tab=results");
    vi.spyOn(admin, "listInterviewResults").mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    await screen.findByTestId("results-tab");
    expect(probe.apiRttOnce).not.toHaveBeenCalled();
  });

  it("the chart shows a sample's time and value on hover", async () => {
    renderAt("/admin?tab=performance");
    await screen.findByTestId("performance-api");
    const hit = screen.getByTestId("performance-rtt-hit");
    hit.getBoundingClientRect = () => ({ left: 0, width: 548, top: 0, height: 112 }) as DOMRect;
    fireEvent.mouseMove(hit, { clientX: 547 });
    expect(await screen.findByTestId("performance-rtt-tip")).toHaveTextContent("42 ms");
  });
});

describe("the network an interview ran on", () => {
  it("is read on lookup and graded: a photo avatar on RTT and loss only", async () => {
    renderAt(`/admin?tab=performance&op=${OP}`);
    expect(await screen.findByTestId("performance-interview-metrics")).toHaveTextContent(
      "RTT p95 294 ms · audio loss 0.0% · downlink p50 846 kbit/s · 5 samples · photo avatar",
    );
    expect(admin.getInterviewNetwork).toHaveBeenCalledWith(OP);
    expect(screen.getByTestId("performance-interview-grade-badge")).toHaveTextContent("Grade B");
    const grade = screen.getByTestId("performance-interview-grade");
    expect(grade).toHaveTextContent(/Photo avatar at the default bitrate/);
    expect(grade).toHaveTextContent(/Downlink not graded/);
    expect(grade).toHaveTextContent(/TURN relay/);
  });

  it("an interview from before the fixed id lists the operations it ran under", async () => {
    vi.mocked(admin.getInterviewNetwork).mockResolvedValue({
      ...NETWORK,
      legacy: true,
      operations: [
        { operation_id: "a".repeat(32), seen: "2026-10-15T05:09:08Z", logs_url: "https://x/1" },
        { operation_id: "b".repeat(32), seen: "2026-10-15T06:21:34Z", logs_url: "https://x/2" },
      ],
    });
    renderAt(`/admin?tab=performance&op=${OP}`);
    const legacy = await screen.findByTestId("performance-legacy");
    expect(legacy).toHaveTextContent(/2 operations/);
    expect(legacy).toHaveTextContent("a".repeat(32));
    expect(screen.queryByTestId("performance-logs")).not.toBeInTheDocument();
    expect(screen.queryByTestId("performance-transaction")).not.toBeInTheDocument();
  });

  it.each([
    [{ status: "not_found" as const }, /No telemetry for this interview/],
    [{ status: "unavailable" as const, reason: "needs a role" }, /Unavailable: needs a role/],
  ])("says why there is no grade (%o)", async (network, text) => {
    vi.mocked(admin.getInterviewNetwork).mockResolvedValue(network);
    renderAt(`/admin?tab=performance&op=${OP}`);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("the workbook is linked once, in its own card", async () => {
    renderAt(`/admin?tab=performance&op=${OP}`);
    await screen.findByTestId("performance-result");
    expect(screen.getAllByTestId("performance-workbook")).toHaveLength(1);
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

  it("apiRttOnce times one health call, null on a failure", async () => {
    vi.mocked(probe.apiRttOnce).mockRestore();
    const ok = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    expect(await probe.apiRttOnce(ok)).toEqual(expect.any(Number));
    expect(ok).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
    const bad = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await probe.apiRttOnce(bad)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await probe.apiRttOnce(down)).toBeNull();
  });

  it("measureStun asks Azure's relay and reads a server-reflexive candidate as open", async () => {
    vi.mocked(probe.measureStun).mockRestore();
    const made: FakePc[] = [];
    class FakePc {
      config: RTCConfiguration;
      onicecandidate: ((e: { candidate: { candidate: string } | null }) => void) | null = null;
      closed = false;
      constructor(config: RTCConfiguration) {
        this.config = config;
        made.push(this);
      }
      createDataChannel() {}
      async createOffer() {
        return {};
      }
      async setLocalDescription() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("RTCPeerConnection", FakePc);
    const open = probe.measureStun();
    expect(made[0].config.iceServers).toEqual([{ urls: probe.AZURE_STUN }]);
    made[0].onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 5 typ host" } });
    made[0].onicecandidate?.({ candidate: { candidate: "candidate:2 1 udp 1 1.2.3.4 5 typ srflx raddr 0" } });
    expect(await open).toEqual({ ok: true, ms: expect.any(Number) });
    expect(made[0].closed).toBe(true);

    const blocked = probe.measureStun();
    made[1].onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 5 typ host" } });
    made[1].onicecandidate?.({ candidate: null });
    expect(await blocked).toEqual({ ok: false, reason: expect.stringMatching(/3478/) });
    vi.unstubAllGlobals();
  });

  it("measureDownlink turns the bytes and time into kbit/s, null on a failure", async () => {
    vi.mocked(probe.measureDownlink).mockRestore();
    const fetchProbe = vi.spyOn(admin, "fetchDownloadProbe").mockResolvedValue(512 * 1024);
    expect(await probe.measureDownlink(512)).toBeGreaterThan(0);
    expect(fetchProbe).toHaveBeenCalledWith(512);
    fetchProbe.mockRejectedValue(new Error("nope"));
    expect(await probe.measureDownlink()).toBeNull();
  });

  it("measureWs resolves ok on probe.ok and reports a close otherwise", async () => {
    vi.mocked(probe.measureWs).mockRestore();
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
    vi.mocked(probe.browserNetwork).mockRestore();
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { effectiveType: "4g", rtt: 50, downlink: 10 },
    });
    expect(probe.browserNetwork()).toEqual({ type: "4g", rtt: 50, downlink: 10 });
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    expect(probe.browserNetwork()).toBeNull();
  });
});
