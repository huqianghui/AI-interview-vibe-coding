/**
 * Admin editor page (SPEC F2b/F3b) — the business-facing editor for question banks + checklists.
 *
 * Gated by the admin's sign-in (JWT kept in sessionStorage, see api/auth.ts). After sign-in the
 * page is a three-tab workspace (each tab's state + view live in ./admin):
 *   • "Content" tab — banks (create / set-default), the selected bank's questions
 *     (add / delete / move), and, inline under the selected question, its scoring rubric
 *     (draft / edit item kind + text + weight / regenerate). The rubric hangs off the selected
 *     question, so it lives as an inline panel here rather than its own tab.
 *   • "Connection" tab — the AI Foundry runtime config (endpoint / key / model / KB) and the
 *     external interview API, low-frequency setup kept out of the daily content-editing path.
 *   • "Users" tab — the seeded candidate seats, read-only.
 * A top bar links across to the digital-human persona editor (/admin/agent).
 *
 * The tab hooks are called here, not inside the tabs, so a tab's state (a selected question, an
 * unsaved connection edit) survives switching to another tab and back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { Body1, Button, Tab, TabList, Title2 } from "@fluentui/react-components";
import * as auth from "../api/auth";
import { AppShell } from "../components/AppShell";
import { LoginCard } from "../components/LoginCard";
import { useAdminStyles } from "./admin/shared";
import { ConnectionTab } from "./admin/ConnectionTab";
import { ContentTab } from "./admin/ContentTab";
import { InterviewsTab } from "./admin/InterviewsTab";
import { JobsTab } from "./admin/JobsTab";
import { PerformanceTab } from "./admin/PerformanceTab";
import { SopTab } from "./admin/SopTab";
import { UsersTab } from "./admin/UsersTab";
import { useConnectionTab } from "./admin/useConnectionTab";
import { useInterviewsTab } from "./admin/useInterviewsTab";
import { useJobsTab } from "./admin/useJobsTab";
import { normalizeOperationId, usePerformanceTab } from "./admin/usePerformanceTab";
import { useSopTab } from "./admin/useSopTab";
import { useContentTab } from "./admin/useContentTab";
import { useUsersTab } from "./admin/useUsersTab";

type AdminTab = "content" | "sop" | "connection" | "users" | "results" | "jobs" | "performance";
const TABS: AdminTab[] = ["content", "sop", "connection", "users", "results", "jobs", "performance"];

export function AdminPage() {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const [authed, setAuthed] = useState(false);
  // A residual token in sessionStorage is NOT proof of a live session (it may be expired, or signed
  // with a rotated secret_key). Start in a "checking" state whenever a token exists so we validate
  // it via me() before rendering the admin UI — otherwise we'd fire protected requests with a stale
  // token and get a wall of 401s while the page pretends we're logged in.
  const [authChecking, setAuthChecking] = useState(Boolean(auth.getAdminToken()));
  // LoginCard's `busy` prop — this page's guard() has no busy concept of its own (unlike
  // InterviewPage's), so the login flow tracks it separately just for the card's disabled state.
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The tab (and the Performance tab's Operation id) live in the URL, so an admin can share
  // `/admin?tab=performance&op=<id>` with another admin.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab") as AdminTab | null;
  const [tab, setTabState] = useState<AdminTab>(
    urlTab && TABS.includes(urlTab) ? urlTab : "content",
  );
  const setTab = useCallback(
    (next: AdminTab, operationId?: string) => {
      setTabState(next);
      const params: Record<string, string> = { tab: next };
      if (operationId) params.op = operationId;
      setSearchParams(params, { replace: true });
    },
    [setSearchParams],
  );

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const content = useContentTab(guard);
  const connection = useConnectionTab(guard);
  const users = useUsersTab(authed && tab === "users");
  const results = useInterviewsTab(authed && tab === "results");
  const jobs = useJobsTab(authed && tab === "jobs");
  const sop = useSopTab(authed && tab === "sop");
  // The live round-trip check starts on any tab, so the Performance tab opens on its history.
  const performance = usePerformanceTab(authed && tab === "performance", authed);
  const { lookup: lookupOperation } = performance;
  const { refreshBanks } = content;
  const { refreshConfig, refreshExternalConfig } = connection;

  // On mount, validate any residual token before trusting it. me() clears the token on a 401, so a
  // failed check drops us to the login form instead of hammering the admin API with a dead bearer.
  useEffect(() => {
    if (!authChecking) return;
    let cancelled = false;
    void (async () => {
      const user = await auth.me();
      if (cancelled) return;
      if (user && user.role === "admin") setAuthed(true);
      else auth.clearAdminToken();
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

  // Arrived on `?op=<id>`: look it up once signed in.
  const urlOperation = searchParams.get("op");
  const lookedUpRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authed || tab !== "performance" || !urlOperation) return;
    if (lookedUpRef.current === urlOperation) return;
    lookedUpRef.current = urlOperation;
    void lookupOperation(urlOperation);
  }, [authed, tab, urlOperation, lookupOperation]);

  // A lookup (from the tab's own box or from Interview results) also goes into the URL.
  const lookupAndShare = (raw: string) => {
    const id = normalizeOperationId(raw);
    if (id) {
      lookedUpRef.current = id;
      setTab("performance", id);
    }
    void lookupOperation(raw);
  };
  const openInterview = (interviewId: string) => {
    setTab("results");
    void results.open(interviewId);
  };

  const onLogin = (username: string, password: string) => {
    setLoginBusy(true);
    void guard(async () => {
      await auth.login(username, password);
      const user = await auth.me();
      if (!user || user.role !== "admin") {
        auth.clearAdminToken();
        throw new Error(t("admin.errAdminRequired"));
      }
      setAuthed(true);
    }).finally(() => setLoginBusy(false));
  };

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
          onTabSelect={(_, d) => setTab(d.value as AdminTab)}
        >
          <Tab value="content" data-testid="admin-tab-content">
            {t("admin.tabContent")}
          </Tab>
          <Tab value="sop" data-testid="admin-tab-sop">
            {t("admin.sop.tab")}
          </Tab>
          <Tab value="connection" data-testid="admin-tab-connection">
            {t("admin.tabConnection")}
          </Tab>
          <Tab value="users" data-testid="admin-tab-users">
            {t("admin.users.tab")}
          </Tab>
          <Tab value="results" data-testid="admin-tab-results">
            {t("admin.results.tab")}
          </Tab>
          <Tab value="jobs" data-testid="admin-tab-jobs">
            {t("admin.jobs.tab")}
          </Tab>
          <Tab value="performance" data-testid="admin-tab-performance">
            {t("admin.performance.tab")}
          </Tab>
        </TabList>

        {tab === "content" && <ContentTab state={content} guard={guard} />}
        {tab === "sop" && <SopTab state={sop} />}
        {tab === "connection" && <ConnectionTab state={connection} guard={guard} />}
        {tab === "users" && <UsersTab state={users} />}
        {tab === "results" && (
          <InterviewsTab state={results} onOpenPerformance={lookupAndShare} />
        )}
        {tab === "jobs" && <JobsTab state={jobs} />}
        {tab === "performance" && (
          <PerformanceTab
            state={performance}
            onLookup={lookupAndShare}
            onOpenInterview={openInterview}
          />
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
