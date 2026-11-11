import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { DbError } from "../../errors";
import { isMarketCode } from "../config/args";
import { isStorableFxRate } from "../config/fx-rates";
import { refused, type Written } from "../result";
import { audited, isActiveAdmin } from "./audited";
import type { AdminScope } from "./index";

// The two-person rule for a large FX change (FX_SECOND_ADMIN_PERCENT, spec 16.12 /pricing): admin A asks,
// a DIFFERENT admin B approves from B's own session, and only then does the caller set the rate. The
// identity of B is `scope.actor`, which comes from the verified session; no request field names an
// approver. The pending change is one row of `settings` (key fx_change_pending, scope market): admin_rw
// may insert and update it already, so no table and no migration. One change waits at a time for a
// market; a request replaces an approved or expired one.

const KEY = "fx_change_pending";

export interface FxChange {
  market: string;
  rate: string;
  // null: the rate starts when it is approved.
  effectiveFrom: Date | null;
  reason: string;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
  status: "pending" | "approved";
  approvedBy: string | null;
  approvedAt: Date | null;
}

export interface FxChangeRequest {
  market: string;
  rate: string;
  effectiveFrom: Date | null;
  at: Date; // the caller's clock reading
  expiresAt: Date;
}

export interface FxChangesAdminRepo {
  /** The change of a market, pending, approved or expired; null when none was ever asked. */
  read(market: string): Promise<FxChange | null>;
  request(input: FxChangeRequest, reason: string): Promise<Written<FxChange>>;
  /** Marks the change approved by the actor. It does not set the rate: the caller does, in the same transaction. */
  approve(input: { market: string; at: Date }, reason: string): Promise<Written<FxChange>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: "conflict" | "forbidden" | "not_found") {
    super("fx change refused");
  }
}

const isInstant = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

interface Stored {
  rate: string;
  effectiveFrom: string | null;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: "pending" | "approved";
  approvedBy: string | null;
  approvedAt: string | null;
}

const fromStored = (market: string, s: Stored): FxChange => ({
  market,
  rate: s.rate,
  effectiveFrom: s.effectiveFrom === null ? null : new Date(s.effectiveFrom),
  reason: s.reason,
  requestedBy: s.requestedBy,
  requestedAt: new Date(s.requestedAt),
  expiresAt: new Date(s.expiresAt),
  status: s.status,
  approvedBy: s.approvedBy,
  approvedAt: s.approvedAt === null ? null : new Date(s.approvedAt),
});

const stamp = (c: FxChange | null) =>
  c === null
    ? null
    : {
        rate: c.rate,
        status: c.status,
        requestedBy: c.requestedBy,
        approvedBy: c.approvedBy,
        effectiveFrom: c.effectiveFrom?.toISOString() ?? null,
        expiresAt: c.expiresAt.toISOString(),
      };

export function fxChangesAdminRepo(scope: AdminScope): FxChangesAdminRepo {
  const { tx, actor } = scope;

  const load = async (market: string, lock: boolean): Promise<FxChange | null> => {
    const query = lock
      ? sql`select value from settings where key = ${KEY} and market = ${market} and scope = 'market' and scope_id is null for update`
      : sql`select value from settings where key = ${KEY} and market = ${market} and scope = 'market' and scope_id is null`;
    const { rows } = await tx.execute<{ value: Stored }>(query);
    const row = rows[0];
    return row === undefined ? null : fromStored(market, row.value);
  };

  const store = async (market: string, s: Stored, exists: boolean): Promise<void> => {
    const json = JSON.stringify(s);
    if (exists) {
      await tx.execute(
        sql`update settings set value = ${json}::jsonb, set_by = ${actor.adminId} where key = ${KEY} and market = ${market} and scope = 'market' and scope_id is null`,
      );
    } else {
      await tx.execute(
        sql`insert into settings (id, key, market, scope, scope_id, value, set_by) values (${uuidv7()}, ${KEY}, ${market}, 'market', null, ${json}::jsonb, ${actor.adminId})`,
      );
    }
  };

  return {
    async read(market) {
      // A plain value, so a refusal throws (R10, R16; WP9-T2 sweep): any active admin may read it.
      if (!(await isActiveAdmin(scope))) throw new DbError("42501");
      if (!isMarketCode(market)) return null;
      return load(market, false);
    },

    async request(input, reason) {
      const { market, rate, effectiveFrom, at, expiresAt } = input;
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        !isMarketCode(market) ||
        !isStorableFxRate(rate) ||
        !isInstant(at) ||
        !isInstant(expiresAt) ||
        expiresAt.getTime() <= at.getTime() ||
        (effectiveFrom !== null && !isInstant(effectiveFrom))
      ) {
        return refused("validation");
      }
      try {
        return await audited(
          scope,
          { action: "fx_rate.request", targetType: "fx_change", targetId: market, reason },
          async () => {
            const before = await load(market, true);
            if (before !== null && before.status === "pending" && before.expiresAt > at) {
              const same =
                before.rate === rate &&
                (before.effectiveFrom?.getTime() ?? null) === (effectiveFrom?.getTime() ?? null);
              if (!same) throw new Refusal("conflict");
              return { value: before, replayed: true, before: stamp(before), after: stamp(before) };
            }
            const next: Stored = {
              rate,
              effectiveFrom: effectiveFrom?.toISOString() ?? null,
              reason,
              requestedBy: actor.adminId,
              requestedAt: at.toISOString(),
              expiresAt: expiresAt.toISOString(),
              status: "pending",
              approvedBy: null,
              approvedAt: null,
            };
            await store(market, next, before !== null);
            const value = fromStored(market, next);
            return { value, replayed: false, before: stamp(before), after: stamp(value) };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    async approve(input, reason) {
      const { market, at } = input;
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      if (!isMarketCode(market) || !isInstant(at)) return refused("validation");
      try {
        return await audited(
          scope,
          { action: "fx_rate.approve", targetType: "fx_change", targetId: market, reason },
          async () => {
            const before = await load(market, true);
            if (before === null) throw new Refusal("not_found");
            if (before.status === "approved") {
              // The same approver again is a replay; anyone else finds it decided already.
              if (before.approvedBy?.toLowerCase() === actor.adminId.toLowerCase()) {
                return {
                  value: before,
                  replayed: true,
                  before: stamp(before),
                  after: stamp(before),
                };
              }
              throw new Refusal("conflict");
            }
            if (before.expiresAt <= at) throw new Refusal("conflict");
            // The two-person rule: the approver is the verified actor and never the requester.
            if (before.requestedBy.toLowerCase() === actor.adminId.toLowerCase()) {
              throw new Refusal("forbidden");
            }
            const next: Stored = {
              rate: before.rate,
              effectiveFrom: before.effectiveFrom?.toISOString() ?? null,
              reason: before.reason,
              requestedBy: before.requestedBy,
              requestedAt: before.requestedAt.toISOString(),
              expiresAt: before.expiresAt.toISOString(),
              status: "approved",
              approvedBy: actor.adminId,
              approvedAt: at.toISOString(),
            };
            await store(market, next, true);
            const value = fromStored(market, next);
            return { value, replayed: false, before: stamp(before), after: stamp(value) };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },
  };
}
