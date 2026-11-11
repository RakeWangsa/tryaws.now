import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The wallet proof against fakes (WP3-T4 Task 8), run by scripts/smoke-wallet.mjs. The dev server
// runs with TC_STAGE=local and the fake EPS; the seed made one customer for each project and a third
// customer with one open payment. No axe and no screenshot is compared.

const SUBS = JSON.parse(process.env["WALLET_SMOKE_SUBS"] ?? "{}") as Record<string, string>;
const OTHER_PAYMENT = process.env["WALLET_SMOKE_OTHER_PAYMENT"] ?? "";

interface Words {
  prefix: string;
  zero: string;
  emptyLedger: string;
  credited: string;
  topUpKind: string;
  paid: string;
  typed: string;
  unknownBanner: string;
  failedBanner: string;
  cancelledBanner: string;
  failedTitle: string;
  cancelledTitle: string;
  notFound: string;
  pendingTitle: string;
  creditedTitle: string;
  view: string;
}

const WORDS: Record<string, Words> = {
  "bn-360": {
    prefix: "",
    zero: "৳০.০০",
    emptyLedger: "এখনো কোনো লেনদেন নেই",
    credited: "৳১,৫০০.০০",
    topUpKind: "টপ আপ",
    paid: "জমা হয়েছে",
    typed: "১৫০০",
    unknownBanner: "এই পেমেন্ট আমরা খুঁজে পাইনি",
    failedBanner: "পেমেন্ট সম্পন্ন হয়নি",
    cancelledBanner: "আপনি পেমেন্ট বাতিল করেছেন",
    failedTitle: "পেমেন্ট সম্পন্ন হয়নি",
    cancelledTitle: "পেমেন্ট বাতিল হয়েছে",
    notFound: "পেমেন্ট পাওয়া যায়নি",
    pendingTitle: "পেমেন্ট যাচাই হচ্ছে",
    creditedTitle: "টপ আপ সম্পন্ন হয়েছে",
    view: "দেখুন",
  },
  "en-1280": {
    prefix: "/en",
    zero: "৳0.00",
    emptyLedger: "No transactions yet",
    credited: "৳1,500.00",
    topUpKind: "Top-up",
    paid: "Paid",
    typed: "1,500",
    unknownBanner: "We could not find this payment",
    failedBanner: "The payment did not go through",
    cancelledBanner: "You cancelled the payment",
    failedTitle: "The payment did not go through",
    cancelledTitle: "The payment was cancelled",
    notFound: "Payment not found",
    pendingTitle: "Checking your payment",
    creditedTitle: "Top-up complete",
    view: "View",
  },
};

const noScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Fills the top-up form and submits; the browser lands on the fake EPS page. */
async function startTopUp(page: Page, w: Words, amount: string): Promise<void> {
  await page.goto(`${w.prefix}/wallet/topup`);
  await page.locator('input[name="amount"]').fill(amount);
  await page.locator('form:has(input[name="amount"]) button[type="submit"]').click();
  await page.waitForURL(/\/dev\/eps\/checkout\?data=\d+/);
}

test("a faked EPS success shows the new balance once", async ({ page, context }, info) => {
  const project = info.project.name;
  const w = WORDS[project];
  const sub = SUBS[project];
  expect(w, `no words for ${project}`).toBeDefined();
  expect(sub, `no seeded subject for ${project}`).toBeTruthy();
  if (w === undefined || sub === undefined) return;

  const consoleErrors: string[] = [];
  const hosts = new Set<string>();
  const offApp: string[] = [];
  let returnedId = "";
  for (const p of [page]) {
    p.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    p.on("request", (r) => {
      hosts.add(new URL(r.url()).hostname);
      const found = /\/pay\/eps\/success\?MerchantTransactionId=([0-9a-f]+)/.exec(r.url());
      if (found?.[1] !== undefined && returnedId === "") returnedId = found[1];
    });
    p.on("response", (r) => {
      const location = r.headers()["location"];
      if (
        location !== undefined &&
        !location.startsWith("/") &&
        !location.startsWith("http://localhost:3000")
      ) {
        offApp.push(location);
      }
    });
  }

  await test.step("sign in and see an empty wallet without horizontal scroll", async () => {
    await page.goto(`${w.prefix}/dev/sign-in?sub=${encodeURIComponent(sub)}`);
    await expect(page).toHaveURL(new RegExp(`${w.prefix}/wallet$`));
    await expect(page.getByText(w.zero).first()).toBeVisible();
    await expect(page.getByText(w.emptyLedger)).toBeVisible();
    expect(await noScroll(page)).toBe(true);
  });

  await test.step("top up 1,500 through the fake EPS and come back credited", async () => {
    await page.goto(`${w.prefix}/wallet/topup`);
    // A quick amount fills the field; then the typed amount replaces it.
    const quick = page.locator('input[name="quick"]').first();
    if ((await quick.count()) > 0) {
      await quick.check();
      await expect(page.locator('input[name="amount"]')).not.toHaveValue("");
    }
    await startTopUp(page, w, w.typed);
    expect(new URL(page.url()).pathname.endsWith("/dev/eps/checkout")).toBe(true);
    await page.locator('button[name="outcome"][value="pay"]').click();
    await page.waitForURL(/\/wallet\?topup=credited$/);
  });

  let ledger = 0;
  let payments = 0;
  await test.step("the wallet shows the new balance, one top-up line and one paid payment", async () => {
    await expect(page.getByText(w.credited).first()).toBeVisible();
    const tables = page.locator("table");
    ledger = await tables.nth(0).locator("tbody tr").count();
    payments = await tables.nth(1).locator("tbody tr").count();
    expect(ledger).toBe(1);
    expect(payments).toBe(1);
    await expect(tables.nth(0)).toContainText(w.topUpKind);
    // The running balance of the only line equals the balance.
    await expect(tables.nth(0).locator("tbody tr").first()).toContainText(w.credited);
    await expect(tables.nth(1)).toContainText(w.paid);
  });

  const balanceText = w.credited;
  const scrolls = await noScroll(page);
  // The line scripts/lib/wallet-smoke.mjs reads (parseTopUpLine).
  console.log(
    `WALLET-SMOKE ${project} balance=${balanceText} ledger=${ledger} payments=${payments} noscroll=${scrolls}`,
  );
  expect(scrolls).toBe(true);

  await test.step("a reload and a replay of the same return do not change the balance (credits once)", async () => {
    expect(returnedId).toMatch(/^[0-9a-f]{32}$/);
    await page.reload();
    await expect(page.getByText(w.credited).first()).toBeVisible();
    await page.goto(`/pay/eps/success?MerchantTransactionId=${returnedId}`);
    await expect(page).toHaveURL(/\/wallet\?topup=credited$/);
    await expect(page.getByText(w.credited).first()).toBeVisible();
    await expect(page.locator("table").nth(0).locator("tbody tr")).toHaveCount(1);
  });

  await test.step("a forged id shows only the 'could not find' banner and changes nothing", async () => {
    await page.goto("/pay/eps/success?MerchantTransactionId=NOPE-0000000000");
    await expect(page.getByText(w.unknownBanner)).toBeVisible();
    await expect(page.getByText(w.credited).first()).toBeVisible();
    await expect(page.locator("table").nth(0).locator("tbody tr")).toHaveCount(1);
  });

  for (const [outcome, banner, title] of [
    ["fail", w.failedBanner, w.failedTitle],
    ["cancel", w.cancelledBanner, w.cancelledTitle],
  ] as const) {
    await test.step(`${outcome}: the banner, the status page, and no change of balance`, async () => {
      await startTopUp(page, w, "500");
      await page.locator(`button[name="outcome"][value="${outcome}"]`).click();
      await page.waitForURL(new RegExp(`/wallet\\?topup=(failed|cancelled)$`));
      await expect(page.getByText(banner).first()).toBeVisible();
      await expect(page.getByText(w.credited).first()).toBeVisible();
      await page.getByRole("link", { name: w.view }).first().click();
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      expect(await noScroll(page)).toBe(true);
    });
  }

  await test.step("another customer's payment is the 'not found' page", async () => {
    const response = await page.goto(`${w.prefix}/wallet/topup/${OTHER_PAYMENT}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText(w.notFound)).toBeVisible();
  });

  await test.step("a payment left pending is polled and shows credited after it is settled in another tab", async () => {
    await startTopUp(page, w, "700");
    const watcher = await context.newPage();
    await watcher.goto(`${w.prefix}/wallet`);
    await watcher.getByRole("link", { name: w.view }).first().click();
    await expect(watcher.getByRole("heading", { name: w.pendingTitle })).toBeVisible();
    await page.locator('button[name="outcome"][value="pay"]').click();
    await page.waitForURL(/\/wallet\?topup=credited$/);
    // The status page re-checks every 8 s and refreshes itself when the state changes.
    await expect(watcher.getByRole("heading", { name: w.creditedTitle })).toBeVisible({
      timeout: 45_000,
    });
    await watcher.close();
  });

  expect(consoleErrors, "console errors").toEqual([]);
  expect([...hosts], "hosts").toEqual(["localhost"]);
  expect(offApp, "redirects off the app").toEqual([]);
});
