import {
  FEATURE_FLAGS,
  listFeatureFlags,
  previewBook,
  priceCatalog,
  type BookPreview,
  type PricedCatalogRow,
} from "@tc/core";
import {
  ADMIN_PRICED_FAMILIES,
  adminRepos,
  entryInForce,
  listCatalogProductsForAdmin,
  readFxRateInForce,
  readMarkets,
  type AdminActor,
  type AuditRow,
  type CatalogAdminRow,
  type FxRateRow,
  type PriceBookEntry,
} from "@tc/db";
import {
  fractionToPercent,
  readBookDraft,
  termsOfDraft,
  type BookDraft,
} from "./price-book-draft.ts";
import { getterOf, type Loaded, type Raw } from "./pricing-data.ts";
import { readTx } from "./pricing-runtime.ts";

// The reads of /pricing/book, the price list (WPA-P1). A refusal or a failing database gives a fixed state,
// never the text of an error (R14, R16). Money is bigint paisa in a PriceQuote and decimal text elsewhere
// (R4). The loader takes the actor first: every repository read checks the role again.

export interface PriceListProduct {
  readonly row: CatalogAdminRow;
  // null: no rate or rule in force for this family in the market, so no price is shown (R16).
  readonly price: PricedCatalogRow | null;
}

export interface PriceListFamily {
  readonly family: string;
  readonly enabled: boolean;
  readonly products: readonly PriceListProduct[];
  // The settings of the family, oldest first; empty when none was ever set.
  readonly entries: readonly PriceBookEntry[];
  readonly inForce: PriceBookEntry | null;
  // The next change that has not started.
  readonly scheduled: PriceBookEntry | null;
  // The stored book does not parse: the family is not priced until an admin saves a new one.
  readonly invalid: boolean;
  // The base cost is the admin's (no AWS API fills it).
  readonly baseEditable: boolean;
}

export type EditPreview =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly preview: BookPreview }
  | { readonly kind: "invalid"; readonly fields: readonly string[] }
  | { readonly kind: "unavailable" };

export interface PriceListEdit {
  readonly family: string;
  readonly draft: BookDraft;
  // "terms": the margin form was submitted. "base": the base cost form was. "": neither.
  readonly go: "" | "terms" | "base";
  readonly baseProduct: string;
  readonly baseUsd: string;
  readonly preview: EditPreview;
  // The audit rows of the base cost of this family (newest first); empty for a synced family.
  readonly baseHistory: readonly AuditRow[];
}

export interface PriceListScreen {
  readonly markets: readonly string[];
  readonly market: string;
  readonly fx: FxRateRow | null;
  readonly families: readonly PriceListFamily[];
  readonly edit: PriceListEdit | null;
  readonly now: Date;
}

const DEFAULT_MARKET = "BD";
const BASE_HISTORY_PRODUCTS = 10;
const BASE_HISTORY_ROWS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function loadPriceList(
  admin: AdminActor,
  raw: Raw,
  clock: { now(): Date } = { now: () => new Date() },
): Promise<Loaded<PriceListScreen>> {
  const get = getterOf(raw);
  const asked = readBookDraft(get, DEFAULT_MARKET);
  const go = get("go") === "terms" ? "terms" : get("go") === "base" ? "base" : "";
  try {
    const value = await readTx(async (tx): Promise<PriceListScreen> => {
      const now = clock.now();
      const once = { now: () => now };
      const markets = (await readMarkets(tx)).map((m) => m.code);
      const market = markets.includes(asked.market) ? asked.market : (markets[0] ?? asked.market);
      const repos = adminRepos(tx, admin);
      // A refused read (a role the repository does not serve) is an unavailable screen, not an empty one.
      const books = await repos.priceBook.read(market);
      if (!books.ok) throw new Error("price list: the book was refused");
      const [fx, flags, catalog] = await Promise.all([
        readFxRateInForce(tx, market, now),
        listFeatureFlags(tx, market),
        listCatalogProductsForAdmin(tx, {}),
      ]);

      const byFamily = new Map<string, CatalogAdminRow[]>();
      for (const row of catalog)
        byFamily.set(row.family, [...(byFamily.get(row.family) ?? []), row]);
      const families: PriceListFamily[] = [];
      for (const family of FEATURE_FLAGS) {
        const list = byFamily.get(family) ?? [];
        const priced =
          list.length === 0
            ? null
            : await priceCatalog(tx, list, { market, includeInactive: true }, once);
        const byId = new Map<string, PricedCatalogRow>(
          priced !== null && priced.ok ? priced.value.map((p) => [p.id, p]) : [],
        );
        const entries = books.value.rows.find((r) => r.family === family)?.entries ?? [];
        families.push({
          family,
          enabled: flags.find((f) => f.key === family)?.enabled === true,
          products: list.map((row) => ({ row, price: byId.get(row.id) ?? null })),
          entries,
          inForce: entryInForce(entries, now),
          scheduled: entries.find((e) => e.from.getTime() > now.getTime()) ?? null,
          invalid: books.value.invalid.includes(family),
          baseEditable: ADMIN_PRICED_FAMILIES.includes(family),
        });
      }

      let edit: PriceListEdit | null = null;
      const target = families.find((f) => f.family === asked.family);
      if (target !== undefined) {
        // The editor opens on the terms in force; a submitted form shows what was typed.
        const open = target.inForce;
        const draft: BookDraft =
          go === "terms" || open === null
            ? { ...asked, market }
            : {
                ...asked,
                market,
                marginKind: open.margin.kind,
                margin:
                  open.margin.kind === "percent"
                    ? fractionToPercent(open.margin.value)
                    : open.margin.value,
                commissionKind: open.commission?.kind ?? "none",
                commission:
                  open.commission === null
                    ? ""
                    : open.commission.kind === "percent"
                      ? fractionToPercent(open.commission.value)
                      : open.commission.value,
              };
        const baseProduct = UUID.test(get("product")) ? get("product") : "";
        const baseUsd = get("usd").trim().slice(0, 14);
        let preview: EditPreview = { kind: "none" };
        if (go === "terms") {
          const terms = termsOfDraft(draft);
          if (!terms.ok) preview = { kind: "invalid", fields: terms.fields };
          else {
            const shown = await previewBook(
              tx,
              { market, productFamily: target.family, terms: terms.terms },
              once,
            );
            preview = shown.ok
              ? { kind: "ok", preview: shown.value }
              : shown.error === "validation"
                ? { kind: "invalid", fields: Object.keys(shown.fields ?? {}).slice(0, 8) }
                : { kind: "unavailable" };
          }
        } else if (go === "base") {
          const shown = await previewBook(
            tx,
            {
              market,
              productFamily: target.family,
              base: { productId: baseProduct, awsPriceUsd: baseUsd },
            },
            once,
          );
          preview = shown.ok
            ? { kind: "ok", preview: shown.value }
            : shown.error === "validation"
              ? { kind: "invalid", fields: Object.keys(shown.fields ?? {}).slice(0, 8) }
              : { kind: "unavailable" };
        }
        const baseHistory: AuditRow[] = [];
        if (target.baseEditable) {
          for (const product of target.products.slice(0, BASE_HISTORY_PRODUCTS)) {
            const found = await repos.audit.search({
              action: "catalog_price.set_base",
              targetType: "catalog_product",
              targetId: product.row.id,
              limit: BASE_HISTORY_ROWS,
            });
            if (found.ok) baseHistory.push(...found.value.rows);
          }
          baseHistory.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        edit = {
          family: target.family,
          draft,
          go,
          baseProduct,
          baseUsd,
          preview,
          baseHistory: baseHistory.slice(0, BASE_HISTORY_ROWS),
        };
      }
      return { markets, market, fx, families, edit, now };
    });
    return { kind: "ok", value };
  } catch {
    return { kind: "unavailable" };
  }
}
