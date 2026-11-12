import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { isMarketCode } from "../config/args";
import {
  IMAGE_ALLOWLIST_KEY,
  IMAGE_ALLOWLIST_MAX,
  IMAGE_MIN_POWER_MAX,
  imageSwitchesValueOf,
  parseImageSwitches,
  readImageSwitches,
  type ImageSwitches,
} from "../config/image-allowlist";
import { lockImageAllowListWrites } from "../config/locks";
import { listImagesForAdmin, type ImageRow } from "../blueprints";
import { refused, type Written } from "../result";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /catalog, the image allow-list (WPU-G3): which Lightsail blueprints the Linux create wizard
// offers in a market. `ops` and `superadmin`, the roles of the catalog section; the role check here is a
// second layer behind requireAdmin(roles) of the app (R9, R16). The write changes the market setting
// `image_allowlist` (admin_rw already writes `settings`) and goes through `audited` (R10): actor,
// reason, IP and target are stored with the before and after values in the same transaction. Switching
// an image off does not touch a server that already runs it; it only stops new orders (the order path
// checks the allow-list again at the draft and at the purchase).
const ROLES: readonly AdminRole[] = ["ops", "superadmin"];
const BLUEPRINT_ID = /^[a-z0-9_]{1,64}$/;

export interface BlueprintSetInput {
  market: string;
  blueprintId: string;
  enabled: boolean;
}

export interface BlueprintSaved {
  market: string;
  blueprintId: string;
  enabled: boolean;
}

export interface BlueprintsView {
  /** Every synced image row of every Region. */
  images: ImageRow[];
  /** The explicit switches of the market; `invalid` is a stored row that does not parse (nothing is offered). */
  switches:
    | { state: "none" }
    | { state: "invalid" }
    | { state: "ok"; on: string[]; off: string[]; minPower: Record<string, number> };
}

/** WPU-G10. The admin's minimum bundle power for one image; null removes the override. */
export interface BlueprintMinPowerInput {
  market: string;
  blueprintId: string;
  minPower: number | null;
}

export interface BlueprintMinPowerSaved {
  market: string;
  blueprintId: string;
  minPower: number | null;
}

export interface BlueprintsAdminRepo {
  list(market: string): Promise<Written<BlueprintsView>>;
  setEnabled(input: BlueprintSetInput, reason: string): Promise<Written<BlueprintSaved>>;
  setMinPower(
    input: BlueprintMinPowerInput,
    reason: string,
  ): Promise<Written<BlueprintMinPowerSaved>>;
}

class Missing extends Error {}

export function blueprintsAdminRepo(scope: AdminScope): BlueprintsAdminRepo {
  const { role } = scope.actor;
  return {
    async list(market) {
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market)) return refused("validation");
      const read = await readImageSwitches(scope.tx, market);
      const switches: BlueprintsView["switches"] =
        read.state === "ok"
          ? {
              state: "ok",
              on: [...read.switches.on],
              off: [...read.switches.off],
              minPower: { ...(read.switches.minPower ?? {}) },
            }
          : { state: read.state };
      return {
        ok: true,
        value: { images: await listImagesForAdmin(scope.tx), switches },
        replayed: false,
      };
    },

    async setEnabled(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, blueprintId, enabled } = input;
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        !isMarketCode(market) ||
        typeof blueprintId !== "string" ||
        !BLUEPRINT_ID.test(blueprintId) ||
        typeof enabled !== "boolean"
      ) {
        return refused("validation");
      }
      const { tx, actor } = scope;
      try {
        return await audited(
          scope,
          {
            action: "image_allowlist.set",
            targetType: "image_allowlist",
            targetId: `${market}/${blueprintId}`,
            reason,
          },
          async () => {
            // Serializes the saves of one market: the read below sees every committed row.
            await lockImageAllowListWrites(tx, market);
            const known = await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from catalog_products
                  where family = 'blueprint' and aws_id = ${blueprintId}`,
            );
            if ((known.rows[0]?.n ?? 0) === 0) throw new Missing();
            const existing = await tx.execute<{ id: string; value: unknown }>(
              sql`select id, value from settings
                  where key = ${IMAGE_ALLOWLIST_KEY} and market = ${market}
                    and scope = 'market' and scope_id is null`,
            );
            const row = existing.rows[0];
            // A stored row that does not parse is replaced by this save (the audit log holds the old
            // value); it is never read as a list (R16).
            const current: ImageSwitches = (row === undefined
              ? null
              : parseImageSwitches(row.value)) ?? { on: [], off: [] };
            const value: BlueprintSaved = { market, blueprintId, enabled };
            const before = {
              on: current.on.includes(blueprintId),
              off: current.off.includes(blueprintId),
            };
            const already = enabled ? before.on : before.off;
            if (already) return { value, replayed: true, before, after: before };
            const on = current.on.filter((id) => id !== blueprintId);
            const off = current.off.filter((id) => id !== blueprintId);
            (enabled ? on : off).push(blueprintId);
            if (on.length > IMAGE_ALLOWLIST_MAX || off.length > IMAGE_ALLOWLIST_MAX) {
              throw new TooMany();
            }
            const json = JSON.stringify(
              imageSwitchesValueOf({
                on,
                off,
                ...(current.minPower === undefined ? {} : { minPower: current.minPower }),
              }),
            );
            // Only the granted columns: a Drizzle insert() would name created_at (42501).
            if (row === undefined) {
              await tx.execute(
                sql`insert into settings (id, key, market, scope, scope_id, value, set_by)
                    values (${uuidv7()}, ${IMAGE_ALLOWLIST_KEY}, ${market}, 'market', null, ${json}::jsonb, ${actor.adminId})`,
              );
            } else {
              await tx.execute(
                sql`update settings set value = ${json}::jsonb, set_by = ${actor.adminId}
                    where id = ${row.id}`,
              );
            }
            return {
              value,
              replayed: false,
              before,
              after: { on: on.includes(blueprintId), off: off.includes(blueprintId) },
            };
          },
        );
      } catch (error) {
        if (error instanceof Missing) return refused("not_found");
        if (error instanceof TooMany) return refused("validation");
        throw error;
      }
    },

    async setMinPower(input, reason) {
      const { market, blueprintId, minPower } = input;
      if (!ROLES.includes(role) || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        !isMarketCode(market) ||
        typeof blueprintId !== "string" ||
        !BLUEPRINT_ID.test(blueprintId) ||
        (minPower !== null &&
          (typeof minPower !== "number" ||
            !Number.isSafeInteger(minPower) ||
            minPower < 0 ||
            minPower > IMAGE_MIN_POWER_MAX))
      ) {
        return refused("validation");
      }
      const { tx, actor } = scope;
      try {
        return await audited(
          scope,
          {
            action: "image_allowlist.min_power",
            targetType: "image_allowlist",
            targetId: `${market}/${blueprintId}`,
            reason,
          },
          async () => {
            await lockImageAllowListWrites(tx, market);
            const known = await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from catalog_products
                  where family = 'blueprint' and aws_id = ${blueprintId}`,
            );
            if ((known.rows[0]?.n ?? 0) === 0) throw new Missing();
            const existing = await tx.execute<{ id: string; value: unknown }>(
              sql`select id, value from settings
                  where key = ${IMAGE_ALLOWLIST_KEY} and market = ${market}
                    and scope = 'market' and scope_id is null`,
            );
            const row = existing.rows[0];
            const current: ImageSwitches = (row === undefined
              ? null
              : parseImageSwitches(row.value)) ?? { on: [], off: [] };
            const value: BlueprintMinPowerSaved = { market, blueprintId, minPower };
            const was = current.minPower?.[blueprintId] ?? null;
            const before = { minPower: was };
            if (was === minPower) return { value, replayed: true, before, after: before };
            const next: Record<string, number> = { ...(current.minPower ?? {}) };
            if (minPower === null) delete next[blueprintId];
            else next[blueprintId] = minPower;
            if (Object.keys(next).length > IMAGE_ALLOWLIST_MAX) throw new TooMany();
            const json = JSON.stringify(
              imageSwitchesValueOf({ on: current.on, off: current.off, minPower: next }),
            );
            if (row === undefined) {
              await tx.execute(
                sql`insert into settings (id, key, market, scope, scope_id, value, set_by)
                    values (${uuidv7()}, ${IMAGE_ALLOWLIST_KEY}, ${market}, 'market', null, ${json}::jsonb, ${actor.adminId})`,
              );
            } else {
              await tx.execute(
                sql`update settings set value = ${json}::jsonb, set_by = ${actor.adminId}
                    where id = ${row.id}`,
              );
            }
            return { value, replayed: false, before, after: { minPower } };
          },
        );
      } catch (error) {
        if (error instanceof Missing) return refused("not_found");
        if (error instanceof TooMany) return refused("validation");
        throw error;
      }
    },
  };
}

class TooMany extends Error {}
