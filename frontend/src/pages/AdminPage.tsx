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
  Input,
  Text,
  Title2,
  Title3,
} from "@fluentui/react-components";
import * as admin from "../api/admin";
import type { AdminQuestion, Bank, Checklist } from "../api/admin";

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

  useEffect(() => {
    if (authed) void refreshBanks();
  }, [authed, refreshBanks]);

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
