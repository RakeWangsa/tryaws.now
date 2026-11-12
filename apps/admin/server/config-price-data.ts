import { CONFIG_PRICE_FAMILY, previewConfigPrice, type ConfigPricePreview } from "@tc/core";
import {
  CONFIG_PRICE_KEYS,
  CONFIG_PRICE_TEXT,
  CONFIG_PRICE_UNIT_OF,
  adminRepos,
  entryOfConfigPriceAt,
  isConfigPriceKey,
  readFxRateInForce,
  readMarkets,
  type AdminActor,
  type AuditRow,
  type ConfigPriceEntry,
  type ConfigPriceKey,
  type ConfigPriceUnit,
  type FxRateRow,
} from "@tc/db";
import { getterOf, type Loaded, type Raw } from "./pricing-data.ts";
import { startOf } from "./pricing-draft.ts";
import { readTx } from "./pricing-runtime.ts";

// The reads of /pricing/config (WPU-G10): the prices that no AWS API fills. A refusal or a failing database
// gives a fixed state, never the text of an error (R14, R16). Money is bigint paisa in a figure of the
// engine and decimal text elsewhere (R4). The loader takes the actor first: every repository read checks
// the role again.

/**
 * The config prices that a customer is charged from today. Verified by search of the code: the hosted
 * zone, the disk (block storage) and the load balancer are read when an order is priced
 * (`resolveOrderProduct`, WPU-G10 and WPA-P2: the config row wins for new orders when the market has a
 * usable one, otherwise the catalog row stays), and the snapshot price is read by the daily metered
 * charge (`runMetering`, WPA-P2) and by the screens. Adding a reader means adding the key here.
 */
export const READ_BY_ORDERS: ReadonlySet<ConfigPriceKey> = new Set([
  "config_price.block_storage_gb_month",
  "config_price.snapshot_gb_month",
  "config_price.load_balancer_month",
  "config_price.dns_zone_month",
]);

export interface ConfigPriceLine {
  readonly key: ConfigPriceKey;
  readonly unit: ConfigPriceUnit;
  readonly family: string;
  /** The entries, oldest first; empty when none was ever saved. */
  readonly entries: readonly ConfigPriceEntry[];
  readonly inForce: ConfigPriceEntry | null;
  /** The next change that has not started. */
  readonly scheduled: ConfigPriceEntry | null;
  /** The stored value does not parse: nothing is priced from it until an admin saves a new one. */
  readonly invalid: boolean;
  /** One billing unit priced by the engine under the price in force; null when it cannot be priced. */
  readonly customerPrice: ConfigPricePreview["candidate"] | null;
  readonly readByOrders: boolean;
}

export type ConfigEditPreview =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly preview: ConfigPricePreview }
  | { readonly kind: "invalid"; readonly fields: readonly string[] }
  | { readonly kind: "unavailable" };

export interface ConfigPriceEdit {
  readonly key: ConfigPriceKey;
  readonly usd: string;
  // Dhaka wall time "YYYY-MM-DDTHH:mm" or "" for now.
  readonly from: string;
  readonly go: boolean;
  readonly preview: ConfigEditPreview;
  /** The audit rows of this price, newest first (who, when, why). */
  readonly history: readonly AuditRow[];
}

export interface ConfigPriceScreen {
  readonly markets: readonly string[];
  readonly market: string;
  readonly fx: FxRateRow | null;
  readonly lines: readonly ConfigPriceLine[];
  readonly edit: ConfigPriceEdit | null;
  readonly now: Date;
}

const DEFAULT_MARKET = "BD";
const HISTORY_ROWS = 10;
const SEARCH_ROWS = 100;
const MARKET = /^[A-Z]{2}$/;

export async function loadConfigPrices(
  admin: AdminActor,
  raw: Raw,
  clock: { now(): Date } = { now: () => new Date() },
): Promise<Loaded<ConfigPriceScreen>> {
  const get = getterOf(raw);
  const askedMarket = MARKET.test(get("market").trim()) ? get("market").trim() : DEFAULT_MARKET;
  const askedKey = get("key");
  const go = get("go") === "preview";
  try {
    const value = await readTx(async (tx): Promise<ConfigPriceScreen> => {
      const now = clock.now();
      const once = { now: () => now };
      const markets = (await readMarkets(tx)).map((m) => m.code);
      const market = markets.includes(askedMarket) ? askedMarket : (markets[0] ?? askedMarket);
      const repos = adminRepos(tx, admin);
      // A refused read (a role the repository does not serve) is an unavailable screen, not an empty one.
      const stored = await repos.configPrices.read(market);
      if (!stored.ok) throw new Error("config prices: the read was refused");
      const fx = await readFxRateInForce(tx, market, now);

      const lines: ConfigPriceLine[] = [];
      for (const key of CONFIG_PRICE_KEYS) {
        const entries = stored.value.rows.find((r) => r.key === key)?.entries ?? [];
        const inForce = entryOfConfigPriceAt(entries, now);
        let customerPrice: ConfigPriceLine["customerPrice"] = null;
        if (inForce !== null) {
          const shown = await previewConfigPrice(tx, { market, key, usd: inForce.usd }, once);
          customerPrice = shown.ok ? shown.value.candidate : null;
        }
        lines.push({
          key,
          unit: CONFIG_PRICE_UNIT_OF[key],
          family: CONFIG_PRICE_FAMILY[key],
          entries,
          inForce,
          scheduled: entries.find((e) => e.from.getTime() > now.getTime()) ?? null,
          invalid: stored.value.invalid.includes(key),
          customerPrice,
          readByOrders: READ_BY_ORDERS.has(key),
        });
      }

      let edit: ConfigPriceEdit | null = null;
      const target = lines.find((l) => l.key === askedKey);
      if (target !== undefined && isConfigPriceKey(target.key)) {
        const usd = go ? get("usd").trim().slice(0, 14) : (target.inForce?.usd ?? "");
        const from = go ? get("from").trim().slice(0, 16) : "";
        let preview: ConfigEditPreview = { kind: "none" };
        if (go) {
          const bad: string[] = [];
          if (!CONFIG_PRICE_TEXT.test(usd) || !/[1-9]/.test(usd)) bad.push("usd");
          if (startOf(from) === null) bad.push("from");
          if (bad.length > 0) preview = { kind: "invalid", fields: bad };
          else {
            const shown = await previewConfigPrice(
              tx,
              {
                market,
                key: target.key,
                usd,
                ...(target.inForce === null ? {} : { current: target.inForce.usd }),
              },
              once,
            );
            preview = shown.ok
              ? { kind: "ok", preview: shown.value }
              : shown.error === "validation"
                ? { kind: "invalid", fields: Object.keys(shown.fields ?? {}).slice(0, 8) }
                : { kind: "unavailable" };
          }
        }
        // The reasons: the audit rows of this price (action, market and key in the target id).
        const found = await repos.audit.search({
          action: "config_price.save",
          targetType: "config_price",
          limit: SEARCH_ROWS,
        });
        const history = found.ok
          ? found.value.rows
              .filter((r) => (r.targetId ?? "").startsWith(`${market}/${target.key}@`))
              .slice(0, HISTORY_ROWS)
          : [];
        edit = { key: target.key, usd, from, go, preview, history };
      }
      return { markets, market, fx, lines, edit, now };
    });
    return { kind: "ok", value };
  } catch {
    return { kind: "unavailable" };
  }
}
