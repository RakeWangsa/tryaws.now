import { priceRows, quote } from "@tc/core";
import type { CatalogRowForPricing, PricedCatalogRow, PricingRule } from "@tc/core";
import type { Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_MARKET,
  cheapestOffer,
  loadPublicCatalog,
  offersOf,
  type CatalogDeps,
} from "./catalog.ts";

const label = { bn: "ক", en: "a" };
const RULE: PricingRule = {
  version: "rule-1",
  steps: [
    { code: "markup", rate: "0.20", base: "aws", label },
    { code: "bd_vat", rate: "0.15", base: "subtotal", label },
  ],
};
const FX = "122.5000";

function row(over: Partial<CatalogRowForPricing> & { id: string }): CatalogRowForPricing {
  return {
    family: "linux_instance",
    awsId: "nano_3_0",
    platform: "linux",
    region: "ap-southeast-1",
    specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 2000 },
    awsPriceUsd: "5.0000",
    billingUnit: "month",
    featureFlag: "linux_instance",
    active: true,
    ...over,
  };
}

const ROWS: Record<string, CatalogRowForPricing[]> = {
  linux_instance: [
    row({ id: "l-sg-1", awsPriceUsd: "5.0000" }),
    row({
      id: "l-mum-1",
      region: "ap-south-1",
      awsPriceUsd: "4.0000",
      specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 1000 },
    }),
    row({
      id: "l-sg-4",
      awsPriceUsd: "20.0000",
      specs: { vcpus: 2, ramGb: "4", diskGb: 80, transferGb: 4000 },
    }),
    row({ id: "w-ignored", platform: "windows", awsPriceUsd: "1.0000" }),
  ],
  windows_instance: [row({ id: "w-sg-2", family: "windows_instance", platform: "windows" })],
  database: [row({ id: "d-sg", family: "database", platform: null, awsPriceUsd: "15.0000" })],
};

function deps(flags: { key: string; enabled: boolean }[], calls: string[] = []): CatalogDeps {
  return {
    run: async (fn) => fn({} as Tx),
    flags: async (_tx, market) => {
      calls.push(`flags:${market}`);
      return flags;
    },
    rows: async (_tx, family) => {
      calls.push(`rows:${family}`);
      return ROWS[family] ?? [];
    },
    // The real engine, with a fixed rate and rule: the loader must hand its numbers through.
    price: async (_tx, rows) => {
      const priced = priceRows(
        rows,
        new Map(
          ["linux_instance", "windows_instance", "database"].map((family) => [
            family,
            { fx: { rate: FX }, rule: { value: RULE } } as never,
          ]),
        ),
        {},
      );
      return priced === null ? { ok: false, error: "not_found" } : { ok: true, value: priced };
    },
  };
}

const NOW = () => new Date("2026-11-12T00:00:00Z");

describe("loadPublicCatalog", () => {
  it("prices every offer with the pricing engine and shows nothing else (R4)", async () => {
    const result = await loadPublicCatalog(NOW, deps([{ key: "linux_instance", enabled: true }]));
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    const linux = result.families.find((f) => f.family === "linux_instance");
    expect(linux).toBeDefined();
    // Linux rows only: the windows row inside the linux family is not an offer.
    const ids = (linux as { offers: { id: string }[] }).offers.map((o) => o.id);
    expect(ids).toEqual(["l-mum-1", "l-sg-1", "l-sg-4"]);
    for (const offer of (linux as { offers: PricedLike[] }).offers) {
      const source = ROWS["linux_instance"]!.find((r) => r.id === offer.id)!;
      const expected = quote({ awsPriceUsd: source.awsPriceUsd, fxRate: FX, rule: RULE });
      expect(offer.priceMinor).toBe(expected.totalMinor);
      expect(typeof offer.priceMinor).toBe("bigint");
    }
  });

  it("reads the flags of the public market and lists only the families whose flag is on (R12)", async () => {
    const calls: string[] = [];
    const result = await loadPublicCatalog(
      NOW,
      deps(
        [
          { key: "linux_instance", enabled: true },
          { key: "windows_instance", enabled: false },
          { key: "database", enabled: true },
          { key: "bucket", enabled: true },
          { key: "domain", enabled: true },
        ],
        calls,
      ),
    );
    expect(calls[0]).toBe(`flags:${PUBLIC_MARKET}`);
    expect(calls).not.toContain("rows:windows_instance");
    if (result.state !== "ok") throw new Error("expected ok");
    expect(result.families.map((f) => f.family)).toEqual(["linux_instance", "database"]);
    expect(result.open).toEqual(["cloudServers", "databases", "objectStorage", "domains"]);
    expect(result.domainsOpen).toBe(true);
    expect(result.flagOn("bucket")).toBe(true);
    expect(result.flagOn("cdn")).toBe(false);
  });

  it("is 'unavailable' when the flags cannot be read, the catalog cannot be priced or the database throws (R16)", async () => {
    const base = deps([{ key: "linux_instance", enabled: true }]);
    const broken: CatalogDeps = { ...base, run: async () => Promise.reject(new Error("down")) };
    expect(await loadPublicCatalog(NOW, broken)).toEqual({ state: "unavailable" });
    const noRate: CatalogDeps = {
      ...base,
      price: async () => ({ ok: false, error: "not_found" }),
    };
    expect(await loadPublicCatalog(NOW, noRate)).toEqual({ state: "unavailable" });
  });

  it("a family with a flag on and no active row has no offers, not an error", async () => {
    const base = deps([{ key: "database", enabled: true }]);
    const empty: CatalogDeps = { ...base, rows: async () => [] };
    const result = await loadPublicCatalog(NOW, {
      ...empty,
      price: async () => ({ ok: true, value: [] as PricedCatalogRow[] }),
    });
    if (result.state !== "ok") throw new Error("expected ok");
    expect(result.families).toEqual([{ family: "database", offers: [] }]);
  });
});

interface PricedLike {
  id: string;
  priceMinor: bigint;
}

describe("offersOf and cheapestOffer", () => {
  it("sorts by price, then location, and takes the specs as plain sizes only", () => {
    const offers = offersOf([
      {
        id: "b",
        family: "linux_instance",
        region: "ap-southeast-1",
        platform: "linux",
        specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 2000, junk: "<b>" },
        awsPriceUsd: "5.0000",
        priceBdt: { totalMinor: 90000n } as never,
      },
      {
        id: "a",
        family: "linux_instance",
        region: "ap-south-1",
        platform: "linux",
        specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 1000 },
        awsPriceUsd: "5.0000",
        priceBdt: { totalMinor: 90000n } as never,
      },
    ]);
    expect(offers.map((o) => o.id)).toEqual(["a", "b"]);
    expect(offers[1]?.specs).toEqual({ vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 2000 });
    expect(cheapestOffer(offers)?.id).toBe("a");
    expect(cheapestOffer([])).toBeNull();
  });
});
