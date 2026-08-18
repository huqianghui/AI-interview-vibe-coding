/**
 * Agent editor page (SPEC F5, Phase 3) — Foundry-portal-style interviewer-persona editor.
 *
 * Login-gated like AdminPage (shared admin JWT in sessionStorage). A top-bar persona switcher
 * selects the persona; the left panel edits its definition; a gear-triggered drawer holds the
 * configuration rail; the center is a Playground preview. Save creates/updates the persona (backend
 * auto-syncs its Foundry agent); a `formInitialized` ref keeps a background list refresh from
 * clobbering in-progress edits.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Body1, Button, Input, Title2 } from "@fluentui/react-components";
import * as auth from "../api/auth";
import * as personas from "../api/personas";
import { AgentEditorLayout } from "../components/agent-editor/AgentEditorLayout";
import { PersonaSwitcher } from "../components/agent-editor/PersonaSwitcher";
import { AgentDefinitionPanel } from "../components/agent-editor/AgentDefinitionPanel";
import { PlaygroundPanel } from "../components/agent-editor/PlaygroundPanel";
import { ConfigurationRail } from "../components/agent-editor/ConfigurationRail";
import { DEFAULT_AVATAR_CHARACTER, DEFAULT_AVATAR_STYLE } from "../data/avatarCharacters";
import {
  EDITOR_LOCALES,
  emptyPersonaForm,
  formToPayload,
  personaToForm,
  type EditorLocale,
  type PersonaFormState,
} from "./agentEditorForm";

const NEW = "__new__";

export function AgentEditorPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(Boolean(auth.getToken()));
  const [error, setError] = useState<string | null>(null);

  const [list, setList] = useState<personas.PersonaOut[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [current, setCurrent] = useState<personas.PersonaOut | null>(null);
  const [form, setForm] = useState<PersonaFormState>(emptyPersonaForm());
  const [activeLocale, setActiveLocale] = useState<EditorLocale>(EDITOR_LOCALES[0]);
  const [status, setStatus] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const formInitialized = useRef(false);
  // Tracks the persona currently open so a slow background reconcile can't apply to a persona the
  // user has since switched away from.
  const openPersonaId = useRef<string | null>(null);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshList = useCallback(
    () => guard(async () => setList(await personas.listPersonas())),
    [guard],
  );

  useEffect(() => {
    if (authed) void refreshList();
  }, [authed, refreshList]);

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

  const isNew = selectedId === NEW;

  const selectPersona = (id: string) =>
    guard(async () => {
      setStatus(null);
      setSelectedId(id);
      openPersonaId.current = id;
      const p = await personas.getPersona(id);
      setCurrent(p);
      setForm(personaToForm(p));
      formInitialized.current = true;
      // Reconcile against the live Foundry agent in the background: an operator may have edited the
      // agent in the Portal (bumping its version/model) without syncing back to us. Fail-soft — a
      // reconcile error leaves the freshly-loaded persona in place. Only apply if the user hasn't
      // switched personas in the meantime.
      void personas
        .reconcilePersona(id)
        .then((pulled) => {
          if (openPersonaId.current !== id) return;
          setCurrent(pulled);
          setForm(personaToForm(pulled));
          setList((prev) => prev.map((row) => (row.id === pulled.id ? pulled : row)));
        })
        .catch(() => {});
    });

  const startNew = () => {
    setStatus(null);
    openPersonaId.current = null; // cancel any in-flight reconcile from a previously-open persona
    setSelectedId(NEW);
    setCurrent(null);
    setForm(emptyPersonaForm());
    formInitialized.current = true;
  };

  const patchForm = (patch: Partial<PersonaFormState>) => setForm((f) => ({ ...f, ...patch }));

  // Voice mode: on → ensure a character/style; off → clear both (voice-only orb).
  const toggleVoiceMode = (on: boolean) =>
    patchForm(
      on
        ? { character: DEFAULT_AVATAR_CHARACTER, style: DEFAULT_AVATAR_STYLE }
        : { character: "", style: "" },
    );

  const save = () =>
    guard(async () => {
      setStatus(null);
      const payload = formToPayload(form);
      const saved = isNew
        ? await personas.createPersona(payload)
        : await personas.updatePersona(selectedId!, payload);
      setStatus("Saved.");
      setCurrent(saved);
      setSelectedId(saved.id);
      setForm(personaToForm(saved));
      await refreshList();
    });

  const reset = () => {
    if (current) setForm(personaToForm(current));
    else setForm(emptyPersonaForm());
    setStatus(null);
  };

  const retrySync = () =>
    guard(async () => {
      if (!selectedId || isNew) return;
      setRetrying(true);
      try {
        const p = await personas.retrySyncPersona(selectedId);
        setCurrent(p);
        setSelectedId(p.id);
        await refreshList();
      } finally {
        setRetrying(false);
      }
    });

  if (!authed) {
    return (
      <div style={{ maxWidth: 420, margin: "0 auto", padding: 24 }}>
        <Title2 as="h1">Agent editor 登录</Title2>
        <Body1 style={{ display: "block", margin: "12px 0" }}>用管理员账号登录以编辑面试官 agent。</Body1>
        <Input
          value={username}
          placeholder="用户名"
          onChange={(_, d) => setUsername(d.value)}
          style={{ width: "100%", marginBottom: 8 }}
          data-testid="agent-username-input"
        />
        <Input
          type="password"
          value={password}
          placeholder="密码"
          onChange={(_, d) => setPassword(d.value)}
          onKeyDown={(e) => e.key === "Enter" && onLogin()}
          style={{ width: "100%" }}
          data-testid="agent-password-input"
        />
        <div style={{ marginTop: 12 }}>
          <Button appearance="primary" onClick={onLogin} data-testid="agent-login">
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

  const nothingSelected = selectedId === null;

  const personaSwitcher = (
    <PersonaSwitcher
      personas={list}
      selectedId={selectedId}
      isNew={isNew}
      onSelect={selectPersona}
      onNew={startNew}
    />
  );

  return (
    <AgentEditorLayout
      personaSwitcher={personaSwitcher}
      toolbarActions={
        !nothingSelected && (
          <>
            {status && <Body1 data-testid="editor-status">{status}</Body1>}
            <Button appearance="secondary" onClick={reset} data-testid="persona-reset">
              Reset
            </Button>
            <Button appearance="primary" onClick={save} data-testid="persona-save">
              Save
            </Button>
          </>
        )
      }
      leftPanel={
        nothingSelected ? (
          <Body1 data-testid="editor-empty" style={{ padding: 24 }}>
            Select a persona above, or create a new one.
          </Body1>
        ) : (
          <AgentDefinitionPanel
            form={form}
            onChange={patchForm}
            onToggleVoiceMode={toggleVoiceMode}
            syncStatus={current?.agent_sync_status ?? "none"}
            agentId={current?.agent_id ?? null}
            agentVersion={current?.agent_version ?? null}
            syncError={current?.agent_sync_error ?? null}
            isNew={isNew}
            onRetrySync={retrySync}
            retrying={retrying}
            tools={form.tools}
            onToolsChange={(tools) => patchForm({ tools })}
            personaId={isNew ? null : current?.id ?? null}
            defaultInstructions={isNew ? "" : current?.default_instructions ?? ""}
          />
        )
      }
      centerPreview={
        nothingSelected ? (
          <Body1 data-testid="preview-empty" style={{ margin: "auto", color: "#888" }}>
            Select a persona to preview the interviewer.
          </Body1>
        ) : (
          <PlaygroundPanel
            personaId={isNew ? null : current?.id ?? null}
            character={form.character}
            style={form.style}
            locale={activeLocale}
          />
        )
      }
      configRail={
        nothingSelected ? (
          <Body1>Select a persona first.</Body1>
        ) : (
          <ConfigurationRail
            form={form}
            onChange={patchForm}
            activeLocale={activeLocale}
            onLocaleChange={setActiveLocale}
          />
        )
      }
    />
  );
}
