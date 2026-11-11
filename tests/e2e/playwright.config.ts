import { defineConfig } from "@playwright/test";

// The two projects of the browser proofs (WP2-T2 Task 10, shared with WP3-T4): `bn-360` is the phone
// width in Bengali, `en-1280` the desktop width in English. The server is started by the runner
// (scripts/smoke-auth.mjs), which sets the fake switches in its environment; this file starts nothing.
// One worker and no parallelism: the specs share one local database and one in-memory identity provider.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "bn-360",
      use: { locale: "bn-BD", viewport: { width: 360, height: 740 } },
    },
    {
      name: "en-1280",
      use: { locale: "en-US", viewport: { width: 1280, height: 800 } },
    },
  ],
});
