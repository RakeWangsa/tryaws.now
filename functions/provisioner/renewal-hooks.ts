import { reverseFailedDomainRenewal, type Logger } from "@tc/core";
import type { OperationHooks } from "./types";

// WPU-Z13: the thin adapter between the `failed` hook of the engine and the reversal of a failed domain renewal
// (@tc/core). A `renew_domain` reaches failed when the registry refuses it (an error that can never succeed, 10.1)
// or when an admin rejects it after its retries (reject.ts); the renewal charge of its period goes back in the same
// transaction (R5). A throw rolls the move back and the sweeper recovers the run. No AWS call here (R1).
export function renewalHooks(deps: { readonly log?: Logger }): OperationHooks {
  return {
    failed: async (tx, event) => {
      if (event.kind !== "renew_domain") return;
      await reverseFailedDomainRenewal(tx, deps, {
        operationId: event.operationId,
        resourceId: event.resourceId,
        customerId: event.customerId,
      });
    },
  };
}
