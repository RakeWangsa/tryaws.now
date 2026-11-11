import { defineConfig } from "@playwright/test";

// The browser proofs against fakes: wallet (WP3-T4 Task 8) and auth (WP2-T2 Task 10). Started by
// scripts/smoke-wallet.mjs and scripts/smoke-auth.mjs, which run the dev server with the fake
// switches in the environment; this file starts nothing. Two projects: Bengali at 360 px (the
// narrowest screen of U11) and English at 1280 px. One worker and no parallelism: the specs share
// one local database, one fake EPS and one in-memory identity provider.
export default defineConfig({
  testDir: ".",
  testMatch: /(wallet|auth)\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
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
