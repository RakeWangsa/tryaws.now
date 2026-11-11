import {
  LEASE_SECONDS,
  decideClaim,
  decideRefusal,
  transitionOperation,
  type ClaimView,
  type LocalFailure,
  type QueueMessage,
} from "@tc/core";
import { isDestructive, isOperationKind, loadRunView, readApprovalUntil } from "@tc/db";
import type { OperationUpdate, RunView, Tx } from "@tc/db";
import type { ClaimDeps } from "./types";

export type ClaimOutcome =
  | { readonly status: "run"; readonly view: RunView; readonly leaseUntil: Date }
  | { readonly status: "skipped"; readonly reason: "not_found" | "not_runnable" | "blocked" }
  | { readonly status: "refused"; readonly code: Exclude<LocalFailure, "lease_expired"> };

// Every value but the row id comes from the database; the message gives no authority.
function toClaimView(view: RunView): ClaimView {
  const { operation, resource, pool } = view;
  return {
    state: operation.state,
    kind: operation.kind,
    needsApproval: operation.needsApproval,
    approvedBy: operation.approvedBy,
    resource:
      resource === null
        ? null
        : {
            family: resource.family,
            state: resource.state,
            customerId: resource.customerId,
            poolAccountId: resource.poolAccountId,
            region: resource.region,
          },
    pool: pool === null ? null : { awsAccountId: pool.awsAccountId, externalId: pool.externalId },
    owner: view.owner,
    blockedBy: view.blockedBy,
  };
}

async function move(tx: Tx, update: OperationUpdate): Promise<void> {
  const result = await transitionOperation(tx, "worker", update);
  // loadRunView locked the row, so a move that changed nothing is a bug: fail closed (R16).
  if (!result.applied) throw new Error("operation: the claim did not apply");
}

async function refuse(
  deps: ClaimDeps,
  tx: Tx,
  view: RunView,
  code: Exclude<LocalFailure, "lease_expired">,
): Promise<ClaimOutcome> {
  const { operation } = view;
  const decision = decideRefusal(code, operation.attempts);
  await move(tx, {
    id: operation.id,
    from: "queued",
    to: decision.to,
    attempts: decision.attempts,
    lastError: decision.lastError,
  });
  await deps.onAttention?.(tx, {
    operationId: operation.id,
    resourceId: operation.resourceId,
    kind: operation.kind,
    code,
  });
  return { status: "refused", code };
}

// The first transaction of a run: skip a duplicate, refuse what the rules refuse, order the
// operations of one resource and take the lease. Logs nothing and reads no clock but deps.clock.
export function claimStep(deps: ClaimDeps, message: QueueMessage): Promise<ClaimOutcome> {
  return deps.runTx(async (tx): Promise<ClaimOutcome> => {
    const view = await loadRunView(tx, message.operationId);
    if (view === null) return { status: "skipped", reason: "not_found" };

    const now = deps.clock.now();
    const approvalUntil = await readApprovalUntil(tx);
    const decision = decideClaim(toClaimView(view), {
      now,
      approvalUntil,
      hasAdapter: deps.hasAdapter,
      guardInstalled: deps.destructiveGuard !== undefined,
    });

    switch (decision.action) {
      case "skip":
        return { status: "skipped", reason: "not_runnable" };
      case "refuse":
        return refuse(deps, tx, view, decision.code);
      case "block":
        await move(tx, {
          id: view.operation.id,
          from: "queued",
          to: "waiting",
          nextRunAt: decision.until,
        });
        return { status: "skipped", reason: "blocked" };
      case "run": {
        const kind = view.operation.kind;
        if (isOperationKind(kind) && isDestructive(kind)) {
          // decideClaim lets a destructive kind through only when a guard is installed (R13).
          const allowed = deps.destructiveGuard ? await deps.destructiveGuard(tx, view) : false;
          if (!allowed) return refuse(deps, tx, view, "destructive_guard_refused");
        }
        const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
        await move(tx, {
          id: view.operation.id,
          from: "queued",
          to: "running",
          nextRunAt: leaseUntil,
        });
        return { status: "run", view, leaseUntil };
      }
    }
  });
}
