import { priceRows } from "@tc/core";
import type { CatalogRowForPricing, PricingRule } from "@tc/core";
import type { Tx } from "@tc/db";
import { loadPublicCatalog } from "../../../server/public/catalog.ts";
import type { CatalogDeps, PublicCatalog } from "../../../server/public/catalog.ts";

// Fixtures of the public pages: a catalog that went through the REAL pricing engine (`priceRows`
// with a fixed rate and rule), so a test can compare what a page shows with the engine's output.

const label = { bn: "ক", en: "a" };
export const FIXTURE_RULE: PricingRule = {
  version: "fixture-1",
  steps: [
    { code: "markup", rate: "0.20", base: "aws", label },
    { code: "bd_vat", rate: "0.15", base: "subtotal", label },
  ],
};
export const FIXTURE_FX = "122.5000";

const row = (
  id: string,
  over: Partial<CatalogRowForPricing> & { specs?: unknown } = {},
): CatalogRowForPricing => ({
  id,
  family: "linux_instance",
  awsId: "x",
  platform: "linux",
  region: "ap-southeast-1",
  specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 2000 },
  awsPriceUsd: "5.0000",
  billingUnit: "month",
  featureFlag: "linux_instance",
  active: true,
  ...over,
});

export const FIXTURE_ROWS: Readonly<Record<string, readonly CatalogRowForPricing[]>> = {
  linux_instance: [
    row("11111111-1111-4111-8111-111111111111"),
    row("22222222-2222-4222-8222-222222222222", {
      region: "ap-south-1",
      awsPriceUsd: "4.0000",
      specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 1000 },
    }),
    row("33333333-3333-4333-8333-333333333333", {
      awsPriceUsd: "20.0000",
      specs: { vcpus: 2, ramGb: "4", diskGb: 80, transferGb: 4000 },
    }),
    row("44444444-4444-4444-8444-444444444444", {
      awsPriceUsd: "40.0000",
      specs: { vcpus: 4, ramGb: "8", diskGb: 160, transferGb: 5000 },
    }),
  ],
  windows_instance: [
    row("55555555-5555-4555-8555-555555555555", {
      family: "windows_instance",
      platform: "windows",
      awsPriceUsd: "9.0000",
    }),
  ],
  database: [
    row("66666666-6666-4666-8666-666666666666", {
      family: "database",
      platform: null,
      awsPriceUsd: "15.0000",
      specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 100 },
    }),
  ],
};

export function fixtureDeps(flags: readonly string[]): CatalogDeps {
  return {
    run: async (fn) => fn({} as Tx),
    flags: async () => flags.map((key) => ({ key, enabled: true })),
    rows: async (_tx, family) => FIXTURE_ROWS[family] ?? [],
    price: async (_tx, rows) => {
      const found = {
        fx: { rate: FIXTURE_FX },
        rule: { value: FIXTURE_RULE },
      } as never;
      const priced = priceRows(
        rows,
        new Map(["linux_instance", "windows_instance", "database"].map((f) => [f, found])),
        {},
      );
      return priced === null ? { ok: false, error: "not_found" } : { ok: true, value: priced };
    },
  };
}

export const NOW = () => new Date("2026-11-12T00:00:00Z");

/** Cloud Server (Linux) and Managed Database open; Windows and the other families off. */
export async function openCatalog(
  flags: readonly string[] = ["linux_instance", "database"],
): Promise<PublicCatalog> {
  return loadPublicCatalog(NOW, fixtureDeps(flags));
}

export const UNAVAILABLE: PublicCatalog = { state: "unavailable" };
export const ORIGIN = "https://cloud.example.test";
export const NONCE = "test-nonce-0123456789";
