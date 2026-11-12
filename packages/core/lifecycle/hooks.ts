import { lifecycleRepo, patchResource, type Tx } from "@tc/db";
import { releaseCapacity } from "../capacity/release";
import type { OperationKind } from "../operations/kinds";
import type { Logger } from "../operations/types";
import type { Clock } from "../types";
import { readLifecycleConfig } from "./config";
import {
  PLAN_APPLY_KINDS,
  markPlanChangeFailed,
  planApplyStale,
  readPlanApplyPayload,
} from "./plan-change";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LifecycleHookEvent {
  readonly operationId: string;
  readonly resourceId: string;
  readonly customerId: string;
  readonly kind: OperationKind;
}

// The success hooks of the lifecycle kinds, run in the transaction that records the success: what
// the step did in AWS is now what the database says (state of the resource). No effect outside the
// database. A kind that is not listed here is not a lifecycle kind and changes nothing.
export function lifecycleHooks(deps: { clock: Clock; log?: Logger }): {
  succeeded(tx: Tx, event: LifecycleHookEvent): Promise<void>;
  needsAttention(tx: Tx, event: { resourceId: string; kind: string; code: string }): Promise<void>;
} {
  return {
    // WPU-S2: an apply of a pending plan that ends in needs_attention is marked, so the renewal stops
    // quoting its price.
    async needsAttention(tx, event) {
      await markPlanChangeFailed(tx, event);
    },
    async succeeded(tx, event) {
      const repo = lifecycleRepo(tx);
      const at = deps.clock.now();
      switch (event.kind) {
        case "suspend":
          await repo.setResourceState(event.resourceId, "suspended", at);
          return;
        case "resume":
          await repo.setResourceState(event.resourceId, "active", at);
          return;
        case "destroy": {
          await repo.setResourceState(event.resourceId, "destroyed", at);
          // The units go back at once (open point 34 of WP4-T3, built as (a)).
          await releaseCapacity(tx, {
            resourceId: event.resourceId,
            clock: deps.clock,
            ...(deps.log !== undefined && { log: deps.log }),
          });
          const config = await readLifecycleConfig(tx);
          const restoreUntil = new Date(at.getTime() + config.retentionDays * DAY_MS);
          for (const channel of ["email", "sms"] as const) {
            await repo.insertNotification({
              customerId: event.customerId,
              channel,
              template: "lifecycle_destroyed",
              payload: { resourceId: event.resourceId, restoreUntil: restoreUntil.toISOString() },
              dedupeKey: `lifecycle:destroyed:${event.resourceId}:${at.toISOString()}:${channel}`,
            });
          }
          return;
        }
        case "scale_container":
        case "change_cdn_bundle": {
          // WPU-S7: an apply that really ran (the adapter did not skip it) for a period that has moved
          // on was late: AWS has changed, the renewal had charged the other plan. The database cannot
          // undo it; ops are told in the resource config (planApplyLate) and the customer is not
          // charged or credited here (no refund rule exists, Needs decision).
          if (!PLAN_APPLY_KINDS.includes(event.kind)) return;
          const facts = await repo.planApplyPeriod(event.resourceId, event.operationId);
          if (facts === null) return;
          const skipped = facts.config.planApplySkipped as { operationId?: unknown } | undefined;
          if (skipped?.operationId === event.operationId) return;
          const queuedFor = readPlanApplyPayload(facts.payload).periodEnd;
          if (!planApplyStale(queuedFor, facts.currentPeriodEnd)) return;
          await patchResource(tx, event.resourceId, {
            configMerge: {
              planApplyLate: {
                operationId: event.operationId,
                periodEnd: queuedFor?.toISOString() ?? null,
              },
            },
          });
          return;
        }
        case "purge_snapshots":
          await repo.retireBackups(event.resourceId, at);
          return;
        default:
          return;
      }
    },
  };
}
