import { defineConfig } from "@playwright/test";

// The wallet proof against fakes (WP3-T4 Task 8). Started by scripts/smoke-wallet.mjs, which runs the
// dev server with the fake EPS and passes the seeded subjects in the environment. Two projects: Bengali
// at 360 px (the narrowest screen of U11) and English at 1280 px. One worker: the projects use
// different customers, but the dev server holds one fake EPS.
export default defineConfig({
  testDir: ".",
  testMatch: "wallet.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "../../test-results",
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "bn-360", use: { viewport: { width: 360, height: 740 }, locale: "bn-BD" } },
    { name: "en-1280", use: { viewport: { width: 1280, height: 800 }, locale: "en-US" } },
  ],
});
