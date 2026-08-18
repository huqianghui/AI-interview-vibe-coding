/**
 * Admin editor page (SPEC F2b/F3b) — the business-facing editor for question banks + checklists.
 *
 * Gated by the shared admin bearer token (entered here, kept in sessionStorage). One page with
 * three panels: banks (create / set-default), the selected bank's questions (add / edit / delete /
 * move), and the selected question's checklist (draft / edit item weights + text). Deliberately
 * utilitarian — this is an internal tool, not the candidate-facing demo surface.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Dropdown,
  Input,
  Option,
  Text,
  Title2,
  Title3,
} from "@fluentui/react-components";
import * as admin from "../api/admin";
import type {
  AdminQuestion,
  AiFoundryConfig,
  Bank,
  Checklist,
  ChecklistItem,
  ConfigOption,
} from "../api/admin";
import * as auth from "../api/auth";

export function AdminPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(Boolean(auth.getToken()));
  const [error, setError] = useState<string | null>(null);

  const [banks, setBanks] = useState<Bank[]>([]);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [questions, setQuestions] = useState<AdminQuestion[]>([]);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  // Working copy of the checklist's items while editing (F3b). Seeded from `checklist` on load and
  // on (re)generate; saved back via editChecklistItems, which re-normalizes weights to 100.
  const [editItems, setEditItems] = useState<ChecklistItem[]>([]);

  const [newBankName, setNewBankName] = useState("");
  const [newQuestionText, setNewQuestionText] = useState("");

  // Azure AI Foundry config (runtime source of truth). api_key is write-only; masked on load.
  const [cfg, setCfg] = useState<AiFoundryConfig | null>(null);
  const [cfgEndpoint, setCfgEndpoint] = useState("");
  const [cfgProject, setCfgProject] = useState("");
  const [cfgModel, setCfgModel] = useState("");
  const [cfgKb, setCfgKb] = useState("");
  const [cfgKs, setCfgKs] = useState("");
  const [cfgKey, setCfgKey] = useState("");
  const [cfgStatus, setCfgStatus] = useState<string | null>(null);
  // Options pulled from the real Foundry resource; empty until "Load options" fetches them.
  const [modelOptions, setModelOptions] = useState<ConfigOption[]>([]);
  const [kbOptions, setKbOptions] = useState<ConfigOption[]>([]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshBanks = useCallback(
    () => guard(async () => setBanks(await admin.listBanks())),
    [guard],
  );

  const refreshConfig = useCallback(
    () =>
      guard(async () => {
        const c = await admin.getAiFoundryConfig();
        setCfg(c);
        setCfgEndpoint(c.endpoint);
        setCfgProject(c.default_project);
        setCfgModel(c.model_or_deployment);
        setCfgKb(c.knowledge_base);
        setCfgKs(c.knowledge_source);
        setCfgKey(""); // never prefill the (masked) key; empty = keep existing
      }),
    [guard],
  );

  // Pull the real model deployments + knowledge bases from the saved Foundry resource.
  const loadOptions = () =>
    guard(async () => {
      setCfgStatus(null);
      const [models, kbs] = await Promise.all([
        admin.listModelDeployments(),
        admin.listKnowledgeBases(),
      ]);
      setModelOptions(models);
      setKbOptions(kbs);
      setCfgStatus(
        `Loaded ${models.length} model(s), ${kbs.length} knowledge base(s).`,
      );
    });

  useEffect(() => {
    if (authed) {
      void refreshBanks();
      void refreshConfig();
    }
  }, [authed, refreshBanks, refreshConfig]);

  const onLogin = () =>
    guard(async () => {
      await auth.login(username.trim(), password);
      const user = await auth.me();
      if (!user || user.role !== "admin") {
        auth.clearToken();
        throw new Error("需要管理员权限");
      }
      setAuthed(true);
    });

  const loadQuestions = (bankId: string) =>
    guard(async () => {
      setSelectedBank(bankId);
      setSelectedQuestion(null);
      adoptChecklist(null);
      setQuestions(await admin.listBankQuestions(bankId));
    });

  // Adopt a freshly loaded/generated/saved checklist as both the display + edit state.
  const adoptChecklist = (c: Checklist | null) => {
    setChecklist(c);
    setEditItems(c ? c.items.map((it) => ({ ...it })) : []);
  };

  const loadChecklist = (questionId: string) =>
    guard(async () => {
      setSelectedQuestion(questionId);
      try {
        adoptChecklist(await admin.getChecklist(questionId));
      } catch {
        adoptChecklist(null); // none drafted yet
      }
    });

  const KINDS = ["required", "recommended", "forbidden"] as const;

  const setItem = (idx: number, patch: Partial<ChecklistItem>) =>
    setEditItems((items) => items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const removeItem = (idx: number) =>
    setEditItems((items) => items.filter((_, i) => i !== idx));

  const addItem = () =>
    setEditItems((items) => [
      ...items,
      {
        kind: "required",
        text: "",
        weight: 0,
        source_quote: "",
        source_page: null,
        order_index: items.length,
      },
    ]);

  // Persist edited items. Backend re-normalizes weights to 100 (forbidden → 0), drops invalid
  // kinds, and returns the saved checklist — adopt it so the editor round-trips (save → reload).
  const saveChecklist = () =>
    guard(async () => {
      if (!checklist) return;
      const payload = editItems.map(({ kind, text, weight, source_quote, source_page }) => ({
        kind,
        text,
        weight,
        source_quote,
        source_page,
      }));
      adoptChecklist(await admin.editChecklistItems(checklist.checklist_id, payload));
    });

  // (Re)generate a checklist from the question via AI, then refresh the question list so the
  // rubric-status marker reflects the new item count.
  const generateChecklist = () =>
    guard(async () => {
      if (!selectedQuestion) return;
      adoptChecklist(await admin.draftChecklist(selectedQuestion));
      if (selectedBank) setQuestions(await admin.listBankQuestions(selectedBank));
    });

  // Live weight total of the working copy (forbidden items count as their entered weight in the
  // preview; the backend zeros them on save). Purely informational — save re-normalizes to 100.
  const editWeightsSum = editItems.reduce((sum, it) => sum + (it.weight || 0), 0);

  if (!authed) {
    return (
      <div style={{ maxWidth: 420, margin: "0 auto", padding: 24 }}>
        <Title2 as="h1">Admin 登录</Title2>
        <Body1 style={{ display: "block", margin: "12px 0" }}>
          用管理员账号登录以编辑题库、清单与配置。
        </Body1>
        <Input
          value={username}
          placeholder="用户名"
          onChange={(_, d) => setUsername(d.value)}
          style={{ width: "100%", marginBottom: 8 }}
          data-testid="admin-username-input"
        />
        <Input
          type="password"
          value={password}
          placeholder="密码"
          onChange={(_, d) => setPassword(d.value)}
          onKeyDown={(e) => e.key === "Enter" && onLogin()}
          style={{ width: "100%" }}
          data-testid="admin-password-input"
        />
        <div style={{ marginTop: 12 }}>
          <Button appearance="primary" onClick={onLogin} data-testid="admin-login">
            登录
          </Button>
        </div>
        {error && (
          <Body1 role="alert" style={{ display: "block", marginTop: 12, color: "#b00" }}>
            {error}
          </Body1>
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, display: "grid", gap: 20 }}>
      <Title2 as="h1">Admin — question banks & checklists</Title2>

      {/* Azure AI Foundry config — the runtime source of truth (DB > .env > default) */}
      <Card>
        <CardHeader header={<Title3>Azure AI Foundry connection</Title3>} />
        <Body1 style={{ display: "block", marginBottom: 8 }}>
          Saved here and used at runtime — overrides <code>.env</code>. The API key is write-only;
          leave it blank to keep the existing key.
        </Body1>
        <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
          <Input
            value={cfgEndpoint}
            placeholder="Endpoint (https://…services.ai.azure.com)"
            onChange={(_, d) => setCfgEndpoint(d.value)}
            data-testid="cfg-endpoint"
          />
          <Input
            value={cfgProject}
            placeholder="Default project"
            onChange={(_, d) => setCfgProject(d.value)}
            data-testid="cfg-project"
          />
          <Input
            type="password"
            value={cfgKey}
            placeholder={
              cfg?.masked_key ? `API key (saved: ${cfg.masked_key})` : "API key"
            }
            onChange={(_, d) => setCfgKey(d.value)}
            data-testid="cfg-key"
          />
          <Button data-testid="cfg-load-options" onClick={loadOptions}>
            Load models & knowledge bases
          </Button>

          {/* Model: dropdown once options are loaded, else a text input fallback. */}
          {modelOptions.length > 0 ? (
            <Dropdown
              aria-label="Model deployment"
              data-testid="cfg-model-dropdown"
              selectedOptions={cfgModel ? [cfgModel] : []}
              value={cfgModel}
              onOptionSelect={(_, d) => setCfgModel(d.optionValue ?? "")}
            >
              {modelOptions.map((o) => (
                <Option key={o.value} value={o.value}>
                  {o.label}
                </Option>
              ))}
            </Dropdown>
          ) : (
            <Input
              value={cfgModel}
              placeholder="Model / deployment (e.g. gpt-4o-mini) — or Load options above"
              onChange={(_, d) => setCfgModel(d.value)}
              data-testid="cfg-model"
            />
          )}

          {/* Knowledge base: dropdown once loaded, else text input. */}
          {kbOptions.length > 0 ? (
            <Dropdown
              aria-label="Knowledge base"
              data-testid="cfg-kb-dropdown"
              selectedOptions={cfgKb ? [cfgKb] : []}
              value={cfgKb}
              onOptionSelect={(_, d) => setCfgKb(d.optionValue ?? "")}
            >
              {kbOptions.map((o) => (
                <Option key={o.value} value={o.value}>
                  {o.label}
                </Option>
              ))}
            </Dropdown>
          ) : (
            <Input
              value={cfgKb}
              placeholder="Foundry IQ knowledge base — or Load options above"
              onChange={(_, d) => setCfgKb(d.value)}
              data-testid="cfg-kb"
            />
          )}
          <Input
            value={cfgKs}
            placeholder="Knowledge source name (≠ knowledge base)"
            onChange={(_, d) => setCfgKs(d.value)}
            data-testid="cfg-ks"
          />

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              appearance="primary"
              data-testid="cfg-save"
              onClick={() =>
                guard(async () => {
                  setCfgStatus(null);
                  await admin.updateAiFoundryConfig({
                    endpoint: cfgEndpoint.trim(),
                    api_key: cfgKey,
                    default_project: cfgProject.trim(),
                    model_or_deployment: cfgModel.trim(),
                    knowledge_base: cfgKb.trim(),
                    knowledge_source: cfgKs.trim(),
                  });
                  setCfgStatus("Saved.");
                  await refreshConfig();
                })
              }
            >
              Save
            </Button>
            <Button
              data-testid="cfg-test"
              onClick={() =>
                guard(async () => {
                  const r = await admin.testAiFoundryConfig();
                  setCfgStatus(r.message);
                })
              }
            >
              Test connection
            </Button>
            {cfgStatus && (
              <Text data-testid="cfg-status">{cfgStatus}</Text>
            )}
          </div>
        </div>
      </Card>

      {/* Banks */}
      <Card>
        <CardHeader header={<Title3>Question banks</Title3>} />
        <ul data-testid="bank-list">
          {banks.map((b) => (
            <li key={b.bank_id}>
              <Button appearance="subtle" onClick={() => loadQuestions(b.bank_id)}>
                {b.name}
              </Button>
              {b.is_default ? <Text> (default)</Text> : (
                <Button size="small" onClick={() => guard(async () => {
                  await admin.setDefaultBank(b.bank_id);
                  await refreshBanks();
                })}>
                  Make default
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div style={{ display: "flex", gap: 8 }}>
          <Input
            value={newBankName}
            placeholder="New bank name"
            onChange={(_, d) => setNewBankName(d.value)}
          />
          <Button
            onClick={() =>
              guard(async () => {
                if (!newBankName.trim()) return;
                await admin.createBank(newBankName.trim(), banks.length === 0);
                setNewBankName("");
                await refreshBanks();
              })
            }
          >
            Add bank
          </Button>
        </div>
      </Card>

      {/* Questions in the selected bank */}
      {selectedBank && (
        <Card>
          <CardHeader header={<Title3>Questions</Title3>} />
          <ul data-testid="question-list">
            {questions.map((q, i) => (
              <li key={q.question_id} style={{ marginBottom: 6 }}>
                <Text>
                  {q.order_index + 1}. {q.text}
                </Text>{" "}
                <Button
                  size="small"
                  appearance={selectedQuestion === q.question_id ? "primary" : "secondary"}
                  onClick={() => loadChecklist(q.question_id)}
                  data-testid={`rubric-btn-${q.question_id}`}
                >
                  评分标准 / Rubric
                </Button>{" "}
                <Text
                  size={200}
                  data-testid={`rubric-status-${q.question_id}`}
                  style={{ color: q.checklist_item_count > 0 ? "#0a7d24" : "#9a6a00" }}
                >
                  {q.checklist_item_count > 0
                    ? `✓ ${q.checklist_item_count} 项 / items`
                    : "⚙ 未配评分 / not configured"}
                </Text>{" "}
                <Button
                  size="small"
                  disabled={i === 0}
                  onClick={() =>
                    guard(async () => {
                      const ids = questions.map((x) => x.question_id);
                      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                      await admin.reorderQuestions(selectedBank, ids);
                      await loadQuestions(selectedBank);
                    })
                  }
                >
                  ↑
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    guard(async () => {
                      await admin.deleteQuestion(q.question_id);
                      await loadQuestions(selectedBank);
                    })
                  }
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8 }}>
            <Input
              value={newQuestionText}
              placeholder="New question text"
              onChange={(_, d) => setNewQuestionText(d.value)}
              style={{ flex: 1 }}
            />
            <Button
              onClick={() =>
                guard(async () => {
                  if (!newQuestionText.trim()) return;
                  await admin.addBankQuestion(selectedBank, newQuestionText.trim(), []);
                  setNewQuestionText("");
                  await loadQuestions(selectedBank);
                })
              }
            >
              Add question
            </Button>
          </div>
        </Card>
      )}

      {/* Checklist (scoring rubric) for the selected question — editable (F3b) */}
      {selectedQuestion && (
        <Card>
          <CardHeader header={<Title3>评分标准 / Scoring rubric</Title3>} />
          {checklist ? (
            <>
              <Body1 style={{ display: "block", marginBottom: 8 }}>
                权重合计 / Weights total: {editWeightsSum} — {editItems.length} 项 / items
                {editWeightsSum !== 100 && (
                  <Text data-testid="checklist-weights-hint" style={{ color: "#9a6a00" }}>
                    {" "}
                    （保存后按 100 归一 / re-normalized to 100 on save）
                  </Text>
                )}
              </Body1>
              <ul data-testid="checklist-items" style={{ listStyle: "none", padding: 0 }}>
                {editItems.map((it, i) => (
                  <li
                    key={i}
                    style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}
                  >
                    <Dropdown
                      aria-label="Rubric item kind"
                      data-testid={`checklist-kind-${i}`}
                      selectedOptions={[it.kind]}
                      value={it.kind}
                      style={{ minWidth: 150 }}
                      onOptionSelect={(_, d) => setItem(i, { kind: d.optionValue ?? "required" })}
                    >
                      {KINDS.map((k) => (
                        <Option key={k} value={k}>
                          {k}
                        </Option>
                      ))}
                    </Dropdown>
                    <Input
                      value={it.text}
                      placeholder="评分要点 / rubric item text"
                      data-testid={`checklist-text-${i}`}
                      onChange={(_, d) => setItem(i, { text: d.value })}
                      style={{ flex: 1 }}
                    />
                    <Input
                      type="number"
                      value={String(it.weight)}
                      data-testid={`checklist-weight-${i}`}
                      onChange={(_, d) => setItem(i, { weight: Number(d.value) || 0 })}
                      style={{ width: 80 }}
                    />
                    <Button
                      size="small"
                      data-testid={`checklist-remove-${i}`}
                      onClick={() => removeItem(i)}
                    >
                      删除 / Delete
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Body1 style={{ display: "block", marginBottom: 8 }}>
              这道题还没有评分标准。点“重新生成 / Generate (AI)”从题目自动起草，或手动添加条目。
              <br />
              No rubric for this question yet — generate one from the question, or add items manually.
            </Body1>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <Button data-testid="checklist-add-item" onClick={addItem}>
              添加一条 / Add item
            </Button>
            {checklist && (
              <Button
                appearance="primary"
                data-testid="checklist-save"
                onClick={saveChecklist}
              >
                保存 / Save
              </Button>
            )}
            <Button data-testid="checklist-generate" onClick={generateChecklist}>
              重新生成 / Generate (AI)
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <Body1 role="alert" style={{ display: "block", color: "#b00" }}>
          {error}
        </Body1>
      )}
    </div>
  );
}
