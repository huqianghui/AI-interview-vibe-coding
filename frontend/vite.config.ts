/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api → backend so the frontend talks to one origin (no CORS in dev).
// E2E_API_TARGET lets the Playwright run point the proxy at its own backend port.
const apiTarget = process.env.E2E_API_TARGET || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        // Voice Live's avatar-video path (SPEC F9) opens a WebSocket at /api/voice-live/ws — vite's
        // proxy doesn't forward the Upgrade handshake for that without this flag.
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    // jsdom only exposes a working localStorage when the document has a real origin.
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live in ./e2e and must not be collected by vitest.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
