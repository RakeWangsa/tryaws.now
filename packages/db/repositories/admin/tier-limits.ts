import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isMarketCode } from "../config/args";
import { lockTierLimitsWrites } from "../config/locks";
import {
  RISK_TIERS,
  TIER_LIMITS_KEY,
  isRiskTierName,
  parseTierLimitsValue,
  tierLimitsValueOf,
  type RiskTierName,
  type TierLimitsValue,
} from "../config/tier-limits";
import { refused, type Written } from "../result";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /catalog/limits, the limits of a risk tier (WPU-G10). `ops` and `superadmin`, the roles of the
// catalog area; the role check here is a second layer behind requireAdmin(roles) of the app (R9, R16).
// The write changes the setting `tier_limits` of scope 'tier' (admin_rw already writes `settings`) and
// goes through `audited` (R10): actor, reason, IP and target are stored with the before and after values
// in the same transaction. Lowering a limit does not touch a resource a customer already has; it only
// stops new orders past the limit (the order path counts again at the draft and at the purchase).
const ROLES: readonly AdminRole[] = ["ops", "superadmin"];

export interface TierLimitsInput {
  market: string;
  tier: RiskTierName;
  limits: TierLimitsValue;
}

export interface TierLimitsSaved {
  market: string;
  tier: RiskTierName;
  limits: TierLimitsValue;
}

export type StoredTierLimits =
  | { tier: RiskTierName; state: "none" }
  | { tier: RiskTierName; state: "invalid" }
  | { tier: RiskTierName; state: "ok"; limits: TierLimitsValue };

export interface TierLimitsAdminRepo {
  /** One entry for each tier: stored, absent (the defaults apply) or invalid (the tier is refused). */
  read(market: string): Promise<Written<{ rows: StoredTierLimits[] }>>;
  save(input: TierLimitsInput, reason: string): Promise<Written<TierLimitsSaved>>;
}

const same = (a: TierLimitsValue, b: TierLimitsValue): boolean =>
  a.maxInstances === b.maxInstances &&
  a.maxBundleUsd === b.maxBundleUsd &&
  a.windows === b.windows &&
  a.containers === b.containers &&
  a.maxStaticIps === b.maxStaticIps;

export function tierLimitsAdminRepo(scope: AdminScope): TierLimitsAdminRepo {
  const { role } = scope.actor;
  return {
    async read(market) {
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market)) return refused("validation");
      const found = await scope.tx.execute<{ scope_id: string; value: unknown }>(
        sql`select scope_id, value from settings
            where key = ${TIER_LIMITS_KEY} and market = ${market} and scope = 'tier'`,
      );
      const rows: StoredTierLimits[] = RISK_TIERS.map((tier) => {
        const row = found.rows.find((r) => r.scope_id === tier);
        if (row === undefined) return { tier, state: "none" };
        const limits = parseTierLimitsValue(row.value);
        return limits === null ? { tier, state: "invalid" } : { tier, state: "ok", limits };
      });
      return { ok: true, value: { rows }, replayed: false };
    },

    async save(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, tier, limits } = input;
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market) || !isRiskTierName(tier)) return refused("validation");
      // Only the fields that are stored, so a request cannot add keys to the row.
      const checked = parseTierLimitsValue(tierLimitsValueOf(limits));
      if (checked === null) return refused("validation");
      const { tx, actor } = scope;
      return audited(
        scope,
        {
          action: "tier_limits.save",
          targetType: "tier_limits",
          targetId: `${market}/${tier}`,
          reason,
        },
        async () => {
          // Serializes the saves of one market: the read below sees every committed row.
          await lockTierLimitsWrites(tx, market);
          const existing = await tx.execute<{ id: string; value: unknown }>(
            sql`select id, value from settings
                where key = ${TIER_LIMITS_KEY} and market = ${market}
                  and scope = 'tier' and scope_id = ${tier}`,
          );
          const row = existing.rows[0];
          // A stored row that does not parse is replaced by this save (the audit log holds the old
          // value); it is never read as a limit (R16).
          const current = row === undefined ? null : parseTierLimitsValue(row.value);
          const value: TierLimitsSaved = { market, tier, limits: checked };
          if (current !== null && same(current, checked)) {
            return { value, replayed: true, before: current, after: current };
          }
          const json = JSON.stringify(tierLimitsValueOf(checked));
          // Only the granted columns: a Drizzle insert() would name created_at (42501).
          if (row === undefined) {
            await tx.execute(
              sql`insert into settings (id, key, market, scope, scope_id, value, set_by)
                  values (${uuidv7()}, ${TIER_LIMITS_KEY}, ${market}, 'tier', ${tier}, ${json}::jsonb, ${actor.adminId})`,
            );
          } else {
            await tx.execute(
              sql`update settings set value = ${json}::jsonb, set_by = ${actor.adminId}
                  where id = ${row.id}`,
            );
          }
          return { value, replayed: false, before: current, after: checked };
        },
      );
    },
  };
}
