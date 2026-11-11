import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// WP2-T2 Task 10: sign-up to sign-in in `bn` at 360 px, and the same path in English at 1280 px,
// locally against the fake identity provider and the fake SMS gateway. No axe, no screenshots compared.
// The codes are read from the two dev outbox routes, which answer 404 unless the fake switches are on.

const BENGALI = /[ঀ-৿]/;
const PASSWORD = "correct horse battery 14";
const NEW_PASSWORD = "another long password 77";
const PHONE_LOCAL = "01712345678";
const PHONE_E164 = "+8801712345678";
const SCREENS = ["/signup", "/verify", "/login", "/forgot-password", "/reset-password"];

const digits = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
const bengali = (text: string): string =>
  text.replace(/[0-9]/g, (d) => digits[Number(d)] as string);

type Fixture = { page: Page; bn: boolean; path: (p: string) => string; stamp: string };

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function fillSignUp(f: Fixture, email: string): Promise<void> {
  const { page } = f;
  await page.goto(f.path("/signup"));
  await page.fill('input[name="fullName"]', f.bn ? "রহিম উদ্দিন" : "Rahim Uddin");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="phone"]', f.bn ? bengali(PHONE_LOCAL) : PHONE_LOCAL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="passwordConfirm"]', PASSWORD);
  for (const id of ["#consent-terms", "#consent-aup", "#consent-privacy"]) await page.check(id);
  await page.click('button[type="submit"]');
  await page.waitForURL(`**${f.path("/verify")}`);
}

async function emailCode(page: Page, email: string, kind: "signup" | "reset"): Promise<string> {
  const response = await page.request.get(`/dev/idp/outbox?email=${encodeURIComponent(email)}`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { kind: string; code: string };
  expect(body.kind).toBe(kind);
  return body.code;
}

async function smsCode(page: Page): Promise<string> {
  const response = await page.request.get(`/dev/sms/outbox?to=${encodeURIComponent(PHONE_E164)}`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { text: string };
  const found = /\b(\d{6})\b/.exec(body.text);
  expect(found, "a six-digit code in the SMS").not.toBeNull();
  return found?.[1] as string;
}

async function signIn(f: Fixture, email: string, password: string): Promise<void> {
  await f.page.fill('input[name="email"]', email);
  await f.page.fill('input[name="password"]', password);
  await f.page.click('button[type="submit"]');
}

/** The text of the first danger alert without the reference line, to compare two failures. */
async function failureText(page: Page): Promise<string> {
  const alert = page.locator(".alert-danger").first();
  await expect(alert).toBeVisible();
  const text = (await alert.innerText()).replace(/(Reference|রেফারেন্স):.*$/m, "").trim();
  return text;
}

test("sign-up to sign-in, the phone step and the panel", async ({ page, context }, info) => {
  const bn = info.project.name === "bn-360";
  const f: Fixture = {
    page,
    bn,
    path: (p) => (bn ? p : `/en${p}`),
    stamp: `${Date.now()}${bn ? "bn" : "en"}`,
  };
  const email = `smoke+${f.stamp}@example.test`;
  const errors: string[] = [];
  const foreign: string[] = [];
  const failedSignInCookies: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.host !== "localhost:3000")
      foreign.push(request.url());
  });

  // (1) The five screens: language, title, tabs, and no horizontal scroll.
  for (const screen of SCREENS) {
    await page.goto(f.path(screen));
    await expect(page.locator("html")).toHaveAttribute("lang", bn ? "bn" : "en");
    expect(await noHorizontalScroll(page), `${screen} has no horizontal scroll`).toBe(true);
  }
  await page.goto(f.path("/signup"));
  const title = await page.locator("h2").first().innerText();
  if (bn) expect(title).toMatch(BENGALI);
  else expect(title).not.toMatch(BENGALI);
  await expect(page.locator(".tabs-header li.btn")).toHaveCount(2);

  // (2) Sign up, then the email step.
  await fillSignUp(f, email);

  // (3) A wrong code shows the code_wrong alert with an icon and text; the right one lands on /login.
  await page.fill('input[name="code"]', "000000");
  await page.click('button[type="submit"]:has-text("' + (bn ? "যাচাই" : "Verify") + '")');
  const alert = page.locator(".alert-danger").first();
  await expect(alert).toBeVisible();
  await expect(alert.locator("i.fas")).toBeVisible();
  expect((await alert.innerText()).length).toBeGreaterThan(10);
  const code = await emailCode(page, email, "signup");
  await page.fill('input[name="code"]', code);
  await page.click('button[type="submit"]:has-text("' + (bn ? "যাচাই" : "Verify") + '")');
  await page.waitForURL(`**${f.path("/login")}?verified=1`);
  await expect(page.locator(".alert-success")).toBeVisible();

  // (4) A wrong password and an unknown address give the same alert; the right one goes to the phone step.
  page.on("response", async (response) => {
    if (response.request().method() === "POST" && response.url().includes("/login")) {
      const header = await response.headerValue("set-cookie");
      if (header !== null) failedSignInCookies.push(header);
    }
  });
  await signIn(f, email, "wrong wrong wrong wrong");
  const wrong = await failureText(page);
  await signIn(f, `nobody+${f.stamp}@example.test`, "wrong wrong wrong wrong");
  await expect(page.locator(".alert-danger")).toBeVisible();
  expect(await failureText(page)).toBe(wrong);
  expect(failedSignInCookies, "a failed sign-in sets no cookie").toEqual([]);

  await signIn(f, email, PASSWORD);
  await page.waitForURL(`**${f.path("/verify")}`);
  await expect(page.locator('input[name="phone"]')).toHaveValue(PHONE_E164);
  await page.click('button[type="submit"]');
  await expect(page.locator(".alert-info")).toContainText("+880*******678");
  await page.fill('input[name="code"]', await smsCode(page));
  await page.click('button[type="submit"]:has-text("' + (bn ? "যাচাই" : "Verify") + '")');
  await page.waitForURL(`**${f.path("/wallet")}`);
  await expect(page.locator("main#main")).toBeVisible();
  const landing = page.url();
  appendFileSync(
    join(process.env["AUTH_SMOKE_OUT"] ?? ".", `${info.project.name}.txt`),
    `${landing}\n`,
  );

  if (!bn) {
    expect(errors, "no console error").toEqual([]);
    expect(foreign, "no request to another host").toEqual([]);
    return;
  }

  // (5) The cookies: HttpOnly, Secure, SameSite=Lax, Path=/, and nothing in script reach.
  const cookies = await context.cookies();
  for (const name of ["__Host-tc_at", "__Host-tc_rt"]) {
    const cookie = cookies.find((c) => c.name === name);
    expect(cookie, name).toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  }
  expect(await page.evaluate(() => document.cookie)).not.toContain("__Host-tc_");
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  // (6) Sign out from the account menu; /wallet then goes to sign-in with next; a hostile next is ignored.
  await page.locator("button:has(i.fa-circle-user)").click();
  await page.getByRole("button", { name: /সাইন আউট/ }).click();
  await page.waitForURL("**/login");
  await page.goto("/wallet");
  await page.waitForURL("**/login?next=%2Fwallet");
  await signIn(f, email, PASSWORD);
  await page.waitForURL("**/wallet");
  await page.locator("button:has(i.fa-circle-user)").click();
  await page.getByRole("button", { name: /সাইন আউট/ }).click();
  await page.waitForURL("**/login");
  await page.goto("/login?next=//evil.com");
  await signIn(f, email, PASSWORD);
  await page.waitForURL("**/wallet");
  expect(new URL(page.url()).host).toBe("localhost:3000");
  await page.locator("button:has(i.fa-circle-user)").click();
  await page.getByRole("button", { name: /সাইন আউট/ }).click();
  await page.waitForURL("**/login");

  // (7) Forgot password: an unknown and the known address give the same page; reset with the code.
  const heading = async (): Promise<string> =>
    (await page.locator("h2").first().innerText()).trim();
  await page.goto("/forgot-password");
  await page.fill('input[name="email"]', `nobody+${f.stamp}@example.test`);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/reset-password");
  const unknownHeading = await heading();
  await page.goto("/forgot-password");
  await page.fill('input[name="email"]', email);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/reset-password");
  expect(await heading()).toBe(unknownHeading);
  await page.fill('input[name="code"]', await emailCode(page, email, "reset"));
  await page.fill('input[name="password"]', NEW_PASSWORD);
  await page.fill('input[name="passwordConfirm"]', NEW_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/login?reset=1");
  await signIn(f, email, PASSWORD);
  await expect(page.locator(".alert-danger")).toBeVisible();
  await signIn(f, email, NEW_PASSWORD);
  await page.waitForURL("**/wallet");

  // (8) Eight wrong codes for a second, unconfirmed account lock nothing at the fifth; the ninth is limited.
  await page.locator("button:has(i.fa-circle-user)").click();
  await page.getByRole("button", { name: /সাইন আউট/ }).click();
  await page.waitForURL("**/login");
  const second = `smoke+${f.stamp}b@example.test`;
  await fillSignUp(f, second);
  for (let attempt = 1; attempt <= 8; attempt++) {
    await page.fill('input[name="code"]', "000000");
    await page.click('button[type="submit"]:has-text("যাচাই")');
    await expect(page.locator(".alert-danger").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
  }
  await page.fill('input[name="code"]', "000000");
  await page.click('button[type="submit"]:has-text("যাচাই")');
  await expect(page.locator(".alert-warning")).toBeVisible();

  // The code typed with Bengali digits is accepted (a third account).
  const third = `smoke+${f.stamp}c@example.test`;
  await fillSignUp(f, third);
  await page.fill('input[name="code"]', bengali(await emailCode(page, third, "signup")));
  await page.click('button[type="submit"]:has-text("যাচাই")');
  await page.waitForURL("**/login?verified=1");

  // (9) No console error, no request to another host.
  expect(errors, "no console error").toEqual([]);
  expect(foreign, "no request to another host").toEqual([]);
});
