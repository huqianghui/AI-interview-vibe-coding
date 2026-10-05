/**
 * Admin editor page (SPEC F2b/F3b) — the business-facing editor for question banks + checklists.
 *
 * Gated by the shared admin bearer token (entered here, kept in sessionStorage). After sign-in the
 * page is a two-tab workspace:
 *   • "Content" tab — banks (create / set-default), the selected bank's questions
 *     (add / delete / move), and, inline under the selected question, its scoring rubric
 *     (draft / edit item kind + text + weight / regenerate). The rubric hangs off the selected
 *     question, so it lives as an inline panel here rather than its own tab.
 *   • "Connection" tab — the AI Foundry runtime config (endpoint / key / model / KB),
 *     which is low-frequency setup, kept out of the daily content-editing path.
 * A top bar links across to the digital-human persona editor (/admin/agent).
 *
 * Styling follows the project baseline (Fluent `makeStyles` + `tokens`, as in InterviewPage) rather
 * than ad-hoc inline styles, so spacing / radius / color / elevation stay consistent.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Dropdown,
  Input,
  Option,
  Spinner,
  Switch,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import * as admin from "../api/admin";
import { BoundedIntInput } from "../components/BoundedIntInput";
import type {
  AdminQuestion,
  AdminUser,
  AiFoundryConfig,
  Bank,
  Checklist,
  ChecklistItem,
  ConfigOption,
  ExternalConfig,
} from "../api/admin";
import * as auth from "../api/auth";
import { AppShell } from "../components/AppShell";
import { LoginCard } from "../components/LoginCard";

const useStyles = makeStyles({
  // Width and padding moved to AppShell (one measure per route). What is left is the stack.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
  },
  // Top bar: page title on the left, cross-navigation to the persona editor on the right.
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalL,
    flexWrap: "wrap",
  },
  navLink: { textDecoration: "none" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  fieldGrid: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxWidth: "560px",
  },
  list: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  // A bank / question row: label on the left, an aligned action cluster on the right.
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  rowText: { flex: 1, minWidth: "200px" },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  addRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  emptyState: { color: tokens.colorNeutralForeground3 },
  hintOk: { color: tokens.colorPaletteGreenForeground1 },
  hintWarn: { color: tokens.colorPaletteYellowForeground2 },
  // Weight-total bar under the rubric editor: fills to min(sum,100)%, green at 100 else amber.
  weightBar: {
    position: "relative",
    height: "6px",
    width: "100%",
    maxWidth: "320px",
    borderRadius: tokens.borderRadiusCircular,
    background: tokens.colorNeutralBackground3,
    overflow: "hidden",
  },
  weightBarFill: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    transition: "width 200ms ease, background 200ms ease",
  },
  checklistItem: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  checklistItemRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  // Read-only SOP citation under an item (admin-only surface, P3 allows it here).
  sourceQuote: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
  errorText: { color: tokens.colorPaletteRedForeground1 },
});

// Kind → Badge color, so required / recommended / forbidden read at a glance.
const KIND_COLOR: Record<string, "danger" | "success" | "warning" | "informative"> = {
  required: "success",
  recommended: "informative",
  forbidden: "danger",
};

export function AdminPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const [authed, setAuthed] = useState(false);
  // A residual token in sessionStorage is NOT proof of a live session (it may be expired, or signed
  // with a rotated secret_key). Start in a "checking" state whenever a token exists so we validate
  // it via me() before rendering the admin UI — otherwise we'd fire protected requests with a stale
  // token and get a wall of 401s while the page pretends we're logged in.
  const [authChecking, setAuthChecking] = useState(Boolean(auth.getToken()));
  // LoginCard's `busy` prop — this page's guard() has no busy concept of its own (unlike
  // InterviewPage's), so the login flow tracks it separately just for the card's disabled state.
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"content" | "connection" | "users">("content");

  const [banks, setBanks] = useState<Bank[]>([]);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [questions, setQuestions] = useState<AdminQuestion[]>([]);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  // Working copy of the checklist's items while editing (F3b). Seeded from `checklist` on load and
  // on (re)generate; saved back via editChecklistItems, which re-normalizes weights to 100.
  const [editItems, setEditItems] = useState<ChecklistItem[]>([]);
  const [checklistStatus, setChecklistStatus] = useState<string | null>(null);

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
  // The Voice Live SESSION model — a separate setting from the inference model above, because the
  // legal values differ: Voice Live MODEL mode accepts only models it hosts natively in the region,
  // while judge/scoring/the agent address models by deployment name. `cfgVoiceByom` off = platform
  // native (path ①); on = your own deployment via a profile (path ②).
  const [cfgVoiceModel, setCfgVoiceModel] = useState("");
  const [cfgVoiceByom, setCfgVoiceByom] = useState(false);
  const [cfgVoiceProfile, setCfgVoiceProfile] = useState<string>(admin.DEFAULT_BYOM_PROFILE);
  // Options pulled from the real Foundry resource; empty until "Load options" fetches them.
  const [modelOptions, setModelOptions] = useState<ConfigOption[]>([]);
  const [voiceModelOptions, setVoiceModelOptions] = useState<ConfigOption[]>([]);
  const [probing, setProbing] = useState(false);
  const [kbOptions, setKbOptions] = useState<ConfigOption[]>([]);

  // External interview API/server config (Phase 2, vendor-neutral). Resolved live from the DB on
  // every turn (DB > .env), so a save takes effect on the next interview — no restart. The key is
  // write-only on load (masked); a separate reveal call fetches the plaintext on a deliberate click.
  const [extCfg, setExtCfg] = useState<ExternalConfig | null>(null);
  const [extEndpoint, setExtEndpoint] = useState("");
  const [extUserTag, setExtUserTag] = useState("");
  const [extKey, setExtKey] = useState("");
  const [extStatus, setExtStatus] = useState<string | null>(null);
  // null = hidden; a string = the revealed plaintext key (shown read-only, never in the edit field).
  const [extRevealed, setExtRevealed] = useState<string | null>(null);

  // Users tab (#102, read-only per the eng review): one shared account per candidate seat, so an
  // admin can hand out the seeded username/password — not an account-management screen.
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);

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
        setCfgVoiceModel(c.voice_model ?? "");
        setCfgVoiceByom((c.voice_model_mode ?? "native") === "byom");
        setCfgVoiceProfile(c.voice_byom_profile || admin.DEFAULT_BYOM_PROFILE);
        setCfgKb(c.knowledge_base);
        setCfgKs(c.knowledge_source);
        setCfgKey(""); // never prefill the (masked) key; empty = keep existing
      }),
    [guard],
  );

  const refreshExternalConfig = useCallback(
    () =>
      guard(async () => {
        const c = await admin.getExternalConfig();
        setExtCfg(c);
        setExtEndpoint(c.endpoint);
        setExtUserTag(c.user_tag);
        setExtKey(""); // never prefill the (masked) key; empty = keep existing
        setExtRevealed(null);
      }),
    [guard],
  );

  // Pull the real model deployments + knowledge bases from the saved Foundry resource, plus the
  // native Voice Live models this REGION actually accepts (measured by real connections — no API
  // lists them and the docs table runs ahead of rollout, so this is the only trustworthy source).
  const loadOptions = () =>
    guard(async () => {
      setCfgStatus(null);
      setProbing(true);
      try {
        const [models, kbs, voiceModels] = await Promise.all([
          admin.listModelDeployments(),
          admin.listKnowledgeBases(),
          admin.listVoiceLiveModels(),
        ]);
        setModelOptions(models);
        setKbOptions(kbs);
        setVoiceModelOptions(voiceModels);
        setCfgStatus(
          `Loaded ${models.length} deployment(s), ${voiceModels.length} native voice model(s), ` +
            `${kbs.length} knowledge base(s).`,
        );
      } finally {
        setProbing(false);
      }
    });

  // Re-measure the region's native list. The cached answer is ~6h old at worst; this forces a fresh
  // sweep (measured ~10s for 23 candidates) for when a model has just rolled out to the region.
  const reprobeVoiceModels = () =>
    guard(async () => {
      setCfgStatus(null);
      setProbing(true);
      try {
        const voiceModels = await admin.listVoiceLiveModels(true);
        setVoiceModelOptions(voiceModels);
        setCfgStatus(`Re-probed: ${voiceModels.length} native voice model(s) accepted here.`);
      } finally {
        setProbing(false);
      }
    });

  // ONE payload builder for both save buttons (Save and Clear key). They used to spell the body out
  // twice, which is how a newly added field gets silently reset by the path that forgot it.
  const foundryPayload = (extra: Partial<admin.AiFoundryConfigInput> = {}) => ({
    endpoint: cfgEndpoint.trim(),
    api_key: cfgKey,
    default_project: cfgProject.trim(),
    model_or_deployment: cfgModel.trim(),
    voice_model: cfgVoiceModel.trim(),
    voice_model_mode: cfgVoiceByom ? "byom" : "native",
    voice_byom_profile: cfgVoiceByom ? cfgVoiceProfile : "",
    knowledge_base: cfgKb.trim(),
    knowledge_source: cfgKs.trim(),
    ...extra,
  });

  // On mount, validate any residual token before trusting it. me() clears the token on a 401, so a
  // failed check drops us to the login form instead of hammering the admin API with a dead bearer.
  useEffect(() => {
    if (!authChecking) return;
    let cancelled = false;
    void (async () => {
      const user = await auth.me();
      if (cancelled) return;
      if (user && user.role === "admin") setAuthed(true);
      else auth.clearToken();
      setAuthChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authChecking]);

  useEffect(() => {
    if (authed) {
      void refreshBanks();
      void refreshConfig();
      void refreshExternalConfig();
    }
  }, [authed, refreshBanks, refreshConfig, refreshExternalConfig]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      setUsers(await admin.listUsers());
    } catch (e) {
      setUsersError(e instanceof Error ? e.message : String(e));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed && tab === "users") void loadUsers();
  }, [authed, tab, loadUsers]);

  const copyPassword = (userId: string, generatedPassword: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(generatedPassword).then(() => {
        setCopiedUserId(userId);
      });
    }
  };

  const onLogin = (username: string, password: string) => {
    setLoginBusy(true);
    void guard(async () => {
      await auth.login(username, password);
      const user = await auth.me();
      if (!user || user.role !== "admin") {
        auth.clearToken();
        throw new Error(t("admin.errAdminRequired"));
      }
      setAuthed(true);
    }).finally(() => setLoginBusy(false));
  };

  // Adopt a freshly loaded/generated/saved checklist as both the display + edit state.
  const adoptChecklist = (c: Checklist | null) => {
    setChecklist(c);
    setEditItems(c ? c.items.map((it) => ({ ...it })) : []);
  };

  const loadQuestions = (bankId: string) =>
    guard(async () => {
      setSelectedBank(bankId);
      setSelectedQuestion(null);
      adoptChecklist(null);
      setChecklistStatus(null);
      setQuestions(await admin.listBankQuestions(bankId));
    });

  const loadChecklist = (questionId: string) =>
    guard(async () => {
      setSelectedQuestion(questionId);
      setChecklistStatus(null);
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
      setChecklistStatus(t("admin.saved"));
    });

  // (Re)generate a checklist from the question via AI, then refresh the question list so the
  // rubric-status marker reflects the new item count.
  const generateChecklist = () =>
    guard(async () => {
      if (!selectedQuestion) return;
      adoptChecklist(await admin.draftChecklist(selectedQuestion));
      setChecklistStatus(t("admin.generated"));
      if (selectedBank) setQuestions(await admin.listBankQuestions(selectedBank));
    });

  // Live weight total of the working copy (forbidden items count as their entered weight in the
  // preview; the backend zeros them on save). Purely informational — save re-normalizes to 100.
  const editWeightsSum = editItems.reduce((sum, it) => sum + (it.weight || 0), 0);

  if (authChecking) {
    return (
      <AppShell measure="narrow">
        <Body1>{t("admin.checkingAuth")}</Body1>
      </AppShell>
    );
  }

  if (!authed) {
    return (
      <AppShell measure="narrow">
        <LoginCard
          title={t("admin.loginTitle")}
          body={t("admin.loginBody")}
          error={error}
          busy={loginBusy}
          onSubmit={onLogin}
          testIdPrefix="admin"
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className={styles.page}>
      <div className={styles.topBar}>
        {/* h2, not h1: AppShell's header band carries the app wordmark as the page's only h1. */}
        <Title2 as="h2">{t("admin.pageTitle")}</Title2>
        <Link to="/admin/agent" className={styles.navLink} data-testid="admin-nav-agent">
          <Button appearance="secondary">{t("admin.navAgent")}</Button>
        </Link>
      </div>

      <TabList
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as "content" | "connection" | "users")}
      >
        <Tab value="content" data-testid="admin-tab-content">
          {t("admin.tabContent")}
        </Tab>
        <Tab value="connection" data-testid="admin-tab-connection">
          {t("admin.tabConnection")}
        </Tab>
        <Tab value="users" data-testid="admin-tab-users">
          {t("admin.users.tab")}
        </Tab>
      </TabList>

      {tab === "content" && (
        <>
          {/* Banks */}
          <Card className={styles.card}>
            <CardHeader header={<Title3>{t("admin.banksTitle")}</Title3>} />
            <ul className={styles.list} data-testid="bank-list">
              {banks.map((b) => (
                <li key={b.bank_id} className={styles.row}>
                  <Button
                    className={styles.rowText}
                    appearance="subtle"
                    style={{ justifyContent: "flex-start" }}
                    onClick={() => loadQuestions(b.bank_id)}
                  >
                    {b.name}
                  </Button>
                  <div className={styles.actions}>
                    {b.is_default ? (
                      <Badge appearance="tint" color="brand">
                        {t("admin.defaultBadge")}
                      </Badge>
                    ) : (
                      <Button
                        size="small"
                        onClick={() =>
                          guard(async () => {
                            await admin.setDefaultBank(b.bank_id);
                            await refreshBanks();
                          })
                        }
                      >
                        {t("admin.makeDefault")}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className={styles.addRow}>
              <Input
                value={newBankName}
                placeholder={t("admin.newBankPlaceholder")}
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
                {t("admin.addBank")}
              </Button>
            </div>
          </Card>

          {/* Questions in the selected bank */}
          {selectedBank ? (
            <Card className={styles.card}>
              <CardHeader header={<Title3>{t("admin.questionsTitle")}</Title3>} />
              <ul className={styles.list} data-testid="question-list">
                {questions.map((q, i) => (
                  <li key={q.question_id} className={styles.row}>
                    <div className={styles.rowText}>
                      <Text weight="semibold">{q.order_index + 1}.</Text> <Text>{q.text}</Text>
                      <br />
                      <Text
                        size={200}
                        data-testid={`rubric-status-${q.question_id}`}
                        className={q.checklist_item_count > 0 ? styles.hintOk : styles.hintWarn}
                      >
                        {q.checklist_item_count > 0
                          ? t("admin.rubricItems", { count: q.checklist_item_count })
                          : t("admin.rubricNotConfigured")}
                      </Text>
                    </div>
                    <div className={styles.actions}>
                      {/* Max follow-ups (issue #114): RETIRED as a behaviour since 2026-09-28 — the
                          judge only nudges, it never asks a follow-up or redirects, in every turn
                          mode. The field stays (stored per question, no migration) but has no effect;
                          the hint says so. Linear mode never followed up (a submit always advances,
                          v0.39.2.0). */}
                      <Text size={200} title={t("admin.maxFollowUpsHint")}>
                        {t("admin.maxFollowUps")}
                      </Text>
                      <BoundedIntInput
                        size="small"
                        value={q.max_follow_ups}
                        min={0}
                        max={3}
                        aria-label={t("admin.maxFollowUps")}
                        onCommit={async (v) => {
                          await admin.editQuestion(q.question_id, { max_follow_ups: v });
                          if (selectedBank) setQuestions(await admin.listBankQuestions(selectedBank));
                        }}
                        data-testid={`max-follow-ups-${q.question_id}`}
                      />
                      <Button
                        size="small"
                        appearance={selectedQuestion === q.question_id ? "primary" : "secondary"}
                        onClick={() => loadChecklist(q.question_id)}
                        data-testid={`rubric-btn-${q.question_id}`}
                      >
                        {t("admin.rubricBtn")}
                      </Button>
                      <Button
                        size="small"
                        disabled={i === 0}
                        aria-label={t("admin.moveUp")}
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
                        {t("admin.delete")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className={styles.addRow}>
                <Input
                  value={newQuestionText}
                  placeholder={t("admin.newQuestionPlaceholder")}
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
                  {t("admin.addQuestion")}
                </Button>
              </div>
            </Card>
          ) : (
            <Card className={styles.card}>
              <Body1 className={styles.emptyState}>{t("admin.selectBankHint")}</Body1>
            </Card>
          )}

          {/* Checklist (scoring rubric) for the selected question — editable inline panel (F3b) */}
          {selectedQuestion && (
            <Card className={styles.card}>
              <CardHeader header={<Title3>{t("admin.rubricTitle")}</Title3>} />
              {checklist ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <Body1>
                      {t("admin.weightsTotal", {
                        sum: editWeightsSum,
                        count: editItems.length,
                      })}
                      {editWeightsSum !== 100 && (
                        <Text data-testid="checklist-weights-hint" className={styles.hintWarn}>
                          {t("admin.weightsHint")}
                        </Text>
                      )}
                    </Body1>
                    <div className={styles.weightBar}>
                      <div
                        className={styles.weightBarFill}
                        style={{
                          width: `${Math.min(editWeightsSum, 100)}%`,
                          background:
                            editWeightsSum === 100
                              ? tokens.colorPaletteGreenBackground3
                              : tokens.colorPaletteYellowBackground3,
                        }}
                      />
                    </div>
                  </div>
                  <ul className={styles.list} data-testid="checklist-items">
                    {editItems.map((it, i) => (
                      <li key={i} className={styles.checklistItem}>
                        <div className={styles.checklistItemRow}>
                          <Badge appearance="tint" color={KIND_COLOR[it.kind] ?? "informative"}>
                            {it.kind}
                          </Badge>
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
                            placeholder={t("admin.rubricItemPlaceholder")}
                            data-testid={`checklist-text-${i}`}
                            onChange={(_, d) => setItem(i, { text: d.value })}
                            style={{ flex: 1, minWidth: 200 }}
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
                            {t("admin.delete")}
                          </Button>
                        </div>
                        {it.source_quote && (
                          <Text size={200} className={styles.sourceQuote}>
                            “{it.source_quote}”
                            {it.source_page ? ` — ${it.source_page}` : ""}
                          </Text>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Body1 className={styles.emptyState}>{t("admin.noRubric")}</Body1>
              )}
              <div className={styles.addRow} style={{ marginTop: 4 }}>
                <Button data-testid="checklist-add-item" onClick={addItem}>
                  {t("admin.addItem")}
                </Button>
                {checklist && (
                  <Button appearance="primary" data-testid="checklist-save" onClick={saveChecklist}>
                    {t("admin.save")}
                  </Button>
                )}
                <Button data-testid="checklist-generate" onClick={generateChecklist}>
                  {t("admin.generateAi")}
                </Button>
                {checklistStatus && (
                  <Text data-testid="checklist-status" className={styles.hintOk}>
                    {checklistStatus}
                  </Text>
                )}
              </div>
            </Card>
          )}
        </>
      )}

      {tab === "connection" && (
        <>
        {/* Azure AI Foundry config — the runtime source of truth (DB > .env > default) */}
        <Card className={styles.card}>
          <CardHeader header={<Title3>Azure AI Foundry connection</Title3>} />
          <Body1>
            Saved here and used at runtime — overrides <code>.env</code>. The API key is optional:
            leave it blank to authenticate with Entra ID / Managed Identity (required for
            key-disabled resources); a saved key is used as fallback. The key is write-only; blank
            keeps the existing key.
          </Body1>
          <div className={styles.fieldGrid}>
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
                cfg?.masked_key
                  ? `API key (saved: ${cfg.masked_key})`
                  : "API key — optional (blank = Entra ID / Managed Identity)"
              }
              onChange={(_, d) => setCfgKey(d.value)}
              data-testid="cfg-key"
            />
            {/* Auth-mode line: make the effective credential visible — a saved key is easy to
                forget and reads like a requirement; keyless is the normal state on key-disabled
                resources. Clearing is a deliberate separate action (blank on Save = keep key). */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {cfg?.masked_key ? (
                <>
                  <Text data-testid="cfg-auth-mode">
                    API key saved ({cfg.masked_key}) — used as fallback; Entra ID / Managed
                    Identity is tried first.
                  </Text>
                  <Button
                    size="small"
                    data-testid="cfg-clear-key"
                    onClick={() =>
                      guard(async () => {
                        setCfgStatus(null);
                        await admin.updateAiFoundryConfig(
                          foundryPayload({ api_key: "", clear_api_key: true }),
                        );
                        setCfgKey("");
                        setCfgStatus("API key cleared — using Entra ID / Managed Identity.");
                        await refreshConfig();
                      })
                    }
                  >
                    Clear key
                  </Button>
                </>
              ) : (
                <Text data-testid="cfg-auth-mode">
                  No API key saved — authenticating with Entra ID / Managed Identity.
                </Text>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Button data-testid="cfg-load-options" onClick={loadOptions} disabled={probing}>
                Load models & knowledge bases
              </Button>
              {probing && <Spinner size="tiny" label="Probing the region…" />}
            </div>

            <Text weight="semibold">Inference model — judge, scoring, digital-human agent</Text>
            <Body1>
              A <strong>deployment</strong> in this resource: judge, scoring and the Foundry agent
              all address models by deployment name. Your own deployments are exactly right here.
            </Body1>

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
                placeholder="Model / deployment (e.g. gpt-5-mini) — or Load options above"
                onChange={(_, d) => setCfgModel(d.value)}
                data-testid="cfg-model"
              />
            )}

            {/* The Voice Live SESSION model — a separate setting, because its legal values are a
                different set. Keeping it in one field with the inference model is what produced
                "Model X is not supported in this region" on every voice session. */}
            <Text weight="semibold">Voice session model — Voice Live</Text>
            <Switch
              label="Use my own model (bring your own model)"
              checked={cfgVoiceByom}
              data-testid="cfg-voice-byom"
              onChange={(_, d) => {
                const byom = !!d.checked;
                setCfgVoiceByom(byom);
                // Switching to BYOM, the voice session runs on a deployment — the same kind of name
                // the inference model uses — so default to it rather than leaving a native model
                // name behind that this path would reject.
                const stale =
                  !cfgVoiceModel || voiceModelOptions.some((o) => o.value === cfgVoiceModel);
                if (byom && stale) setCfgVoiceModel(cfgModel.trim());
              }}
            />
            {cfgVoiceByom ? (
              <>
                <Body1>
                  The voice session connects to <strong>your deployment</strong>. Note the voice leg
                  never asks a model to think (it reads prepared text), so this changes the session
                  host and billing path, not interview behaviour.
                </Body1>
                <Dropdown
                  aria-label="BYOM profile"
                  data-testid="cfg-byom-profile"
                  selectedOptions={[cfgVoiceProfile]}
                  value={
                    admin.BYOM_PROFILES.find((pr) => pr.value === cfgVoiceProfile)?.label ??
                    cfgVoiceProfile
                  }
                  onOptionSelect={(_, d) =>
                    setCfgVoiceProfile(d.optionValue ?? admin.DEFAULT_BYOM_PROFILE)
                  }
                >
                  {admin.BYOM_PROFILES.map((pr) => (
                    <Option key={pr.value} value={pr.value} text={pr.label}>
                      {pr.label}
                    </Option>
                  ))}
                </Dropdown>
              </>
            ) : (
              <Body1 data-testid="cfg-voice-native-hint">
                The voice session runs on a model <strong>Azure hosts for Voice Live</strong> in this
                region. Those are not deployments in your resource, so judge / scoring / the agent
                cannot use them — <strong>these are two separate settings and both need a value</strong>.
              </Body1>
            )}
            {/* Native mode lists only models a real connection ACCEPTED here; BYOM mode lists your
                deployments. Either way the options are legal for the leg that uses them — and there
                is deliberately NO free-text box, since that is how an unsupported model got saved. */}
            {(cfgVoiceByom ? modelOptions : voiceModelOptions).length > 0 ? (
              <Dropdown
                aria-label="Voice session model"
                data-testid="cfg-voice-model-dropdown"
                selectedOptions={cfgVoiceModel ? [cfgVoiceModel] : []}
                value={cfgVoiceModel}
                onOptionSelect={(_, d) => setCfgVoiceModel(d.optionValue ?? "")}
              >
                {(cfgVoiceByom ? modelOptions : voiceModelOptions).map((o) => (
                  <Option key={o.value} value={o.value}>
                    {o.label}
                  </Option>
                ))}
              </Dropdown>
            ) : (
              <Caption1 data-testid="cfg-voice-model-empty">
                No options yet — use “Load models &amp; knowledge bases” above.
              </Caption1>
            )}
            {cfgVoiceModel &&
              !cfgVoiceByom &&
              voiceModelOptions.length > 0 &&
              !voiceModelOptions.some((o) => o.value === cfgVoiceModel) && (
                <Caption1 data-testid="cfg-voice-model-illegal">
                  “{cfgVoiceModel}” is not in this region’s accepted list — voice sessions will fail
                  with “not supported in this region”. Pick one above.
                </Caption1>
              )}
            {!cfgVoiceByom && (
              <Button
                size="small"
                onClick={reprobeVoiceModels}
                disabled={probing}
                data-testid="cfg-voice-reprobe"
              >
                Re-probe the region
              </Button>
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

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Button
                appearance="primary"
                data-testid="cfg-save"
                onClick={() =>
                  guard(async () => {
                    setCfgStatus(null);
                    const saved = await admin.updateAiFoundryConfig(foundryPayload());
                    // The backend live-checks a changed voice model before committing, so a
                    // region-rejected choice never gets here (it is a 422 surfaced by guard).
                    setCfgStatus(saved.voice_model_check || "Saved.");
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
              {cfgStatus && <Text data-testid="cfg-status">{cfgStatus}</Text>}
            </div>
          </div>
        </Card>

        {/* External interview API/server — Phase 2, vendor-neutral. Resolved live from the DB on
            every turn (DB > .env); a save takes effect on the next interview, no restart. */}
        <Card className={styles.card}>
          <CardHeader header={<Title3>External interview API</Title3>} />
          <Body1>
            The external interview server that drives personas set to the "External interview API"
            brain. Resolved at runtime — overrides <code>.env</code>. Must be an HTTPS endpoint. The
            API key is write-only; leave it blank to keep the existing key.
          </Body1>
          <div className={styles.fieldGrid}>
            <Input
              value={extEndpoint}
              placeholder="Endpoint (https://…)"
              onChange={(_, d) => setExtEndpoint(d.value)}
              data-testid="ext-endpoint"
            />
            <Input
              value={extUserTag}
              placeholder="User tag (per-deployment label, no PII) — optional"
              onChange={(_, d) => setExtUserTag(d.value)}
              data-testid="ext-user-tag"
            />
            <Input
              type="password"
              value={extKey}
              placeholder={extCfg?.masked_key ? `API key (saved: ${extCfg.masked_key})` : "API key"}
              onChange={(_, d) => setExtKey(d.value)}
              data-testid="ext-key"
            />

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Button
                appearance="primary"
                data-testid="ext-save"
                onClick={() =>
                  guard(async () => {
                    setExtStatus(null);
                    await admin.updateExternalConfig({
                      endpoint: extEndpoint.trim(),
                      api_key: extKey,
                      user_tag: extUserTag.trim(),
                    });
                    setExtStatus("Saved.");
                    await refreshExternalConfig();
                  })
                }
              >
                Save
              </Button>
              <Button
                data-testid="ext-test"
                onClick={() =>
                  guard(async () => {
                    const r = await admin.testExternalConfig();
                    setExtStatus(r.message);
                  })
                }
              >
                Test connection
              </Button>
              <Button
                data-testid="ext-reveal"
                onClick={() =>
                  guard(async () => {
                    if (extRevealed !== null) {
                      setExtRevealed(null);
                      return;
                    }
                    const r = await admin.revealExternalKey();
                    setExtRevealed(r.api_key || "(no key configured)");
                  })
                }
              >
                {extRevealed !== null ? "Hide key" : "Reveal key"}
              </Button>
              {extStatus && <Text data-testid="ext-status">{extStatus}</Text>}
            </div>
            {extRevealed !== null && (
              <Text data-testid="ext-revealed" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                {extRevealed}
              </Text>
            )}
          </div>
        </Card>
        </>
      )}

      {tab === "users" && (
        <Card className={styles.card} data-testid="users-tab">
          <CardHeader header={<Title3>{t("admin.users.tab")}</Title3>} />
          <div style={{ padding: "0 16px 16px" }}>
            <Body1 style={{ display: "block", marginBottom: 12 }}>{t("admin.users.hint")}</Body1>
            {usersLoading && <Text data-testid="users-loading">{t("admin.users.loading")}</Text>}
            {usersError && (
              <Body1 role="alert" className={styles.errorText} data-testid="users-error">
                {t("admin.users.loadError", { message: usersError })}
              </Body1>
            )}
            {!usersLoading && !usersError && (
              <Table data-testid="users-table">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t("admin.users.colUsername")}</TableHeaderCell>
                    <TableHeaderCell>{t("admin.users.colRole")}</TableHeaderCell>
                    <TableHeaderCell>{t("admin.users.colStatus")}</TableHeaderCell>
                    <TableHeaderCell>{t("admin.users.colPassword")}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow key={u.id} data-testid={`user-row-${u.username}`}>
                      <TableCell>{u.username}</TableCell>
                      <TableCell>{u.role}</TableCell>
                      <TableCell>
                        {u.is_active ? t("admin.users.statusActive") : t("admin.users.statusInactive")}
                      </TableCell>
                      <TableCell>
                        {u.password_stale ? (
                          <Text data-testid={`user-password-stale-${u.username}`}>
                            {t("admin.users.passwordStale")}
                          </Text>
                        ) : u.generated_password ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Text
                              style={{ fontFamily: "monospace" }}
                              data-testid={`user-password-${u.username}`}
                            >
                              {u.generated_password}
                            </Text>
                            <Button
                              size="small"
                              data-testid={`user-copy-${u.username}`}
                              onClick={() => copyPassword(u.id, u.generated_password as string)}
                            >
                              {copiedUserId === u.id ? t("admin.users.copied") : t("admin.users.copy")}
                            </Button>
                          </div>
                        ) : (
                          <Text data-testid={`user-password-not-viewable-${u.username}`}>
                            {t("admin.users.notViewable")}
                          </Text>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>
      )}

      {error && (
        <Body1 role="alert" className={styles.errorText}>
          {error}
        </Body1>
      )}
      </div>
    </AppShell>
  );
}
