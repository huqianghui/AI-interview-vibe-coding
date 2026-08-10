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
import type { AdminQuestion, AiFoundryConfig, Bank, Checklist, ConfigOption } from "../api/admin";

export function AdminPage() {
  const [token, setToken] = useState(admin.getAdminToken());
  const [authed, setAuthed] = useState(Boolean(admin.getAdminToken()));
  const [error, setError] = useState<string | null>(null);

  const [banks, setBanks] = useState<Bank[]>([]);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [questions, setQuestions] = useState<AdminQuestion[]>([]);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);

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
      admin.setAdminToken(token.trim());
      await admin.listBanks(); // validate the token
      setAuthed(true);
    });

  const loadQuestions = (bankId: string) =>
    guard(async () => {
      setSelectedBank(bankId);
      setSelectedQuestion(null);
      setChecklist(null);
      setQuestions(await admin.listBankQuestions(bankId));
    });

  const loadChecklist = (questionId: string) =>
    guard(async () => {
      setSelectedQuestion(questionId);
      try {
        setChecklist(await admin.getChecklist(questionId));
      } catch {
        setChecklist(null); // none drafted yet
      }
    });

  if (!authed) {
    return (
      <div style={{ maxWidth: 420, margin: "0 auto", padding: 24 }}>
        <Title2 as="h1">Admin</Title2>
        <Body1 style={{ display: "block", margin: "12px 0" }}>
          Enter the admin token to edit question banks and checklists.
        </Body1>
        <Input
          type="password"
          value={token}
          placeholder="Admin bearer token"
          onChange={(_, d) => setToken(d.value)}
          style={{ width: "100%" }}
          data-testid="admin-token-input"
        />
        <div style={{ marginTop: 12 }}>
          <Button appearance="primary" onClick={onLogin} data-testid="admin-login">
            Sign in
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
                <Button appearance="subtle" onClick={() => loadChecklist(q.question_id)}>
                  {q.order_index + 1}. {q.text}
                </Button>
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

      {/* Checklist for the selected question */}
      {selectedQuestion && (
        <Card>
          <CardHeader header={<Title3>Checklist</Title3>} />
          {checklist ? (
            <>
              <Body1 style={{ display: "block" }}>
                Weights total: {checklist.weights_sum} — {checklist.items.length} items
              </Body1>
              <ul data-testid="checklist-items">
                {checklist.items.map((it, i) => (
                  <li key={i}>
                    <Text weight="semibold">[{it.kind}]</Text> {it.text} (w={it.weight})
                    {it.source_quote && <Text> — SOP: “{it.source_quote}”</Text>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Body1 style={{ display: "block", marginBottom: 8 }}>
              No checklist drafted for this question yet.
            </Body1>
          )}
          <Button
            appearance="primary"
            onClick={() =>
              guard(async () => {
                const c = await admin.draftChecklist(selectedQuestion);
                setChecklist(c);
              })
            }
          >
            {checklist ? "Re-draft from SOP" : "Draft from SOP"}
          </Button>
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
