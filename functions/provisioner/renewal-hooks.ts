import { reverseFailedDomainRenewal, type Logger, type NoticeWriter } from "@tc/core";
import type { OperationHooks } from "./types";

// WPU-Z13: the thin adapter between the `failed` hook of the engine and the reversal of a failed domain renewal
// (@tc/core). A `renew_domain` reaches failed when the registry refuses it (an error that can never succeed, 10.1)
// or when an admin rejects it after its retries (reject.ts); the renewal charge of its period goes back in the same
// transaction (R5). Once the registry may hold the renewal (any step but null: `submit`, where RenewDomain is sent,
// and `poll`) only a failure that proves nothing was sent (at `submit`) gets here (WPU-Y2: not the registry's own
// refusal at `poll` any more): decideFailure stops any other final error in needs_attention and reject.ts refuses the rejection
// (review rounds 1 and 2). A throw rolls the move back and the sweeper recovers the run. No AWS call here (R1).
// WPU-Y2 fix round 1: `notice` writes the customer's "not renewed, refunded" message (a template of @tc/notify).
export function renewalHooks(deps: {
  readonly log?: Logger;
  readonly notice?: NoticeWriter;
}): OperationHooks {
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
