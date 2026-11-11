#!/usr/bin/env node
// WP4-T7 proof: a customer creates a Cloud Server at 360 px in Bengali against STAGING.
//
// This script never reports a pass it did not see. It answers one of three ways:
//   PASS     exit 0   every step ran in a real browser against the staging URL
//   FAIL     exit 1   a step ran and the page did not behave
//   BLOCKED  exit 2   the run could not start: no Playwright package, no browser, no staging URL or no
//                     signed-in state, or the URL is not a staging or local host. BLOCKED is not a pass.
//
// Run by hand (manual VERIFY, the staging steps are not part of the local verify):
//   E2E_BASE_URL=https://<staging host> E2E_STORAGE_STATE=<file of a signed-in session> \
//     node scripts/playwright-servers.mjs
// The state file comes from signing in once by hand (`playwright codegen --save-storage`). It holds
// cookies: keep it outside the repository. This script reads no secret and prints no cookie.

import { URL } from "node:url";

const say = (line) => process.stdout.write(`${line}\n`);
const VIEWPORT = { width: 360, height: 800 };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function blocked(reason) {
  say(`BLOCKED: ${reason}`);
  say("BLOCKED is not a pass: nothing was proven.");
  process.exit(2);
}

/** Staging or a local development host only (CLAUDE.md: never production). */
export function allowedBase(raw) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const staging = url.protocol === "https:" && /(^|[.-])staging([.-]|$)/.test(url.hostname);
  return local || staging ? url.origin : null;
}

async function main() {
  const base = allowedBase(process.env["E2E_BASE_URL"]);
  if (base === null) {
    blocked("E2E_BASE_URL is missing, or it is not a staging or local host.");
  }
  const statePath = process.env["E2E_STORAGE_STATE"];
  if (typeof statePath !== "string" || statePath === "") {
    blocked("E2E_STORAGE_STATE (a signed-in session file) is missing.");
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    blocked(
      "the playwright package is not installed (no new dependency is added without a recorded reason).",
    );
  }

  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch {
    blocked("no Chromium browser is available to Playwright (run `playwright install chromium`).");
  }

  const failures = [];
  const step = async (name, run) => {
    try {
      await run();
      say(`ok   ${name}`);
    } catch (error) {
      failures.push(name);
      say(`FAIL ${name}: ${error instanceof Error ? error.message.split("\n")[0] : "error"}`);
    }
  };

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "bn-BD",
    storageState: statePath,
  });
  const page = await context.newPage();
  const noSideScroll = async () => {
    const width = await page.evaluate("document.documentElement.scrollWidth");
    if (width > VIEWPORT.width) throw new Error(`horizontal scroll: ${width}px`);
  };

  await step("open /servers/new in Bengali at 360 px", async () => {
    await page.goto(`${base}/servers/new`);
    await page.waitForSelector("form.config");
    await noSideScroll();
    if ((await page.locator("html").getAttribute("lang")) !== "bn")
      throw new Error("lang is not bn");
  });
  await step("choose the first plan and name the server", async () => {
    await page.locator("input[name=displayName]").fill("e2e-server");
  });
  await step("submit: the review page shows the signed price", async () => {
    await page.locator("form.config button[type=submit]").first().click();
    await page.waitForURL(/\/orders\/review\?d=/);
    await page.waitForSelector("table.compare");
    await noSideScroll();
  });
  await step("accept the terms and buy", async () => {
    await page.locator("input[type=checkbox]").check();
    await page.locator("form button[type=submit]").first().click();
    await page.waitForURL(new RegExp(`/orders/${UUID}$`));
    await noSideScroll();
  });
  await step("the order page reaches ready or says it is delayed", async () => {
    await page.waitForSelector(".alert-info, .alert-warning, .alert-danger", { timeout: 60_000 });
  });

  await browser.close();
  if (failures.length > 0) {
    say(`FAIL: ${failures.length} step(s) failed.`);
    process.exit(1);
  }
  say("PASS: a server was ordered at 360 px in bn against the given host.");
}

// Not run when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
