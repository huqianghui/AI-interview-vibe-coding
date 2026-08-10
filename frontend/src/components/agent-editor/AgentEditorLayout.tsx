/**
 * Agent-editor layout shell (Phase 3) — the Foundry-portal-style frame.
 *
 * Two static columns (left persona nav + center agent definition) plus a right Configuration rail
 * that slides in as a Fluent `OverlayDrawer`, opened by a gear button in the center toolbar. This
 * mirrors the reference project's proven gear→drawer interaction rather than a permanently-visible
 * third column (a deliberate call — see the Phase 3 plan). The three regions are passed as props so
 * the page owns all state and this component owns only the frame.
 */
import type { ReactNode } from "react";
import {
  Button,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular, Settings24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    display: "flex",
    height: "calc(100vh - 56px)", // below App.tsx's language-switcher header
    minHeight: "480px",
  },
  leftNav: {
    width: "260px",
    minWidth: "220px",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: "auto",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  center: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    gap: tokens.spacingHorizontalM,
  },
  toolbarActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  centerBody: {
    flex: 1,
    overflowY: "auto",
    padding: tokens.spacingHorizontalL,
  },
});

export interface AgentEditorLayoutProps {
  /** Left column: persona list / new-persona button. */
  leftNav: ReactNode;
  /** Center column body: the agent-definition panel. */
  center: ReactNode;
  /** Right drawer body: the configuration rail. */
  configRail: ReactNode;
  /** Title shown in the center toolbar (e.g. the persona name, or "New persona"). */
  title: string;
  /** Toolbar action nodes rendered left of the Configure gear (e.g. Save/Reset). */
  toolbarActions?: ReactNode;
  configOpen: boolean;
  onConfigOpenChange: (open: boolean) => void;
}

export function AgentEditorLayout({
  leftNav,
  center,
  configRail,
  title,
  toolbarActions,
  configOpen,
  onConfigOpenChange,
}: AgentEditorLayoutProps) {
  const styles = useStyles();
  return (
    <div className={styles.root} data-testid="agent-editor-layout">
      <nav className={styles.leftNav} data-testid="agent-nav">
        {leftNav}
      </nav>
      <section className={styles.center} data-testid="agent-definition-panel">
        <div className={styles.toolbar}>
          <Title3>{title}</Title3>
          <div className={styles.toolbarActions}>
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
        <div className={styles.centerBody}>{center}</div>
      </section>
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
