import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isMarketCode } from "../config/args";
import { lockSettingWrites } from "../config/locks";
import { refused, type Written } from "../result";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// WPU-Z4: the switches an admin turns on and off in the settings table. Only the switch of the daily
// unpaid-usage job for now (`lifecycle_unpaid_enabled`, UNPAID_SETTING_KEY of packages/core/metering/unpaid.ts,
// read with lifecycleRepo(tx).readSettings): any other key is refused before a query. The row written is
// exactly the one the job reads: key, market, scope 'market', scope_id null, value JSON true or false, set_by
// the admin (admin_rw holds SELECT, INSERT and UPDATE (value, set_by) on settings since 0006: no migration).
// Every write goes through `audited` (R10). Roles: every admin reads; turning ON is superadmin only, turning
// OFF ops or superadmin, because off is the safe direction (R16). The role checks here are a second layer
// behind requireAdmin(roles) of the app; a refused role gets `forbidden` before any query.
export const ADMIN_SETTING_KEYS = ["lifecycle_unpaid_enabled"] as const;
export type AdminSettingKey = (typeof ADMIN_SETTING_KEYS)[number];

const READ_ROLES: readonly AdminRole[] = ["support", "finance", "ops", "superadmin"];
const ON_ROLES: readonly AdminRole[] = ["superadmin"];
const OFF_ROLES: readonly AdminRole[] = ["ops", "superadmin"];

const isAdminSettingKey = (value: unknown): value is AdminSettingKey =>
  (ADMIN_SETTING_KEYS as readonly unknown[]).includes(value);

export interface BooleanSettingTarget {
  key: AdminSettingKey;
  market: string;
}

export interface BooleanSettingRead {
  key: AdminSettingKey;
  market: string;
  /** What the job reads: true only for a stored JSON `true`. No row, `false` or any other value is off. */
  enabled: boolean;
  /** `none`: no row. `stored`: a row holding true or false. `invalid`: a row holding anything else. */
  source: "none" | "stored" | "invalid";
}

export interface BooleanSettingSaved {
  key: AdminSettingKey;
  market: string;
  enabled: boolean;
}

export interface SettingsAdminRepo {
  read(key: AdminSettingKey, market: string): Promise<Written<BooleanSettingRead>>;
  setBoolean(
    target: BooleanSettingTarget,
    value: boolean,
    reason: string,
  ): Promise<Written<BooleanSettingSaved>>;
}

/**
 * The audit row of a switch: action, target type and target id (`setting` + `<market>:<key>`). The write
 * stores it; the screen searches the audit log with it for the last change.
 */
export function settingAuditFilter(
  market: string,
  key: AdminSettingKey,
): { action: string; targetType: string; targetId: string } {
  return { action: "setting.set", targetType: "setting", targetId: `${market}:${key}` };
}

export function settingsAdminRepo(scope: AdminScope): SettingsAdminRepo {
  const { role } = scope.actor;
  return {
    async read(key, market) {
      if (!READ_ROLES.includes(role)) return refused("forbidden");
      if (!isAdminSettingKey(key) || !isMarketCode(market)) return refused("validation");
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      // The WHERE of readSettings, with the market of the screen.
      const found = await scope.tx.execute<{ value: unknown }>(
        sql`select value from settings
            where key = ${key} and market = ${market} and scope = 'market' and scope_id is null limit 1`,
      );
      const row = found.rows[0];
      const value: BooleanSettingRead =
        row === undefined
          ? { key, market, enabled: false, source: "none" }
          : {
              key,
              market,
              enabled: row.value === true,
              source: typeof row.value === "boolean" ? "stored" : "invalid",
            };
      return { ok: true, value, replayed: false };
    },

    async setBoolean(target, value, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { key, market } = target;
      // Anything that is not exactly `false` asks for the roles of turning on (R16).
      const roles = value === false ? OFF_ROLES : ON_ROLES;
      if (!roles.includes(role)) return refused("forbidden");
      if (typeof value !== "boolean" || !isAdminSettingKey(key) || !isMarketCode(market)) {
        return refused("validation");
      }
      const { tx, actor } = scope;
      return audited(scope, { ...settingAuditFilter(market, key), reason }, async () => {
        // Serializes the switches of one key and market: the read below sees every committed row.
        await lockSettingWrites(tx, key, market);
        const existing = await tx.execute<{ id: string; value: unknown }>(
          sql`select id, value from settings
              where key = ${key} and market = ${market} and scope = 'market' and scope_id is null limit 1`,
        );
        const row = existing.rows[0];
        const saved: BooleanSettingSaved = { key, market, enabled: value };
        // The same value again: nothing changes, and the audit row says so (before = after).
        if (row !== undefined && row.value === value) {
          return { value: saved, replayed: true, before: { value }, after: { value } };
        }
        const json = JSON.stringify(value);
        // Only the granted columns: a Drizzle insert() would name created_at (42501).
        if (row === undefined) {
          await tx.execute(
            sql`insert into settings (id, key, market, scope, scope_id, value, set_by)
                values (${uuidv7()}, ${key}, ${market}, 'market', null, ${json}::jsonb, ${actor.adminId})`,
          );
        } else {
          await tx.execute(
            sql`update settings set value = ${json}::jsonb, set_by = ${actor.adminId}
                where id = ${row.id}`,
          );
        }
        return {
          value: saved,
          replayed: false,
          before: row === undefined ? null : { value: row.value },
          after: { value },
        };
      });
    },
  };
}
