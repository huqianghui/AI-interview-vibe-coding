import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./i18n";
import { getAdminToken, getCandidateToken } from "./api/auth";
import { startTelemetry } from "./telemetry/appInsights";

const queryClient = new QueryClient();

// A reload with a stored session starts telemetry right away; otherwise sign-in does (api/auth.ts).
// Not awaited: telemetry must never hold up the first paint.
void startTelemetry(getCandidateToken() || getAdminToken());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
