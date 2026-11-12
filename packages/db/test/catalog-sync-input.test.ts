import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import {
  applyCatalogScope,
  applyTlds,
  type CatalogRowWrite,
} from "../repositories/system/catalog-sync";
import { CONFIG_PRICE_KEYS, seedConfigPrices } from "../seed/config-prices";

// No database here: every input check runs before the first statement, so a transaction that
// throws on any use proves "throws before any statement" (R16) and the message holds no value (R14).
const noTx = new Proxy(
  {},
  {
    get() {
      throw new Error("the transaction was touched");
    },
  },
) as unknown as Tx;
const AT = new Date("2026-11-11T06:00:00Z");
const row = (over: Partial<CatalogRowWrite> = {}): CatalogRowWrite => ({
  family: "linux_instance",
  awsId: "nano_3_0",
  platform: "linux",
  region: "ap-southeast-1",
  specs: { vcpus: 2 },
  awsPriceUsd: "5",
  billingUnit: "month",
  featureFlag: "linux_instance",
  active: true,
  ...over,
});
const apply = (rows: CatalogRowWrite[]) =>
  applyCatalogScope(noTx, { rows, deactivate: [], at: AT });

it.each([
  ["a price with 5 decimals", { awsPriceUsd: "1.23456" }, "awsPriceUsd"],
  ["a negative price", { awsPriceUsd: "-1" }, "awsPriceUsd"],
  ["an exponent price", { awsPriceUsd: "1e-7" }, "awsPriceUsd"],
  ["an id with a space", { awsId: "a b" }, "awsId"],
  ["an id with a path", { awsId: "../x" }, "awsId"],
  ["an unknown feature flag", { featureFlag: "mystery" }, "featureFlag"],
  ["a bad Region", { region: "Mars 1" }, "region"],
  ["a bad family", { family: "Linux Instance" }, "family"],
] as const)(
  "%s throws before any statement and names the field, not the value",
  async (_l, over, field) => {
    const error = await apply([row(over)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    const message = (error as Error).message;
    expect(message).toContain(field);
    for (const value of Object.values(over)) expect(message).not.toContain(String(value));
  },
);

it("an invalid instant throws before any statement", async () => {
  await expect(
    applyCatalogScope(noTx, { rows: [row()], deactivate: [], at: new Date("nope") }),
  ).rejects.toBeInstanceOf(TypeError);
});

it("a deactivate key is checked too", async () => {
  await expect(
    applyCatalogScope(noTx, {
      rows: [],
      deactivate: [{ family: "linux_instance", awsId: "a b", region: "ap-southeast-1" }],
      at: AT,
    }),
  ).rejects.toThrow(/awsId/);
});

it("applyTlds refuses a bad tld or a price with 5 decimals before any statement", async () => {
  const ok = {
    registrationUsd: "12",
    renewalUsd: null,
    transferUsd: null,
    needsExtraParams: false,
  };
  await expect(applyTlds(noTx, { rows: [{ tld: "Bad TLD!", ...ok }], at: AT })).rejects.toThrow(
    /tld/,
  );
  await expect(
    applyTlds(noTx, { rows: [{ tld: "com", ...ok, registrationUsd: "1.23456" }], at: AT }),
  ).rejects.toThrow(/registrationUsd/);
});

it("seedConfigPrices refuses a bad price, key, unit or market before any statement", async () => {
  const base = { market: "BD", at: AT };
  const price = (over: Record<string, unknown>) => ({
    key: "config_price.block_storage_gb_month",
    usd: "0.10",
    unit: "gb_month",
    ...over,
  });
  for (const usd of ["0.10000", "-1", "abc", "", "1e3"]) {
    await expect(
      seedConfigPrices(noTx, { ...base, prices: [price({ usd }) as never] }),
    ).rejects.toThrow(/usd/);
  }
  await expect(
    seedConfigPrices(noTx, { ...base, prices: [price({ key: "config_price.x" }) as never] }),
  ).rejects.toThrow(/key/);
  await expect(
    seedConfigPrices(noTx, { ...base, prices: [price({ unit: "hour" }) as never] }),
  ).rejects.toThrow(/unit/);
  await expect(
    seedConfigPrices(noTx, { market: "bd", at: AT, prices: [price({}) as never] }),
  ).rejects.toThrow(/market/);
});

it("the keys follow the spec list and the WPU-M1 static IP hour price", () => {
  expect([...CONFIG_PRICE_KEYS]).toEqual([
    "config_price.block_storage_gb_month",
    "config_price.snapshot_gb_month",
    "config_price.load_balancer_month",
    "config_price.dns_zone_month",
    "config_price.static_ip_unattached_hour",
  ]);
});

it("the repository has no delete statement and no float step on a price (R4, R5)", () => {
  for (const file of ["../repositories/system/catalog-sync.ts", "../seed/config-prices.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(src).not.toMatch(/\.delete\(|delete\s+from|\bDELETE\b/i);
    for (const banned of ["Number(", "parseFloat", "toFixed", "Math.round"]) {
      expect(src.includes(banned)).toBe(false);
    }
  }
});
