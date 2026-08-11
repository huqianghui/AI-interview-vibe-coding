/**
 * Agent-editor layout shell — the Azure AI Foundry portal Playground frame.
 *
 * Top bar (persona switcher + Save/Reset actions + Configure gear) over a two-column body: a left
 * "agent definition" column (Model / Voice mode / Instructions / Tools / Knowledge, divider-separated
 * collapsible sections) and a large center Playground preview (the digital human, centered). The
 * right Configuration rail slides in as a Fluent `OverlayDrawer`, opened by the gear. All regions are
 * passed as props so the page owns state and this component owns only the frame.
 */
import type { ReactNode } from "react";
import {
  Button,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular, Settings24Regular } from "@fluentui/react-icons";

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
  body: { flex: 1, display: "flex", minHeight: 0 },
  leftPanel: {
    width: "420px",
    minWidth: "340px",
    maxWidth: "46%",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: "auto",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  center: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

export interface AgentEditorLayoutProps {
  /** Top-bar left slot: persona switcher dropdown + New-persona (owns its own state). */
  personaSwitcher: ReactNode;
  /** Left column: the agent-definition sections. */
  leftPanel: ReactNode;
  /** Center column: the large Playground preview (digital human). */
  centerPreview: ReactNode;
  /** Right drawer body: the configuration rail. */
  configRail: ReactNode;
  /** Top-bar action nodes rendered left of the Configure gear (e.g. status/Save/Reset). */
  toolbarActions?: ReactNode;
  configOpen: boolean;
  onConfigOpenChange: (open: boolean) => void;
}

export function AgentEditorLayout({
  personaSwitcher,
  leftPanel,
  centerPreview,
  configRail,
  toolbarActions,
  configOpen,
  onConfigOpenChange,
}: AgentEditorLayoutProps) {
  const styles = useStyles();
  return (
    <div className={styles.root} data-testid="agent-editor-layout">
      <div className={styles.topBar}>
        <div className={styles.topBarLeft}>{personaSwitcher}</div>
        <div className={styles.topBarActions}>
          {toolbarActions}
          <Button
            icon={<Settings24Regular />}
            appearance="secondary"
            onClick={() => onConfigOpenChange(true)}
            data-testid="open-config-drawer"
          >
            Configure
          </Button>
        </div>
      </div>
      <div className={styles.body}>
        <aside className={styles.leftPanel} data-testid="agent-definition-panel">
          {leftPanel}
        </aside>
        <section className={styles.center} data-testid="agent-playground-preview">
          {centerPreview}
        </section>
      </div>
      <OverlayDrawer
        position="end"
        open={configOpen}
        onOpenChange={(_, d) => onConfigOpenChange(d.open)}
        data-testid="configuration-rail"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close configuration"
                icon={<Dismiss24Regular />}
                onClick={() => onConfigOpenChange(false)}
                data-testid="close-config-drawer"
              />
            }
          >
            Configuration
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>{configRail}</DrawerBody>
      </OverlayDrawer>
    </div>
  );
}
