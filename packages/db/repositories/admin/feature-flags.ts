import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { featureFlags } from "../../schema/index";
import type { Written } from "../result";
import { audited } from "./audited";
import type { AdminScope } from "./index";

// Not called FeatureFlag: that name is the flag argument of isEnabled in packages/core/flags.
export interface FeatureFlagSetting {
  key: string;
  market: string;
  enabled: boolean;
}

export interface FeatureFlagsAdminRepo {
  set(input: FeatureFlagSetting, reason: string): Promise<Written<FeatureFlagSetting>>;
}

export function featureFlagsAdminRepo(scope: AdminScope): FeatureFlagsAdminRepo {
  return {
    async set(input, reason) {
      const { key, market, enabled } = input;
      return audited(
        scope,
        {
          action: "feature_flag.set",
          targetType: "feature_flag",
          targetId: `${market}:${key}`,
          reason,
        },
        async () => {
          // FOR UPDATE needs UPDATE on one column; admin_rw has UPDATE (enabled).
          const [current] = await scope.tx
            .select({ enabled: featureFlags.enabled })
            .from(featureFlags)
            .where(and(eq(featureFlags.key, key), eq(featureFlags.market, market)))
            .for("update");
          // A Drizzle insert() would name created_at, which admin_rw may not insert (42501); id has no
          // database default, so the statement supplies it.
          const result = await scope.tx.execute(
            sql`insert into feature_flags (id, key, market, enabled) values (${uuidv7()}, ${key}, ${market}, ${enabled}) on conflict (key, market) do update set enabled = excluded.enabled returning key, market, enabled`,
          );
          const row = result.rows[0] as unknown as FeatureFlagSetting;
          return {
            value: { key: row.key, market: row.market, enabled: row.enabled },
            replayed: current?.enabled === enabled,
            before: current ? { enabled: current.enabled } : null,
            after: { enabled },
          };
        },
      );
    },
  };
}
