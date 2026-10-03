module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
  ],
  ignorePatterns: ["dist", ".eslintrc.cjs", "vite.config.ts", "playwright.config.ts"],
  parser: "@typescript-eslint/parser",
  plugins: ["react-refresh"],
  rules: {
    "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
  },
  overrides: [
    {
      // Playwright E2E specs run in Node (test runner), not the browser.
      files: ["e2e/**/*.ts"],
      env: { browser: true, node: true, es2022: true },
    },
    {
      // AudioWorklet processors run in AudioWorkletGlobalScope, not the window. That scope has no
      // `window` and no `document`, but it DOES expose a few globals of its own that eslint's
      // browser env does not model — `sampleRate` above all, which the capture worklet uses to size
      // its batch in milliseconds rather than samples. Declared here as the complete set of that
      // scope's own value globals, so the next worklet does not hit the same wall.
      files: ["public/*.js"],
      globals: { sampleRate: "readonly", currentTime: "readonly", currentFrame: "readonly" },
    },
  ],
};
