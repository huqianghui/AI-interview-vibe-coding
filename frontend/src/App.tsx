/** App root: the themed Fluent provider + router. The header band lives in AppShell, per route. */
import { FluentProvider, makeStyles } from "@fluentui/react-components";
import { Navigate, Route, Routes } from "react-router-dom";
import { InterviewPage } from "./pages/InterviewPage";
import { AdminPage } from "./pages/AdminPage";
import { AgentEditorPage } from "./pages/AgentEditorPage";
import { appTheme } from "./theme";
import "./styles/global.css";

const useStyles = makeStyles({
  /** FluentProvider paints `colorNeutralBackground1` on its own root, and that token is the warm
   *  CARD surface in this theme — left alone it would cover the whole page and hide the sand
   *  ground set on html/body in global.css. So the provider root is made transparent. */
  provider: { backgroundColor: "transparent" },
});

export function App() {
  const styles = useStyles();
  return (
    <FluentProvider theme={appTheme} className={styles.provider}>
      <Routes>
        <Route path="/" element={<Navigate to="/interview" replace />} />
        <Route path="/interview" element={<InterviewPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/agent" element={<AgentEditorPage />} />
        <Route path="/admin/agent/:personaId" element={<AgentEditorPage />} />
      </Routes>
    </FluentProvider>
  );
}
