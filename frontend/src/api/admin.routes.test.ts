/** Every admin wrapper sends the method, path and body its backend route expects, with the bearer. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as admin from "./admin";
import { setAdminToken } from "./auth";

type Call = () => Promise<unknown>;

// [name, call, method, path, body (undefined = no body)]
const ROUTES: Array<[string, Call, string, string, unknown]> = [
  ["listBanks", () => admin.listBanks(), "GET", "/api/admin/question-banks", undefined],
  [
    "createBank",
    () => admin.createBank("B", true),
    "POST",
    "/api/admin/question-banks",
    { name: "B", is_default: true },
  ],
  [
    "setDefaultBank",
    () => admin.setDefaultBank("b1"),
    "POST",
    "/api/admin/question-banks/b1/default",
    undefined,
  ],
  [
    "listBankQuestions",
    () => admin.listBankQuestions("b1"),
    "GET",
    "/api/admin/question-banks/b1/questions",
    undefined,
  ],
  [
    "addBankQuestion",
    () => admin.addBankQuestion("b1", "Q?", ["p"]),
    "POST",
    "/api/admin/question-banks/b1/questions",
    { text: "Q?", expected_points: ["p"] },
  ],
  [
    "editQuestion",
    () => admin.editQuestion("q1", { enabled: false }),
    "PATCH",
    "/api/admin/question-banks/questions/q1",
    { enabled: false },
  ],
  [
    "deleteQuestion",
    () => admin.deleteQuestion("q1"),
    "DELETE",
    "/api/admin/question-banks/questions/q1",
    undefined,
  ],
  [
    "reorderQuestions",
    () => admin.reorderQuestions("b1", ["q2", "q1"]),
    "POST",
    "/api/admin/question-banks/b1/reorder",
    { ordered_ids: ["q2", "q1"] },
  ],
  [
    "draftChecklist",
    () => admin.draftChecklist("q1"),
    "POST",
    "/api/admin/checklists/questions/q1/draft",
    undefined,
  ],
  [
    "getChecklist",
    () => admin.getChecklist("q1"),
    "GET",
    "/api/admin/checklists/questions/q1",
    undefined,
  ],
  [
    "editChecklistItems",
    () => admin.editChecklistItems("c1", []),
    "PUT",
    "/api/admin/checklists/c1/items",
    { items: [] },
  ],
  [
    "getAiFoundryConfig",
    () => admin.getAiFoundryConfig(),
    "GET",
    "/api/admin/config/ai-foundry",
    undefined,
  ],
  [
    "updateAiFoundryConfig",
    () => admin.updateAiFoundryConfig({ endpoint: "e" } as admin.AiFoundryConfigInput),
    "PUT",
    "/api/admin/config/ai-foundry",
    { endpoint: "e" },
  ],
  [
    "testAiFoundryConfig",
    () => admin.testAiFoundryConfig(),
    "POST",
    "/api/admin/config/ai-foundry/test",
    undefined,
  ],
  [
    "listModelDeployments (default chat)",
    () => admin.listModelDeployments(),
    "GET",
    "/api/admin/config/ai-foundry/model-deployments?kind=chat",
    undefined,
  ],
  [
    "listModelDeployments (realtime)",
    () => admin.listModelDeployments("realtime"),
    "GET",
    "/api/admin/config/ai-foundry/model-deployments?kind=realtime",
    undefined,
  ],
  [
    "listKnowledgeBases",
    () => admin.listKnowledgeBases(),
    "GET",
    "/api/admin/config/ai-foundry/knowledge-bases",
    undefined,
  ],
  [
    "listVoiceLiveModels",
    () => admin.listVoiceLiveModels(),
    "GET",
    "/api/admin/config/ai-foundry/voice-live-models",
    undefined,
  ],
  [
    "listVoiceLiveModels (refresh)",
    () => admin.listVoiceLiveModels(true),
    "GET",
    "/api/admin/config/ai-foundry/voice-live-models?refresh=true",
    undefined,
  ],
  [
    "getExternalConfig",
    () => admin.getExternalConfig(),
    "GET",
    "/api/admin/external-interviewer",
    undefined,
  ],
  [
    "updateExternalConfig",
    () => admin.updateExternalConfig({ endpoint: "e", api_key: "", user_tag: "u" }),
    "PUT",
    "/api/admin/external-interviewer",
    { endpoint: "e", api_key: "", user_tag: "u" },
  ],
  [
    "testExternalConfig",
    () => admin.testExternalConfig(),
    "POST",
    "/api/admin/external-interviewer/test",
    undefined,
  ],
  [
    "revealExternalKey",
    () => admin.revealExternalKey(),
    "GET",
    "/api/admin/external-interviewer/reveal",
    undefined,
  ],
  ["listUsers", () => admin.listUsers(), "GET", "/api/admin/users", undefined],
  [
    "setUserAssignment",
    () => admin.setUserAssignment("u1", { persona_id: "p1", bank_id: null }),
    "PATCH",
    "/api/admin/users/u1/assignment",
    { persona_id: "p1", bank_id: null },
  ],
  ["listInterviewResults (no filter)", () => admin.listInterviewResults(), "GET", "/api/admin/interviews?", undefined],
  [
    "listInterviewResults (filters, repeated status, empties dropped)",
    () =>
      admin.listInterviewResults({
        user_id: "u1",
        status: ["scored", "completed"],
        bank_id: "",
        score_min: 50,
        sort: "total_score",
        order: "asc",
        limit: 20,
        offset: 40,
      }),
    "GET",
    "/api/admin/interviews?user_id=u1&status=scored&status=completed&score_min=50&sort=total_score&order=asc&limit=20&offset=40",
    undefined,
  ],
  ["getInterview", () => admin.getInterview("iv1"), "GET", "/api/admin/interviews/iv1", undefined],
  [
    "generateInterviewReport",
    () => admin.generateInterviewReport("iv1"),
    "POST",
    "/api/admin/interviews/iv1/report",
    undefined,
  ],
  [
    "fetchInterviewSopDocument",
    () => admin.fetchInterviewSopDocument("iv1", "doc/1"),
    "GET",
    "/api/admin/interviews/iv1/sop/doc%2F1",
    undefined,
  ],
];

describe("admin route wrappers", () => {
  beforeEach(() => {
    setAdminToken("adm");
    // The SOP-document wrapper returns a blob URL; jsdom has no createObjectURL.
    Object.assign(URL, { createObjectURL: vi.fn().mockReturnValue("blob:x") });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it.each(ROUTES)("%s", async (_name, call, method, path, body) => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await call();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(path);
    expect(init.method ?? "GET").toBe(method);
    expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(body);
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer adm");
  });
});
