import type { Tx } from "@tc/db";
import type { Result } from "../types";
import { decide, waitlistOffer } from "./decide";
import type { CheckInput } from "./input";
import type { CapacityRefusal } from "./reserve";

// "Capacity available but not yet reserved" (16.11 step 2): no lock, no home, no used unit, no
// waitlist entry, no row.
export async function checkCapacity(
  tx: Tx,
  input: CheckInput,
): Promise<Result<{ available: true }>> {
  const decision = await decide(tx, input, "read");
  if (decision.kind === "answer") return decision.result;
  if (decision.kind === "no_room") {
    const data: CapacityRefusal = {
      reason: decision.reason,
      waitlist: waitlistOffer(decision.reason),
    };
    return { ok: false, error: "capacity_full", data };
  }
  return { ok: true, value: { available: true } };
}
