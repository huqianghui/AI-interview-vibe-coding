/**
 * Agent-editor layout shell — the Azure AI Foundry portal Playground frame.
 *
 * Top bar (persona switcher + Save/Reset actions) over a THREE-column body, all always visible
 * (matching the Foundry portal + AI-Coach editor — no "Configure" gate):
 *   left   = agent definition (Model / Voice mode / Instructions / Tools / Knowledge)
 *   center = the Playground (digital human + inline test), given the most room
 *   right  = the configuration rail (language / voice / avatar / advanced knobs)
 * All regions are passed as props so the page owns state and this component owns only the frame.
 * Columns collapse to a single stacked column under ~1100px.
 */
import type { ReactNode } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "calc(100vh - 56px)", // below App.tsx's language-switcher header
    minHeight: "480px",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  topBarLeft: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, minWidth: 0 },
  topBarActions: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
    "@media (max-width: 1100px)": { flexDirection: "column", overflowY: "auto" },
  },
  leftPanel: {
    width: "380px",
    minWidth: "320px",
    maxWidth: "40%",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: "auto",
    backgroundColor: tokens.colorNeutralBackground1,
    "@media (max-width: 1100px)": { width: "auto", maxWidth: "none", borderRight: "none" },
  },
  center: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground2,
    "@media (max-width: 1100px)": { minHeight: "420px" },
  },
  configRail: {
    width: "340px",
    minWidth: "300px",
    maxWidth: "38%",
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: "auto",
    padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground1,
    "@media (max-width: 1100px)": {
      width: "auto",
      maxWidth: "none",
      borderLeft: "none",
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },
});

export interface AgentEditorLayoutProps {
  /** Top-bar left slot: persona switcher dropdown + New-persona (owns its own state). */
  personaSwitcher: ReactNode;
  /** Left column: the agent-definition sections. */
  leftPanel: ReactNode;
  /** Center column: the large Playground (digital human + inline test). */
  centerPreview: ReactNode;
  /** Right column: the configuration rail (always visible). */
  configRail: ReactNode;
  /** Top-bar action nodes (e.g. status/Save/Reset). */
  toolbarActions?: ReactNode;
}

export function AgentEditorLayout({
  personaSwitcher,
  leftPanel,
  centerPreview,
  configRail,
  toolbarActions,
}: AgentEditorLayoutProps) {
  const styles = useStyles();
  return (
    <div className={styles.root} data-testid="agent-editor-layout">
      <div className={styles.topBar}>
        <div className={styles.topBarLeft}>{personaSwitcher}</div>
        <div className={styles.topBarActions}>{toolbarActions}</div>
      </div>
      <div className={styles.body}>
        <aside className={styles.leftPanel} data-testid="agent-definition-panel">
          {leftPanel}
        </aside>
        <section className={styles.center} data-testid="agent-playground-preview">
          {centerPreview}
        </section>
        <aside className={styles.configRail} data-testid="configuration-rail">
          {configRail}
        </aside>
      </div>
    </div>
  );
}
