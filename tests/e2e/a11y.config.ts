import { defineConfig } from "@playwright/test";

// WPU-X6: axe-core checks of the signed-out pages of the web app and the admin login page, at 360 px
// (the narrowest screen of U11) and at 1280 px, in both languages. Started by scripts/smoke-a11y.mjs,
// which runs the dev servers with the fake switches and sets A11Y_APP (web or admin) and A11Y_ORIGIN.
// This file starts nothing. Four projects: locale (bn at the root, en under /en) times width.
// Light colour scheme and no motion keep the result the same on every run.
export default defineConfig({
  testDir: ".",
  testMatch: /a11y\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "../../test-results",
  use: {
    baseURL: process.env["A11Y_ORIGIN"] ?? "http://localhost:3000",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "off",
    screenshot: "off",
    video: "off",
    // The admin app answers 403 to an address outside its allowlist (R10). The runner starts it with the
    // documentation range 203.0.113.0/24 as the list and the browser sends a viewer address inside it.
    extraHTTPHeaders:
      process.env["A11Y_APP"] === "admin"
        ? { "CloudFront-Viewer-Address": "203.0.113.5:44321" }
        : {},
  },
  projects: [
    { name: "bn-360", use: { viewport: { width: 360, height: 740 }, locale: "bn-BD" } },
    { name: "en-360", use: { viewport: { width: 360, height: 740 }, locale: "en-US" } },
    { name: "bn-1280", use: { viewport: { width: 1280, height: 800 }, locale: "bn-BD" } },
    { name: "en-1280", use: { viewport: { width: 1280, height: 800 }, locale: "en-US" } },
  ],
});
