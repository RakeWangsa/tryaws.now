import {
  decideRefusal,
  isUuid,
  renewalConfirmable,
  sameRenewalTarget,
  transitionOperation,
  type LocalFailure,
  type RenewalRecheck,
} from "@tc/core";
import { loadOperationBrief } from "@tc/db";
import type { OperationBrief, RunView, Tx } from "@tc/db";
import type { RunOutcome, StepDeps } from "./types";

type Code = Exclude<LocalFailure, "lease_expired">;
type Recorded =
  { readonly to: "succeeded" } | { readonly to: "needs_attention"; code: Code } | null;

/** The last_error of a renewal moved to failed by a confirmed "not renewed" (the failed hook refunds it). */
export const RENEWAL_UNRENEWED_CONFIRMED = "renewal_unrenewed_confirmed";

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function targetOf(payload: unknown): string | null {
  const target = recordOf(payload)["targetOperationId"];
  return isUuid(target) ? target : null;
}

// WPU-X3 (b). The admin's "registry confirmed not renewed" (operation kind `confirm_unrenewed`, an engine kind): a
// finance admin or a superadmin asked for a fresh registry check of a `renew_domain` stuck in needs_attention at
// `poll` (the registry answered ERROR, or the poll gave up). Three phases:
//   1. One transaction: the target must be this resource's renewal stuck at poll (renewalConfirmable), the resource a
//      domain, the failed hook and the registry check installed; else the confirm operation needs attention with the
//      reason, before any AWS call (R16).
//   2. Outside any transaction: GetOperationDetail of the saved RenewDomain operation, then GetDomainDetail
//      (deps.renewalRecheck, packages/aws recheckRenewal; the verdict is @tc/core renewalRecheckVerdict). Any error
//      is `registry_unreachable`.
//   3. One transaction under the fence of the lease: the target is read again (locked); it must be unchanged
//      (sameRenewalTarget: an admin's retry or another run in between leaves it, `target_changed`). Only the verdict
//      "unrenewed" (a final answer that is not SUCCESSFUL, the expiry unchanged to the millisecond) moves the
//      target to failed and runs the failed hook (renewal-hooks.ts: the renewal charge goes back, credit note and the
//      customer's message), as reject.ts does. Every other verdict records its reason on the confirm operation and
//      leaves the target and the money as they are. A throwing hook rolls the transaction back; the sweeper recovers
//      the run like an expired lease. Logs carry ids and fixed words only (R14).
export async function runConfirmUnrenewed(
  deps: StepDeps,
  view: RunView,
  leaseUntil: Date,
): Promise<RunOutcome> {
  const { operation, resource } = view;
  if (resource === null) throw new Error("confirm: the resource is missing after the claim");
  const own = { id: operation.id, from: "running" as const, fence: leaseUntil };

  const refuse = async (tx: Tx, code: Code): Promise<Recorded> => {
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

  // Phase 1.
  const first = await deps.runTx(
    async (tx): Promise<{ target: OperationBrief } | { recorded: Recorded }> => {
      const targetId = targetOf(operation.payload);
      if (targetId === null) return { recorded: await refuse(tx, "invalid_step_result") };
      const target = await loadOperationBrief(tx, targetId);
      // R8: the target must be an operation of this very resource.
      if (target === null || target.resourceId !== operation.resourceId) {
        return { recorded: await refuse(tx, "owner_mismatch") };
      }
      if (resource.family !== "domain" || !renewalConfirmable(target)) {
        return { recorded: await refuse(tx, "renewal_not_confirmable") };
      }
      if (deps.hooks?.failed === undefined) {
        return { recorded: await refuse(tx, "failed_hook_missing") };
      }
      if (deps.renewalRecheck === undefined) {
        return { recorded: await refuse(tx, "renewal_check_missing") };
      }
      return { target };
    },
  );

  let recorded: Recorded;
  if ("recorded" in first) {
    recorded = first.recorded;
  } else {
    const before = first.target;
    // Phase 2.
    let verdict: RenewalRecheck | null;
    try {
      const config = recordOf(resource.config);
      verdict =
        (await deps.renewalRecheck?.({
          name: config["name"],
          renewOperationId: config["renewOperationId"],
          payload: before.payload,
        })) ?? null;
    } catch {
      // R14: nothing of the error is kept.
      verdict = null;
    }
    // Phase 3.
    recorded = await deps.runTx(async (tx): Promise<Recorded> => {
      const now = await loadOperationBrief(tx, before.id);
      if (now === null || now.resourceId !== before.resourceId || !sameRenewalTarget(before, now)) {
        return refuse(tx, "target_changed");
      }
      if (verdict === null) return refuse(tx, "registry_unreachable");
      if (verdict.verdict === "kept") return refuse(tx, verdict.reason);

      const done = await transitionOperation(tx, "worker", {
        ...own,
        to: "succeeded",
        attempts: 0,
        lastError: null,
      });
      if (!done.applied) return null;
      const moved = await transitionOperation(tx, "worker", {
        id: now.id,
        from: "needs_attention",
        to: "failed",
        lastError: RENEWAL_UNRENEWED_CONFIRMED,
      });
      // loadOperationBrief locked the row, so a move that changed nothing is a bug: fail closed (R16).
      if (!moved.applied) throw new Error("confirm: the target did not move");
      await deps.hooks?.failed?.(tx, {
        operationId: now.id,
        resourceId: now.resourceId,
        customerId: resource.customerId,
        kind: "renew_domain",
        code: RENEWAL_UNRENEWED_CONFIRMED,
      });
      await deps.hooks?.needsAttention?.(tx, {
        operationId: now.id,
        resourceId: now.resourceId,
        kind: "renew_domain",
        code: RENEWAL_UNRENEWED_CONFIRMED,
      });
      return { to: "succeeded" };
    });
  }

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
