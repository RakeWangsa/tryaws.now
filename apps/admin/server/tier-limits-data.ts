import { DEFAULT_TIER_LIMITS } from "@tc/core";
import {
  RISK_TIERS,
  adminRepos,
  readMarkets,
  type AdminActor,
  type AuditRow,
  type RiskTierName,
  type TierLimitsValue,
} from "@tc/db";
import { getterOf, type Loaded, type Raw } from "./pricing-data.ts";
import { readTx } from "./pricing-runtime.ts";

// The reads of /catalog/limits (WPU-G10): the limits of each risk tier in a market, where they come from
// (a saved setting, the defaults of the core, or a saved value that cannot be read), and the audit rows of
// the changes. A refusal or a failing database gives a fixed state, never the text of an error (R14, R16).
// The loader takes the actor first: every repository read checks the role again.

export interface TierLimitsLine {
  readonly tier: RiskTierName;
  /** `stored`: an admin saved it. `default`: no row, the defaults of the core apply. `invalid`: the order path refuses this tier. */
  readonly source: "stored" | "default" | "invalid";
  /** The limits in force; null when the stored row cannot be read. */
  readonly limits: TierLimitsValue | null;
  readonly defaults: TierLimitsValue;
  /** The audit rows of this tier, newest first (who, when, why). */
  readonly history: readonly AuditRow[];
}

export interface TierLimitsScreen {
  readonly markets: readonly string[];
  readonly market: string;
  readonly lines: readonly TierLimitsLine[];
  /** The tier the page opens the editor on. */
  readonly open: RiskTierName | null;
}

const DEFAULT_MARKET = "BD";
const HISTORY_ROWS = 10;
const SEARCH_ROWS = 100;
const MARKET = /^[A-Z]{2}$/;

export async function loadTierLimits(
  admin: AdminActor,
  raw: Raw,
): Promise<Loaded<TierLimitsScreen>> {
  const get = getterOf(raw);
  const askedMarket = MARKET.test(get("market").trim()) ? get("market").trim() : DEFAULT_MARKET;
  const askedTier = get("tier");
  try {
    const value = await readTx(async (tx): Promise<TierLimitsScreen> => {
      const markets = (await readMarkets(tx)).map((m) => m.code);
      const market = markets.includes(askedMarket) ? askedMarket : (markets[0] ?? askedMarket);
      const repos = adminRepos(tx, admin);
      // A refused read (a role the repository does not serve) is an unavailable screen, not an empty one.
      const stored = await repos.tierLimits.read(market);
      if (!stored.ok) throw new Error("tier limits: the read was refused");
      const found = await repos.audit.search({
        action: "tier_limits.save",
        targetType: "tier_limits",
        limit: SEARCH_ROWS,
      });
      const lines: TierLimitsLine[] = RISK_TIERS.map((tier) => {
        const row = stored.value.rows.find((r) => r.tier === tier);
        const defaults = DEFAULT_TIER_LIMITS[tier];
        const history = found.ok
          ? found.value.rows
              .filter((r) => r.targetId === `${market}/${tier}`)
              .slice(0, HISTORY_ROWS)
          : [];
        if (row === undefined || row.state === "none") {
          return { tier, source: "default", limits: defaults, defaults, history };
        }
        if (row.state === "invalid") {
          return { tier, source: "invalid", limits: null, defaults, history };
        }
        return { tier, source: "stored", limits: row.limits, defaults, history };
      });
      const open = RISK_TIERS.find((t) => t === askedTier) ?? null;
      return { markets, market, lines, open };
    });
    return { kind: "ok", value };
  } catch {
    return { kind: "unavailable" };
  }
}
