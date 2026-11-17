import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildBaseline, KIT_FILES } from "./baseline.mjs";

const plan = readFileSync("TICON_CLOUD_MEGA_PLAN.md", "utf8");
const b = buildBaseline(plan);

it("copies the 14 pricing vectors and the launch steps", () => {
  expect(b.pricing.fx).toBe("127");
  expect(b.pricing.vectors).toHaveLength(14);
  expect(b.pricing.vectors[0]).toEqual({
    aws_usd: "5",
    base: 63500,
    korea_vat: 6350,
    bd_vat: 3175,
    processing_fee: 1270,
    total: 74295,
  });
  expect(b.pricing.vectors[6]).toEqual({
    aws_usd: "9.50",
    base: 120650,
    korea_vat: 12065,
    bd_vat: 6033,
    processing_fee: 2413,
    total: 141161,
  });
  expect(b.pricing.steps).toEqual([
    { code: "korea_vat", rate: "0.10", base: "aws" },
    { code: "bd_vat", rate: "0.05", base: "aws" },
    { code: "processing_fee", rate: "0.02", base: "aws" },
    { code: "markup", rate: "0", base: "aws" },
  ]);
  expect(b.pricing.extra[0].total).toBe(72991);
  expect(b.pricing.extra[1]).toEqual({
    fx: "127",
    aws_usd: "5",
    bd_vat_base: "subtotal",
    bd_vat: 3556,
    total: 74676,
  });
});
it("every vector adds up", () => {
  for (const v of b.pricing.vectors) {
    expect(v.base + v.korea_vat + v.bd_vat + v.processing_fee, v.aws_usd).toBe(v.total);
  }
});
it("copies the tables of section 7 with their append-only mark", () => {
  const names = b.tables.map((t) => t.name);
  expect(names).toContain("customers");
  expect(names).toContain("waitlist_entries");
  expect(new Set(names).size).toBe(names.length);
  expect(b.tables.filter((t) => t.appendOnly).map((t) => t.name)).toEqual([
    "legal_acceptances",
    "fx_rates",
    "pricing_rules",
    "ledger_transactions",
    "ledger_entries",
    "audit_log",
  ]);
});
it("copies routes with their priority", () => {
  const find = (route) => b.routes.find((r) => r.routes.includes(route));
  expect(find("/servers/new")).toMatchObject({ section: "16.10", priority: "P0" });
  expect(find("/pricing")).toMatchObject({ section: "16.8", priority: "P0" });
  expect(find("/kyc")).toMatchObject({ section: "16.9", priority: "P0" });
  expect(
    b.routes.find((r) => r.section === "16.12" && r.routes.includes("/operations")).priority,
  ).toBe("P0");
  expect(b.routes.find((r) => r.label === "Tab Destroy").routes).toEqual([]);
});
it("copies the theme lists and the secret names", () => {
  expect(b.theme.shipped[0]).toBe("`css/bootstrap.min.css`");
  expect(b.theme.neverShipped.some((cell) => cell.includes("`js/*`"))).toBe(true);
  expect(b.secretNames).toEqual([
    "EpsMerchantId",
    "EpsStoreId",
    "EpsUsername",
    "EpsPassword",
    "EpsHashKey",
    "SmsApiKey",
  ]);
});
// JOURNEY.md is the owner's private working log; a public checkout does not have it (docs/theme.md lists
// what is left out). Every other kit file must exist.
const PRIVATE_FILES = new Set(["JOURNEY.md"]);
it("lists the 21 kit files, and each one exists", () => {
  expect(KIT_FILES).toHaveLength(21);
  expect(KIT_FILES).toContain(".github/CODEOWNERS");
  expect(b.kitFiles).toEqual(KIT_FILES);
  for (const file of KIT_FILES)
    if (!PRIVATE_FILES.has(file)) expect(existsSync(file), file).toBe(true);
});
it("holds no value that looks like a secret", () => {
  expect(JSON.stringify(b)).not.toMatch(/AKIA[0-9A-Z]{16}|PRIVATE KEY|password\s*[:=]/i);
});
it("stops when the plan no longer states the extra vectors", () => {
  expect(() => buildBaseline(plan.replace("total 72991", "total 1"))).toThrow();
});
it("verify/baseline.json on disk is in sync with the plan", () => {
  expect(readFileSync("verify/baseline.json", "utf8")).toBe(JSON.stringify(b, null, 2) + "\n");
});
