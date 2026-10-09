/** AdminPage tab actions the main AdminPage suite does not drive: bank and question management on
 * the Content tab, the rubric's add/remove/regenerate, the external interview API card, and the
 * page-level promise that a tab keeps its state across a switch. Admin/auth API mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter } from "react-router-dom";
import "../i18n";
import { AdminPage } from "./AdminPage";
import { SOP_POLL_MS } from "./admin/useSopTab";
import * as admin from "../api/admin";
import type { AdminQuestion, Bank, Checklist } from "../api/admin";
import * as auth from "../api/auth";
import * as personas from "../api/personas";

const BANKS: Bank[] = [
  { bank_id: "b1", name: "Demo Bank", description: "", language: "en-US", enabled: true, is_default: true },
  { bank_id: "b2", name: "Second Bank", description: "", language: "en-US", enabled: true, is_default: false },
];

function question(id: string, order: number, text: string): AdminQuestion {
  return {
    question_id: id,
    text,
    language: "en-US",
    order_index: order,
    enabled: true,
    expected_points: [],
    max_follow_ups: 0,
    checklist_item_count: 0,
  };
}

const QUESTIONS = [question("q1", 0, "First question?"), question("q2", 1, "Second question?")];

const CHECKLIST: Checklist = {
  checklist_id: "c1",
  question_id: "q1",
  prompt_version: "v1",
  weights_sum: 100,
  items: [
    { kind: "required", text: "on topic", weight: 60, source_quote: "SOP 4.2", source_page: "p.3", order_index: 0 },
    { kind: "forbidden", text: "guessing", weight: 40, source_quote: "", source_page: null, order_index: 1 },
  ],
};

const FOUNDRY_CFG = {
  endpoint: "",
  masked_key: "",
  default_project: "",
  model_or_deployment: "",
  knowledge_base: "",
  knowledge_source: "",
  is_active: false,
};

beforeEach(() => {
  // A signed-in admin: a residual token that me() accepts.
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
  vi.spyOn(admin, "listBanks").mockResolvedValue(BANKS);
  vi.spyOn(admin, "listBankQuestions").mockResolvedValue(QUESTIONS);
  vi.spyOn(admin, "getAiFoundryConfig").mockResolvedValue(FOUNDRY_CFG);
  vi.spyOn(admin, "getExternalConfig").mockResolvedValue({
    endpoint: "https://brain.example.com",
    masked_key: "****9876",
    user_tag: "demo",
    is_active: true,
  });
  vi.spyOn(personas, "listPersonas").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function renderPage() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </FluentProvider>,
  );
}

async function openDemoBank(user: ReturnType<typeof userEvent.setup>) {
  renderPage();
  await user.click(await screen.findByText("Demo Bank"));
  await screen.findByText("First question?");
}

describe("Content tab: banks", () => {
  it("makes a non-default bank the default and reloads the list", async () => {
    const user = userEvent.setup();
    const setDefault = vi.spyOn(admin, "setDefaultBank").mockResolvedValue(BANKS[1]);
    renderPage();
    const row = (await screen.findByText("Second Bank")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /default/i }));
    await waitFor(() => expect(setDefault).toHaveBeenCalledWith("b2"));
    await waitFor(() => expect(admin.listBanks).toHaveBeenCalledTimes(2));
  });

  it("creates a bank from the name field, ignoring a blank name", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(admin, "createBank").mockResolvedValue(BANKS[1]);
    renderPage();
    const addButton = await screen.findByRole("button", { name: /add bank/i });
    await user.click(addButton); // blank → nothing sent
    expect(create).not.toHaveBeenCalled();

    const nameInput = screen.getAllByRole("textbox")[0];
    await user.type(nameInput, "  New Bank  ");
    await user.click(addButton);
    // Not the first bank, so it is not created as the default.
    await waitFor(() => expect(create).toHaveBeenCalledWith("New Bank", false));
    expect(nameInput).toHaveValue("");
  });
});

describe("Content tab: questions", () => {
  it("moves a question up by swapping it with the one above, then reloads", async () => {
    const user = userEvent.setup();
    const reorder = vi.spyOn(admin, "reorderQuestions").mockResolvedValue(undefined);
    await openDemoBank(user);
    const moveUps = screen.getAllByRole("button", { name: /move up/i });
    expect(moveUps[0]).toBeDisabled(); // the first question cannot move up
    await user.click(moveUps[1]);
    await waitFor(() => expect(reorder).toHaveBeenCalledWith("b1", ["q2", "q1"]));
  });

  it("deletes a question and reloads the bank", async () => {
    const user = userEvent.setup();
    const del = vi.spyOn(admin, "deleteQuestion").mockResolvedValue(undefined);
    await openDemoBank(user);
    const row = screen.getByText("Second question?").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("q2"));
    expect(admin.listBankQuestions).toHaveBeenCalledTimes(2);
  });

  it("adds a question to the open bank, ignoring blank text", async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(admin, "addBankQuestion").mockResolvedValue(question("q3", 2, "Third?"));
    await openDemoBank(user);
    const addButton = screen.getByRole("button", { name: /add question/i });
    await user.click(addButton);
    expect(add).not.toHaveBeenCalled();

    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs[inputs.length - 1], "Third?");
    await user.click(addButton);
    await waitFor(() => expect(add).toHaveBeenCalledWith("b1", "Third?", []));
  });
});

describe("Content tab: rubric", () => {
  it("shows no rubric yet for a question that has none, and can generate one", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "getChecklist").mockRejectedValue(new Error("404"));
    const draft = vi.spyOn(admin, "draftChecklist").mockResolvedValue(CHECKLIST);
    await openDemoBank(user);
    await user.click(screen.getByTestId("rubric-btn-q1"));
    expect(await screen.findByText(/no rubric/i)).toBeInTheDocument();
    expect(screen.queryByTestId("checklist-save")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("checklist-generate"));
    await waitFor(() => expect(draft).toHaveBeenCalledWith("q1"));
    expect(await screen.findByTestId("checklist-text-0")).toHaveValue("on topic");
    expect(screen.getByTestId("checklist-status")).toBeInTheDocument();
    // The question list is reloaded so its rubric-status marker can show the new count.
    expect(admin.listBankQuestions).toHaveBeenCalledTimes(2);
  });

  it("adds and removes items in the working copy, and shows each item's SOP citation", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "getChecklist").mockResolvedValue(CHECKLIST);
    await openDemoBank(user);
    await user.click(screen.getByTestId("rubric-btn-q1"));
    expect(await screen.findByText(/SOP 4\.2/)).toHaveTextContent("— p.3");

    await user.click(screen.getByTestId("checklist-add-item"));
    expect(screen.getByTestId("checklist-text-2")).toHaveValue("");

    await user.click(screen.getByTestId("checklist-remove-0"));
    expect(screen.getByTestId("checklist-text-0")).toHaveValue("guessing");
    expect(screen.queryByTestId("checklist-text-2")).not.toBeInTheDocument();
  });

  it("warns while the weights do not add up to 100, and edits an item's weight and kind", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "getChecklist").mockResolvedValue(CHECKLIST);
    await openDemoBank(user);
    await user.click(screen.getByTestId("rubric-btn-q1"));
    await screen.findByTestId("checklist-text-0");
    expect(screen.queryByTestId("checklist-weights-hint")).not.toBeInTheDocument();

    await user.clear(screen.getByTestId("checklist-weight-0"));
    await user.type(screen.getByTestId("checklist-weight-0"), "10");
    expect(screen.getByTestId("checklist-weights-hint")).toBeInTheDocument();

    await user.click(screen.getByTestId("checklist-kind-0"));
    await user.click(await screen.findByRole("option", { name: "recommended" }));
    const save = vi.spyOn(admin, "editChecklistItems").mockResolvedValue(CHECKLIST);
    await user.click(screen.getByTestId("checklist-save"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "c1",
        expect.arrayContaining([expect.objectContaining({ kind: "recommended", weight: 10 })]),
      ),
    );
  });
});

describe("Content tab: publishing a bank version", () => {
  it("shows the publish state, lists why a publish is refused, then publishes", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listBanks").mockResolvedValue([
      { ...BANKS[0], latest_version_no: 2, has_unpublished_changes: true },
      ...BANKS.slice(1),
    ]);
    const publish = vi
      .spyOn(admin, "publishBank")
      .mockResolvedValueOnce({
        published: false,
        created: false,
        version_no: null,
        problems: [
          { code: "no_rubric", question_no: 2, question_text: "Second?", weights_sum: null },
          { code: "weights", question_no: 3, question_text: "", weights_sum: 90 },
        ],
      })
      .mockResolvedValueOnce({ published: true, created: true, version_no: 3, problems: [] });
    await openDemoBank(user);
    expect(screen.getByTestId("bank-version-status")).toHaveTextContent(
      "Published v2 · Unpublished changes",
    );

    await user.click(screen.getByTestId("bank-publish"));
    const problems = await screen.findByTestId("bank-publish-problems");
    expect(problems).toHaveTextContent("question 2 has no scoring rubric — Second?");
    expect(problems).toHaveTextContent("question 3: rubric weights total 90, not 100");

    await user.click(screen.getByTestId("bank-publish"));
    expect(await screen.findByTestId("bank-publish-result")).toHaveTextContent("Published as v3");
    expect(publish).toHaveBeenCalledWith(BANKS[0].bank_id);
  });

  it("offers nothing to publish when the draft equals the latest version", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listBanks").mockResolvedValue([
      { ...BANKS[0], latest_version_no: 1, has_unpublished_changes: false },
      ...BANKS.slice(1),
    ]);
    await openDemoBank(user);
    expect(screen.getByTestId("bank-version-status")).toHaveTextContent("Published v1");
    expect(screen.getByTestId("bank-publish")).toBeDisabled();
  });
});

describe("Content tab: a rubric save keeps SOP links and disclosure-only flags", () => {
  it("sends both back and shows the cited document", async () => {
    const user = userEvent.setup();
    const linked: Checklist = {
      ...CHECKLIST,
      items: [
        { ...CHECKLIST.items[0], source_document_id: "doc-1", source_document_name: "Monitoring Plan.pdf" },
        { ...CHECKLIST.items[1], advisory: true },
      ],
    };
    vi.spyOn(admin, "getChecklist").mockResolvedValue(linked);
    await openDemoBank(user);
    await user.click(screen.getByTestId("rubric-btn-q1"));
    expect(await screen.findByText(/SOP 4\.2/)).toHaveTextContent("— Monitoring Plan.pdf · p.3");
    expect(screen.getByTestId("checklist-advisory-1")).toBeInTheDocument();

    const save = vi.spyOn(admin, "editChecklistItems").mockResolvedValue(linked);
    await user.click(screen.getByTestId("checklist-save"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("c1", [
        expect.objectContaining({ text: "on topic", source_document_id: "doc-1", advisory: false }),
        expect.objectContaining({ text: "guessing", source_document_id: null, advisory: true }),
      ]),
    );
  });
});

describe("Connection tab: external interview API", () => {
  async function openConnection(user: ReturnType<typeof userEvent.setup>) {
    renderPage();
    await user.click(await screen.findByTestId("admin-tab-connection"));
    await waitFor(() => expect(screen.getByTestId("ext-endpoint")).toHaveValue("https://brain.example.com"));
  }

  it("loads the saved endpoint and user tag, never the key, and saves an edit", async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(admin, "updateExternalConfig").mockResolvedValue({
      endpoint: "https://brain2.example.com",
      masked_key: "****9876",
      user_tag: "demo",
      is_active: true,
    });
    await openConnection(user);
    expect(screen.getByTestId("ext-user-tag")).toHaveValue("demo");
    expect(screen.getByTestId("ext-key")).toHaveValue("");
    expect(screen.getByTestId("ext-key")).toHaveAttribute("placeholder", "API key (saved: ****9876)");

    await user.clear(screen.getByTestId("ext-endpoint"));
    await user.type(screen.getByTestId("ext-endpoint"), " https://brain2.example.com ");
    await user.click(screen.getByTestId("ext-save"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        endpoint: "https://brain2.example.com",
        api_key: "",
        user_tag: "demo",
      }),
    );
    expect(await screen.findByTestId("ext-status")).toHaveTextContent("Saved.");
  });

  it("shows the connection test's message", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "testExternalConfig").mockResolvedValue({ success: true, message: "Reachable." });
    await openConnection(user);
    await user.click(screen.getByTestId("ext-test"));
    expect(await screen.findByTestId("ext-status")).toHaveTextContent("Reachable.");
  });

  it("reveals the key on a deliberate click and hides it on the next", async () => {
    const user = userEvent.setup();
    const reveal = vi.spyOn(admin, "revealExternalKey").mockResolvedValue({ api_key: "sk-plain" });
    await openConnection(user);
    await user.click(screen.getByTestId("ext-reveal"));
    expect(await screen.findByTestId("ext-revealed")).toHaveTextContent("sk-plain");
    expect(screen.getByTestId("ext-reveal")).toHaveTextContent("Hide key");

    await user.click(screen.getByTestId("ext-reveal"));
    expect(screen.queryByTestId("ext-revealed")).not.toBeInTheDocument();
    expect(reveal).toHaveBeenCalledTimes(1); // hiding does not fetch again
  });

  it("says so when no external key is configured", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "revealExternalKey").mockResolvedValue({ api_key: "" });
    await openConnection(user);
    await user.click(screen.getByTestId("ext-reveal"));
    expect(await screen.findByTestId("ext-revealed")).toHaveTextContent("(no key configured)");
  });

  it("shows a failed action in the page's error banner", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "testExternalConfig").mockRejectedValue(new Error("502 Bad Gateway: down"));
    await openConnection(user);
    await user.click(screen.getByTestId("ext-test"));
    expect(await screen.findByRole("alert")).toHaveTextContent("502 Bad Gateway: down");
  });
});

describe("tab switching", () => {
  it("keeps a tab's state: the open bank and an unsaved connection edit survive a round trip", async () => {
    const user = userEvent.setup();
    await openDemoBank(user);

    await user.click(screen.getByTestId("admin-tab-connection"));
    await waitFor(() => expect(screen.getByTestId("ext-endpoint")).toHaveValue("https://brain.example.com"));
    await user.clear(screen.getByTestId("ext-user-tag"));
    await user.type(screen.getByTestId("ext-user-tag"), "unsaved");

    await user.click(screen.getByTestId("admin-tab-content"));
    expect(screen.getByText("First question?")).toBeInTheDocument();
    await user.click(screen.getByTestId("admin-tab-connection"));
    expect(screen.getByTestId("ext-user-tag")).toHaveValue("unsaved");
    // Nothing was refetched by switching.
    expect(admin.listBankQuestions).toHaveBeenCalledTimes(1);
    expect(admin.getExternalConfig).toHaveBeenCalledTimes(1);
  });
});

describe("SOP documents tab", () => {
  const DOCS: admin.SopDocument[] = [
    {
      document_id: "d1", name: "Widget SOP.pdf", library_id: "lib1", status: "chunked", size: 10, chunk_count: 3,
      markdown_source: "document_intelligence", section_count: 3, markdown_error: "", converting: false,
      summary_status: "draft", summary_error: "", summarizing: false,
    },
    {
      document_id: "d2", name: "Matrix.pdf", library_id: "lib1", status: "chunked", size: 10, chunk_count: 1,
      markdown_source: "failed", section_count: 0, markdown_error: "pages not fully read: page 3: 34%",
      converting: false, summary_status: "", summary_error: "", summarizing: false,
    },
  ];
  const SECTIONS: admin.SopSection[] = [
    { order_index: 0, number: "1", title: "PURPOSE", level: 1, parent_index: null, page_start: 1, page_end: 1, full_length: 40 },
    { order_index: 1, number: "2", title: "RESPONSIBILITIES", level: 1, parent_index: null, page_start: 1, page_end: 2, full_length: 90 },
    { order_index: 2, number: "2.1", title: "Inspector", level: 2, parent_index: 1, page_start: 2, page_end: 2, full_length: 30 },
  ];
  const DRAFT: admin.SopSummary = {
    summary: "**Purpose:** Inspect widgets.", status: "draft", error: "", reviewed_at: null, summarizing: false,
  };

  const LIBRARY: admin.SopLibrary = { library_id: "lib1", name: "Widget SOPs", description: "", document_count: 2 };

  beforeEach(() => {
    vi.spyOn(admin, "getSopSummary").mockResolvedValue(DRAFT);
    vi.spyOn(admin, "listSopLibraries").mockResolvedValue([LIBRARY]);
  });

  it("lists libraries closed; a click opens one to show its documents", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
    vi.spyOn(admin, "listSopLibraries").mockResolvedValue([
      LIBRARY,
      { library_id: "lib2", name: "Empty SOPs", description: "", document_count: 0 },
    ]);
    renderPage();
    await user.click(await screen.findByTestId("admin-tab-sop"));
    const toggle = await screen.findByTestId("sop-library-toggle-lib1");
    expect(toggle).toHaveTextContent("Widget SOPs2 documents");
    expect(screen.queryByTestId("sop-doc-d1")).not.toBeInTheDocument(); // closed by default
    await user.click(toggle);
    expect(await screen.findByTestId("sop-doc-d1")).toBeInTheDocument();
    // A library that holds documents cannot be deleted; an empty one can.
    expect(screen.queryByTestId("sop-library-delete-lib1")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("sop-library-toggle-lib2"));
    expect(screen.getByTestId("sop-library-empty-lib2")).toBeInTheDocument();
    expect(screen.getByTestId("sop-library-delete-lib2")).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByTestId("sop-doc-d1")).not.toBeInTheDocument(); // closed again
  });

  it("keeps uploading after one file fails, and names the file that failed", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
    const upload = vi
      .spyOn(admin, "uploadSopDocument")
      .mockRejectedValueOnce(new Error("File exceeds 50 MB limit"))
      .mockResolvedValueOnce(DOCS[0]);
    renderPage();
    await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));
    const big = new File(["x"], "Huge.pdf", { type: "application/pdf" });
    const ok = new File(["x"], "Small.pdf", { type: "application/pdf" });
    await user.upload(screen.getByTestId("sop-library-file-lib1"), [big, ok]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const notice = await screen.findByTestId("sop-library-notice");
    expect(notice).toHaveTextContent("Uploaded 1 document");
    expect(notice).toHaveTextContent("1 file could not be uploaded: Huge.pdf: File exceeds 50 MB limit");
  });

  it("uploads into the library it was opened from, and creates and renames libraries", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
    const upload = vi.spyOn(admin, "uploadSopDocument").mockResolvedValue(DOCS[0]);
    const create = vi
      .spyOn(admin, "createSopLibrary")
      .mockResolvedValue({ library_id: "lib3", name: "New SOPs", description: "", document_count: 0 });
    const rename = vi.spyOn(admin, "updateSopLibrary").mockResolvedValue({ ...LIBRARY, name: "GCO SOPs" });
    renderPage();
    await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));

    const file = new File(["1 PURPOSE"], "Deploy SOP.pdf", { type: "application/pdf" });
    await user.upload(screen.getByTestId("sop-library-file-lib1"), file);
    await waitFor(() => expect(upload).toHaveBeenCalledWith("lib1", file));
    expect(await screen.findByTestId("sop-library-notice")).toHaveTextContent("Uploaded 1 document");

    await user.type(screen.getByTestId("sop-library-new-name"), "New SOPs");
    await user.click(screen.getByTestId("sop-library-new"));
    expect(create).toHaveBeenCalledWith("New SOPs");

    await user.click(screen.getByTestId("sop-library-rename-lib1"));
    const name = screen.getByTestId("sop-library-name-lib1");
    await user.clear(name);
    await user.type(name, "GCO SOPs");
    await user.click(screen.getByTestId("sop-library-rename-save-lib1"));
    expect(rename).toHaveBeenCalledWith("lib1", { name: "GCO SOPs" });
  });

  it("lists conversions with their failure reason, then a document's sections and a full section", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
    vi.spyOn(admin, "listSopSections").mockResolvedValue(SECTIONS);
    vi.spyOn(admin, "getSopSection").mockResolvedValue({
      number: "2", title: "RESPONSIBILITIES", page_start: 1, page_end: 2,
      full_text: "2 RESPONSIBILITIES\n\n2.1 Inspector checks every widget.",
    });
    renderPage();
    await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));
    expect(await screen.findByTestId("sop-doc-d2")).toHaveTextContent("Failed");
    expect(screen.getByTestId("sop-doc-d2")).toHaveTextContent("page 3: 34%");
    expect(screen.getByTestId("sop-doc-d1")).toHaveTextContent("Document Intelligence");

    await user.click(screen.getByText("Widget SOP.pdf"));
    expect(await screen.findByTestId("sop-section-2")).toHaveTextContent("2.1 Inspector");
    await user.click(screen.getByTestId("sop-section-1"));
    expect(await screen.findByTestId("sop-section-text")).toHaveTextContent("2.1 Inspector checks every widget.");
  });

  it("converts again in the background: polls while converting, then shows the new sections", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const list = vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
      const sections = vi.spyOn(admin, "listSopSections").mockResolvedValue(SECTIONS);
      const rebuild = vi
        .spyOn(admin, "rebuildSopDocument")
        .mockResolvedValue({ ...DOCS[0], converting: true });
      renderPage();
      await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));
      await user.click(await screen.findByText("Widget SOP.pdf"));
      await screen.findByTestId("sop-section-2");

      await user.click(screen.getByTestId("sop-rebuild"));
      expect(rebuild).toHaveBeenCalledWith("d1");
      expect(await screen.findByTestId("sop-doc-d1")).toHaveTextContent("Converting…");
      expect(screen.getByTestId("sop-rebuild")).toBeDisabled();

      list.mockResolvedValue([{ ...DOCS[0], section_count: 4 }, DOCS[1]]);
      sections.mockResolvedValue([...SECTIONS, { ...SECTIONS[2], order_index: 3, number: "2.2", title: "Supervisor" }]);
      await vi.advanceTimersByTimeAsync(SOP_POLL_MS);
      await waitFor(() => expect(screen.getByTestId("sop-doc-d1")).toHaveTextContent("Document Intelligence"));
      expect(await screen.findByTestId("sop-section-3")).toHaveTextContent("2.2 Supervisor");
      expect(screen.getByTestId("sop-rebuild")).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the AI draft as not used in scoring, and approving it puts it into scoring", async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
    vi.spyOn(admin, "listSopSections").mockResolvedValue(SECTIONS);
    const save = vi
      .spyOn(admin, "saveSopSummary")
      .mockResolvedValue({ ...DRAFT, summary: "**Purpose:** Inspect every widget.", status: "reviewed" });
    renderPage();
    await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));
    expect(await screen.findByTestId("sop-doc-d1")).toHaveTextContent("Draft — not used in scoring");
    await user.click(screen.getByText("Widget SOP.pdf"));
    const box = await screen.findByTestId("sop-summary-text");
    expect(box).toHaveValue("**Purpose:** Inspect widgets.");
    expect(screen.getByTestId("sop-summary-save")).toBeDisabled(); // nothing edited yet

    await user.clear(box);
    await user.type(box, "**Purpose:** Inspect every widget.");
    list.mockResolvedValue([{ ...DOCS[0], summary_status: "reviewed" }, DOCS[1]]);
    await user.click(screen.getByTestId("sop-summary-approve"));
    expect(save).toHaveBeenCalledWith("d1", "**Purpose:** Inspect every widget.", true);
    expect(await screen.findByTestId("sop-summary")).toHaveTextContent("Approved — used in scoring");
    expect(screen.getByTestId("sop-summary-approve")).toBeDisabled(); // already approved, unedited
    await waitFor(() => expect(screen.getByTestId("sop-doc-d1")).toHaveTextContent("Approved"));
  });

  it("drafts again in the background and shows the new draft when it is done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const list = vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
      vi.spyOn(admin, "listSopSections").mockResolvedValue(SECTIONS);
      const redraft = vi.spyOn(admin, "redraftSopSummary").mockResolvedValue({ ...DRAFT, summarizing: true });
      renderPage();
      await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));
      await user.click(await screen.findByText("Widget SOP.pdf"));
      await screen.findByTestId("sop-summary-text");

      list.mockResolvedValue([{ ...DOCS[0], summarizing: true }, DOCS[1]]);
      await user.click(screen.getByTestId("sop-summary-redraft"));
      expect(redraft).toHaveBeenCalledWith("d1");
      expect(await screen.findByTestId("sop-summary")).toHaveTextContent("Drafting…");

      list.mockResolvedValue(DOCS);
      vi.mocked(admin.getSopSummary).mockResolvedValue({ ...DRAFT, summary: "**Purpose:** New draft." });
      await vi.advanceTimersByTimeAsync(SOP_POLL_MS);
      await waitFor(() => expect(screen.getByTestId("sop-summary-text")).toHaveValue("**Purpose:** New draft."));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unsaved summary edits when a conversion finishes, and shows a failed save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const list = vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
      vi.spyOn(admin, "listSopSections").mockResolvedValue(SECTIONS);
      vi.spyOn(admin, "rebuildSopDocument").mockResolvedValue({ ...DOCS[0], converting: true });
      vi.spyOn(admin, "saveSopSummary").mockRejectedValue(new Error("The summary is being drafted"));
      renderPage();
      await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));
      await user.click(await screen.findByText("Widget SOP.pdf"));
      const box = await screen.findByTestId("sop-summary-text");

      list.mockResolvedValue([{ ...DOCS[0], converting: true }, DOCS[1]]);
      await user.click(screen.getByTestId("sop-rebuild"));
      await user.type(box, " Mine.");
      expect(screen.getByTestId("sop-summary-redraft")).toBeDisabled(); // would replace the edit

      list.mockResolvedValue(DOCS);
      vi.mocked(admin.getSopSummary).mockResolvedValue({ ...DRAFT, summary: "Server text." });
      await vi.advanceTimersByTimeAsync(SOP_POLL_MS);
      await waitFor(() => expect(admin.getSopSummary).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("sop-summary-text")).toHaveValue("**Purpose:** Inspect widgets. Mine.");

      await user.click(screen.getByTestId("sop-summary-save"));
      expect(await screen.findByRole("alert")).toHaveTextContent("The summary is being drafted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the sections of the document clicked last, not of a slower earlier click", async () => {
    const user = userEvent.setup();
    vi.spyOn(admin, "listSopDocuments").mockResolvedValue(DOCS);
    let releaseFirst: (rows: admin.SopSection[]) => void = () => {};
    vi.spyOn(admin, "listSopSections").mockImplementation((id) =>
      id === "d1"
        ? new Promise((resolve) => (releaseFirst = resolve))
        : Promise.resolve([{ ...SECTIONS[0], title: "MATRIX ONLY" }]),
    );
    renderPage();
    await user.click(await screen.findByTestId("admin-tab-sop"));
    await user.click(await screen.findByTestId("sop-library-toggle-lib1"));
    await user.click(await screen.findByText("Widget SOP.pdf"));
    await user.click(screen.getByText("Matrix.pdf"));
    expect(await screen.findByTestId("sop-section-0")).toHaveTextContent("MATRIX ONLY");
    await act(async () => releaseFirst(SECTIONS));
    expect(screen.getByTestId("sop-section-0")).toHaveTextContent("MATRIX ONLY");
    expect(screen.queryByTestId("sop-section-2")).toBeNull();
  });
});
