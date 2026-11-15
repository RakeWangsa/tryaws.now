import { priceCatalog } from "@tc/core";
import type { CatalogRowForPricing, Clock, PlanType, PricedCatalogRow, Result } from "@tc/core";
import { listCatalogProducts, readFeatureFlags, readMarketBasics, withTx } from "@tc/db";
import type { Tx } from "@tc/db";
import type { ProductFamily } from "@tc/ui";
import { enabledFamilies } from "../families.ts";
import { writeLog } from "../log.ts";
import { planSpecsOf } from "../servers-view.ts";
import type { PlanSpecs } from "../servers-view.ts";

// The live catalog behind the public pages (16.8). Every price is the output of the pricing engine
// for a `catalog_products` row (`priceCatalog` of @tc/core); nothing here adds, multiplies or rounds
// money (R4). A flag that is off or unreadable shows nothing of its family (R12, R16), and a catalog
// that cannot be read or priced is "unavailable": the pages then say so and show no price.

/** The one market of the public site until a second market exists. */
export const PUBLIC_MARKET = "BD";

interface PricedFamily {
  /** The catalog family and the key of its feature flag (the same text). */
  readonly family: "linux_instance" | "windows_instance" | "database";
  /** Rows of a family that mixes platforms are kept to this one; null keeps every row. */
  readonly platform: "linux" | "windows" | null;
}

// The families that have a price table on the public site, in the order of the pricing tabs.
export const PRICED_FAMILIES: readonly PricedFamily[] = Object.freeze([
  { family: "linux_instance", platform: "linux" },
  { family: "windows_instance", platform: "windows" },
  { family: "database", platform: null },
]);

export interface PublicOffer {
  readonly id: string;
  readonly family: string;
  readonly region: string;
  /**
   * Paisa, the engine's `totalMinor` (markup, VAT and fees included): exactly the amount the checkout debits
   * at today's rate. Public pages show it as taka, and only as taka (WPU-X16, owner decision of 2026-11-15).
   */
  readonly priceMinor: bigint;
  readonly specs: PlanSpecs;
  /** WPU-X24: general, memory or compute optimized; null when the sync has not stored a type. */
  readonly planType?: PlanType | null;
  /** The digits of the market setting (WPU-B6); Bengali pages use them, English pages use Latin. */
  readonly numerals?: "beng" | "latn";
}

export interface PublicFamily {
  readonly family: PricedFamily["family"];
  readonly offers: readonly PublicOffer[];
}

export type PublicCatalog =
  | {
      readonly state: "ok";
      readonly families: readonly PublicFamily[];
      /** The customer navigation families whose flag is on (R12). */
      readonly open: readonly ProductFamily[];
      readonly domainsOpen: boolean;
      /** The stored value of a product flag; a flag with no row is off. */
      flagOn(key: string): boolean;
    }
  | { readonly state: "unavailable" };

/** The ports of the loader; production wiring is `defaultDeps`, the tests pass fakes. */
export interface CatalogDeps {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  flags(tx: Tx, market: string): Promise<{ key: string; enabled: boolean }[]>;
  /** The `numerals` setting of the market; null when it cannot be read. */
  numerals(tx: Tx, market: string): Promise<"beng" | "latn" | null>;
  rows(tx: Tx, family: string): Promise<readonly CatalogRowForPricing[]>;
  price(
    tx: Tx,
    rows: readonly CatalogRowForPricing[],
    input: { market: string },
    clock: Clock,
  ): Promise<Result<readonly PricedCatalogRow[]>>;
}

export const defaultDeps: CatalogDeps = {
  run: withTx,
  flags: readFeatureFlags,
  numerals: async (tx, market) => (await readMarketBasics(tx, market))?.numerals ?? null,
  rows: listCatalogProducts,
  price: priceCatalog,
};

/** Priced rows to offers: plain sizes only, cheapest first, then by location, then by id. */
export function offersOf(rows: readonly PricedCatalogRow[]): PublicOffer[] {
  return rows
    .map((row): PublicOffer => ({
      id: row.id,
      family: row.family,
      region: row.region,
      priceMinor: row.priceBdt.totalMinor,
      specs: planSpecsOf(row.specs),
      planType: planSpecsOf(row.specs).planType ?? null,
    }))
    .sort((a, b) =>
      a.priceMinor !== b.priceMinor
        ? a.priceMinor < b.priceMinor
          ? -1
          : 1
        : a.region !== b.region
          ? a.region < b.region
            ? -1
            : 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
}

/** The cheapest offer of a list that `offersOf` sorted; null when there is none. */
export function cheapestOffer(offers: readonly PublicOffer[]): PublicOffer | null {
  return offers[0] ?? null;
}

/** Reads the flags, then prices the rows of every family whose flag is on, at one instant. */
export async function loadPublicCatalog(
  now: () => Date,
  deps: CatalogDeps = defaultDeps,
): Promise<PublicCatalog> {
  try {
    return await deps.run(async (tx) => {
      const flags = await deps.flags(tx, PUBLIC_MARKET);
      // An unreadable setting is the default of the Bengali pages, never a refusal: digits are display only.
      const numerals = (await deps.numerals(tx, PUBLIC_MARKET).catch(() => null)) ?? "beng";
      const on = new Set(flags.filter((f) => f.enabled).map((f) => f.key));
      const families: PublicFamily[] = [];
      for (const wanted of PRICED_FAMILIES) {
        if (!on.has(wanted.family)) continue;
        const all = await deps.rows(tx, wanted.family);
        const rows = all.filter((r) => wanted.platform === null || r.platform === wanted.platform);
        const priced = await deps.price(tx, rows, { market: PUBLIC_MARKET }, { now });
        // No rate or rule in force, or a row the engine refuses: nothing is priced (R16).
        if (!priced.ok) throw new Error("public catalog: not priced");
        families.push({
          family: wanted.family,
          offers: offersOf(priced.value).map((offer) => ({ ...offer, numerals })),
        });
      }
      const open = enabledFamilies(flags);
      const catalog: PublicCatalog = {
        state: "ok",
        families,
        open,
        domainsOpen: open.includes("domains"),
        flagOn: (key) => on.has(key),
      };
      return catalog;
    });
  } catch {
    // Fixed text, no error message in the log (R14).
    writeLog({ event: "public_catalog_unavailable", severity: "warn", reason: "read_or_price" });
    return { state: "unavailable" };
  }
}
