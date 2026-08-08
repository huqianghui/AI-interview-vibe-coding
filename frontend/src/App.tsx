/** App shell: Fluent provider + router + language switcher. */
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Navigate, Route, Routes } from "react-router-dom";
import { InterviewPage } from "./pages/InterviewPage";
import { LanguageSwitcher } from "./components/LanguageSwitcher";

export function App() {
  return (
    <FluentProvider theme={webLightTheme}>
      <header
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "12px 24px",
        }}
      >
        <LanguageSwitcher />
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/interview" replace />} />
        <Route path="/interview" element={<InterviewPage />} />
      </Routes>
    </FluentProvider>
  );
}
