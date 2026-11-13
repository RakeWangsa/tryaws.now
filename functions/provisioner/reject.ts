import {
  decideRefusal,
  isUuid,
  refundedOnFailure,
  rejectionAllowed,
  transitionOperation,
  type LocalFailure,
} from "@tc/core";
import { loadOperationBrief } from "@tc/db";
import type { RunView, Tx } from "@tc/db";
import type { RunOutcome, StepDeps } from "./types";

type Recorded =
  { readonly to: "succeeded" } | { readonly to: "needs_attention"; code: string } | null;

function targetOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const target = (payload as Record<string, unknown>)["targetOperationId"];
  return isUuid(target) ? target : null;
}

// The rejection of a stuck operation (an engine kind, no adapter): the target goes needs_attention
// to failed (W11), a create or a domain renewal (WPU-Z13: the kinds whose failure moves money back,
// refundedOnFailure) runs the same failed hook as the automatic path, and the reject operation
// succeeds. All of it is one transaction under the fence of the lease of the reject
// operation; a throwing hook rolls everything back and the sweeper recovers the run like an expired
// lease. Inside the transaction the fenced update of the reject operation comes first (the order is
// not visible outside), so a stale run writes nothing for the target.
// WPU-Z13 (review rounds 1 and 2): a domain renewal the registry may hold (registryHoldsRenewal: any
// step but null, i.e. `submit`, where RenewDomain may have been sent and its answer lost, and `poll`,
// after it was accepted) is not rejected. TiCON pays the registry for that renewal and it may still
// complete, so a refund waits for the registry's answer: a retry reads it (at `submit` the live expiry
// first: already renewed is done; at `poll` the operation: successful is done, failed is the refund of
// the registry's refusal). The reject operation needs attention with `renewal_submitted`; the target
// and the money stay as they are. Only a renewal at step null (reads only, nothing sent) is rejected
// with its refund. WPU-Y2 fix round 1: and a renewal at `poll` whose last run (at most an hour ago) recorded the
// provisioner's check `registry_unrenewed:<checked at>` (ERROR for the saved operation, the expiry unchanged to the
// millisecond; round 2: never a give-up while it is in progress): rejectionAllowed.
export async function runReject(
  deps: StepDeps,
  view: RunView,
  leaseUntil: Date,
): Promise<RunOutcome> {
  const { operation, resource } = view;
  if (resource === null) throw new Error("reject: the resource is missing after the claim");
  const own = { id: operation.id, from: "running" as const, fence: leaseUntil };

  const refuse = async (
    tx: Tx,
    code: Exclude<LocalFailure, "lease_expired">,
  ): Promise<Recorded> => {
    const decision = decideRefusal(code, operation.attempts);
    const applied = await transitionOperation(tx, "worker", {
      ...own,
      to: decision.to,
      attempts: decision.attempts,
      lastError: decision.lastError,
    });
    if (!applied.applied) return null;
    await deps.hooks?.needsAttention?.(tx, {
      operationId: operation.id,
      resourceId: resource.id,
      kind: operation.kind,
      code,
    });
    return { to: "needs_attention", code };
  };

  const recorded = await deps.runTx(async (tx): Promise<Recorded> => {
    const targetId = targetOf(operation.payload);
    if (targetId === null) return refuse(tx, "invalid_step_result");
    const target = await loadOperationBrief(tx, targetId);
    if (target === null || target.resourceId !== operation.resourceId) {
      return refuse(tx, "owner_mismatch");
    }
    // An admin who retried the target, or an earlier run, left nothing to reject: a no-op.
    const rejectable = target.state === "needs_attention";
    // WPU-Y2 fix round 1: a renewal at `poll` whose last run recorded a fresh "expiry unchanged" check may be rejected.
    if (rejectable && !rejectionAllowed(target, deps.clock.now())) {
      return refuse(tx, "renewal_submitted");
    }
    const refunded = refundedOnFailure(target.kind);
    if (rejectable && refunded && deps.hooks?.failed === undefined) {
      return refuse(tx, "failed_hook_missing");
    }

    const done = await transitionOperation(tx, "worker", {
      ...own,
      to: "succeeded",
      attempts: 0,
      lastError: null,
    });
    if (!done.applied) return null;
    if (!rejectable) return { to: "succeeded" };

    const moved = await transitionOperation(tx, "worker", {
      id: target.id,
      from: "needs_attention",
      to: "failed",
      lastError: "rejected",
    });
    // loadOperationBrief locked the row, so a move that changed nothing is a bug: fail closed (R16).
    if (!moved.applied) throw new Error("reject: the target did not move");
    if (refunded) {
      await deps.hooks?.failed?.(tx, {
        operationId: target.id,
        resourceId: target.resourceId,
        customerId: resource.customerId,
        kind: target.kind,
        code: "rejected",
      });
    }
    await deps.hooks?.needsAttention?.(tx, {
      operationId: target.id,
      resourceId: target.resourceId,
      kind: target.kind,
      code: "rejected",
    });
    return { to: "succeeded" };
  });

  if (recorded === null) {
    deps.log({ event: "operation_step", operationId: operation.id, outcome: "stale" });
    return { outcome: "stale" };
  }
  deps.log({
    event: "operation_step",
    operationId: operation.id,
    resourceId: resource.id,
    kind: operation.kind,
    step: operation.step,
    outcome: "advanced",
    to: recorded.to,
    ...(recorded.to === "needs_attention" && { code: recorded.code }),
    attempts: recorded.to === "succeeded" ? 0 : operation.attempts,
    sent: false,
  });
  return { outcome: "advanced", to: recorded.to, sent: false };
}
