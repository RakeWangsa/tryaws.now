import { compensateFailedCreate, type Clock } from "@tc/core";
import type { OperationHooks } from "./types";

// The thin adapter between the `failed` hook of the engine (WP4-T2) and the automatic reversal of
// WP4-T4. Only a create has an order to reverse. The hook runs inside the transaction that moves the
// operation to `failed`; a throw rolls that move back and the sweeper recovers the run. No AWS call is
// made here (R1): the removal of leftovers and the notification are separate (open point 8).
export function orderHooks(deps: { readonly clock: Clock }): OperationHooks {
  return {
    failed: async (tx, event) => {
      if (event.kind !== "create") return;
      await compensateFailedCreate(tx, deps, {
        resourceId: event.resourceId,
        customerId: event.customerId,
        code: event.code,
      });
    },
  };
}
