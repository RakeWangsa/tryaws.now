// WPU-B1: the product brand is MeghVPS. "TiCON Cloud" must not return to any text a customer reads. The legal
// entity (TICON SYSTEM LIMITED / TiCON System Limited) and technical names (tc- prefixes, ticon-cloud SST app,
// TiCON-Pools-Dev, ticon-log-protection, @tc/*) stay and are not scanned for.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const OLD = /TiCON\s+Cloud|টিকন\s+ক্লাউড/i;

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

it("the brand is MeghVPS in the shell, the admin title, the mail wordmark and the site name", () => {
  for (const [file, part] of [
    ["packages/ui/shells/messages/en.ts", 'brand: "MeghVPS"'],
    ["packages/ui/shells/messages/bn.ts", 'brand: "MeghVPS"'],
    ["packages/notify/templates/messages.ts", 'wordmark: "MeghVPS"'],
    ["apps/web/server/public/seo.ts", 'SITE_NAME = "MeghVPS"'],
    ["apps/admin/messages/en.ts", "MeghVPS Admin"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("the legal entity stays TiCON System Limited where a legal name is printed", () => {
  for (const file of [
    "packages/ui/shells/messages/en.ts",
    "packages/notify/templates/messages.ts",
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain("TiCON System Limited");
  }
});
