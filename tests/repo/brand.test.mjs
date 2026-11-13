// WPU-B1, WPU-Z8: the product brand is TryAWS.now (owner decision 2026-11-13), after MeghVPS (WPU-B1) and
// TiCON Cloud before it. No old brand name may return to any text a customer reads. The legal entity
// (TICON SYSTEM LIMITED / TiCON System Limited) and technical names (tc- prefixes, ticon-cloud SST app,
// TiCON-Pools-Dev, ticon-log-protection, @tc/*) stay and are not scanned for.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const OLD = /TiCON\s+Cloud|টিকন\s+ক্লাউড/i;
// WPU-Z8: the brand of WPU-B1, replaced by TryAWS.now.
const FORMER = /MeghVPS|মেঘ\s*ভিপিএস/i;

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const customerFacing = () => {
  const files = [];
  for (const dir of [
    "apps/web/messages",
    "apps/admin/messages",
    "packages/ui/shells/messages",
    "packages/notify/templates",
    "packages/notify/sms",
    "packages/notify/email",
    "apps/web/public/brand",
    "apps/admin/public/brand",
  ]) {
    if (existsSync(dir)) files.push(...walk(dir));
  }
  files.push("apps/web/server/public/seo.ts", "packages/core/invoices/render.ts");
  return files.filter((f) => /\.(ts|tsx|svg|json)$/.test(f) && !/\.test\./.test(f));
};

it("no customer-facing message, template, logo or invoice text says TiCON Cloud", () => {
  const files = customerFacing();
  expect(files.length).toBeGreaterThan(20);
  const hits = files.filter((f) => OLD.test(readFileSync(f, "utf8")));
  expect(hits).toEqual([]);
});

it("no customer-facing message, template, logo or invoice text says MeghVPS (WPU-Z8)", () => {
  const files = customerFacing();
  expect(files.length).toBeGreaterThan(20);
  const hits = files.filter((f) => FORMER.test(readFileSync(f, "utf8")));
  expect(hits).toEqual([]);
});

it("the brand is TryAWS.now in the shell, the admin title, the mail wordmark, the SMS, the invoice and the site name", () => {
  for (const [file, part] of [
    ["packages/ui/shells/messages/en.ts", 'brand: "TryAWS.now"'],
    ["packages/ui/shells/messages/bn.ts", 'brand: "TryAWS.now"'],
    ["packages/notify/templates/messages.ts", 'wordmark: "TryAWS.now"'],
    ["packages/notify/sms/otp-text.ts", "`TryAWS.now Your OTP is: "],
    ["packages/core/invoices/render.ts", '"TryAWS.now sells, bills and supports the service."'],
    ["apps/web/server/public/seo.ts", 'SITE_NAME = "TryAWS.now"'],
    ["apps/admin/messages/en.ts", "TryAWS.now Admin"],
    ["apps/web/public/brand/logo.svg", 'aria-label="TryAWS.now"'],
    ["apps/admin/public/brand/logo.svg", 'aria-label="TryAWS.now"'],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

// WPU-Z8: the brand is written exactly "TryAWS.now" (capital T, A, W, S; ".now" in lower case), in Latin
// letters in both locales. The all-lower-case "tryaws.now" is the domain name (out of this rule).
it("writes the brand exactly TryAWS.now in every customer-facing file", () => {
  const wrong = [];
  for (const file of customerFacing()) {
    for (const m of readFileSync(file, "utf8").matchAll(/try[\s_-]*aws[\s_-]*\.?[\s_-]*now/gi)) {
      if (m[0] !== "TryAWS.now" && m[0] !== "tryaws.now") wrong.push(`${file}: ${m[0]}`);
    }
  }
  expect(wrong).toEqual([]);
});

it("the legal entity stays TiCON System Limited where a legal name is printed", () => {
  for (const file of [
    "packages/ui/shells/messages/en.ts",
    "packages/notify/templates/messages.ts",
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain("TiCON System Limited");
  }
});
