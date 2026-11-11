import { capacityRepo, type Tx } from "@tc/db";
import type { Result } from "../types";
import { decide, waitlistOffer } from "./decide";
import type { ReserveInput } from "./input";
import type { AllocationFailure, ReservationRecord } from "./types";

export interface Reservation {
  readonly poolAccountId: string;
  readonly homeCreated: boolean;
  readonly record: ReservationRecord;
}

// The data of a capacity_full answer.
export interface CapacityRefusal {
  readonly reason: AllocationFailure;
  readonly waitlist: "offered" | "joined" | "not_offered";
  readonly waitlistEntryId?: string;
}

// Runs in the purchase transaction as web_rw, after the wallet lock and after every check that can
// refuse. It has no key of its own: a second call in the same transaction would reserve again. The
// purchase's own keys stop a replay before this call, and a failure later in the transaction rolls the
// reservation back with it. From ok: true on, the caller must throw instead of returning a failure,
// because withTx commits a returned failure.
export async function reserveCapacity(tx: Tx, input: ReserveInput): Promise<Result<Reservation>> {
  const decision = await decide(tx, input, "lock");
  if (decision.kind === "answer") return decision.result;

  // 9. A refusal writes nothing but the waitlist entry that the caller asked for.
  if (decision.kind === "no_room") {
    const { reason, repos } = decision;
    if (reason === "full" && input.waitlist !== undefined) {
      const joined = await repos.waitlist.join({
        productFamily: input.waitlist.productFamily,
        region: input.region,
        reason: "capacity",
        idempotencyKey: input.waitlist.idempotencyKey,
      });
      if (!joined.ok) throw new Error("capacity: the waitlist join was refused");
      const data: CapacityRefusal = {
        reason,
        waitlist: "joined",
        waitlistEntryId: joined.value.id,
      };
      return { ok: false, error: "capacity_full", data };
    }
    const data: CapacityRefusal = { reason, waitlist: waitlistOffer(reason) };
    return { ok: false, error: "capacity_full", data };
  }

  const { repos, home, placement } = decision;

  // 10. A first order in this Region records the home before any unit is taken.
  let homeCreated = false;
  if (home === null) {
    const assigned = await repos.homes.assign(input.region, placement.poolAccountId);
    if (!assigned.ok) return { ok: false, error: "conflict" };
    homeCreated = !assigned.replayed;
  }

  // 11. Compare-and-set of the units read under the lock.
  await capacityRepo(tx).setUsed(
    placement.cells.map((c) => ({ rowId: c.rowId, used: c.used + c.amount, expectedUsed: c.used })),
  );

  // 12.
  const { poolAccountId } = placement;
  const cells = placement.cells.map((c) => ({
    quotaCode: c.quotaCode,
    region: c.region,
    amount: c.amount,
  }));
  return {
    ok: true,
    value: { poolAccountId, homeCreated, record: { v: 1, poolAccountId, cells } },
  };
}
