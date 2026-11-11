import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allowedBase } from "../../scripts/playwright-servers.mjs";

// WP4-T7: the Playwright proof must say BLOCKED, never PASS, when it cannot run. It runs here without
// a staging URL, a session file or a browser, so the only honest answer is BLOCKED with exit code 2.
const SCRIPT = fileURLToPath(new URL("../../scripts/playwright-servers.mjs", import.meta.url));

function run(env) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    timeout: 30_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("the Playwright smoke of the server flow", () => {
  it("is BLOCKED (exit 2) without a base URL, and never prints PASS", () => {
    const { code, out } = run({});
    expect(code).toBe(2);
    expect(out).toContain("BLOCKED");
    expect(out).not.toMatch(/\bPASS\b/);
  });

  it("is BLOCKED without a signed-in session file", () => {
    const { code, out } = run({ E2E_BASE_URL: "http://localhost:3000" });
    expect(code).toBe(2);
    expect(out).toContain("E2E_STORAGE_STATE");
  });

  it("is BLOCKED when the playwright package or a browser is missing, or the host is production", () => {
    const missing = run({
      E2E_BASE_URL: "http://localhost:3000",
      E2E_STORAGE_STATE: "/nonexistent.json",
    });
    expect(missing.code).toBe(2);
    expect(missing.out).toMatch(/playwright package is not installed|no Chromium browser/);
    const production = run({
      E2E_BASE_URL: "https://cloud.example.com",
      E2E_STORAGE_STATE: "/x.json",
    });
    expect(production.code).toBe(2);
    expect(production.out).toContain("not a staging or local host");
  });

  it("allows only staging and local hosts", () => {
    expect(allowedBase("https://staging.example.com")).toBe("https://staging.example.com");
    expect(allowedBase("https://app-staging.example.com")).toBe("https://app-staging.example.com");
    expect(allowedBase("http://localhost:3000")).toBe("http://localhost:3000");
    expect(allowedBase("https://cloud.example.com")).toBeNull();
    expect(allowedBase("http://staging.example.com")).toBeNull();
    expect(allowedBase("https://notstaging.example.com")).toBeNull();
    expect(allowedBase(undefined)).toBeNull();
    expect(allowedBase("javascript:alert(1)")).toBeNull();
  });
});
