import { isOperationKind, selectDue } from "@tc/db";
import type { Clock } from "../types";
import { decideFailure, decideRefusal, STALE_QUEUED_SECONDS } from "./policy";
import { sendAfterCommit, type OperationQueue, type QueueMessage } from "./queue";
import { transitionOperation } from "./transition";
import type { AttentionHook, RunTx } from "./types";

export const SWEEP_LIMIT = 100;

export interface SweepDeps {
  readonly runTx: RunTx;
  readonly clock: Clock;
  readonly queue: OperationQueue;
  readonly limit?: number;
  // Called inside the sweep transaction for every operation moved to needs_attention. A throwing
  // hook rolls the whole sweep back; the next sweep tries again.
  readonly onAttention?: AttentionHook;
}

export interface SweepReport {
  readonly released: number;
  readonly resent: number;
  readonly recovered: number;
  readonly escalated: number;
  readonly sent: number;
  readonly sendFailures: number;
}

interface Outcome {
  readonly released: number;
  readonly resent: number;
  readonly recovered: number;
  readonly escalated: number;
  readonly messages: readonly QueueMessage[];
}

// 10.1: waiting and due -> queued, queued and still unsent 2 minutes after next_run_at -> sent
// again, running with an expired lease -> a failed attempt. The state changes commit first; the
// messages go out after the commit, and a lost send is found again by the next sweep (3.4).
export async function sweepOperations(deps: SweepDeps): Promise<SweepReport> {
  const limit = deps.limit ?? SWEEP_LIMIT;

  // runTx can run this callback up to 3 times: everything it builds is local to one run.
  const outcome = await deps.runTx<Outcome>(async (tx) => {
    const now = deps.clock.now();
    const due = await selectDue(tx, now, STALE_QUEUED_SECONDS, limit);
    const messages: QueueMessage[] = [];
    let released = 0;
    let resent = 0;
    let recovered = 0;
    let escalated = 0;

    for (const op of due) {
      if (op.state === "waiting" || op.state === "queued") {
        const result = await transitionOperation(tx, "worker", {
          id: op.id,
          from: op.state,
          to: "queued",
          nextRunAt: now,
          bumpEnqueueSeq: true,
        });
        if (!result.applied) continue;
        if (op.state === "waiting") released += 1;
        else resent += 1;
        messages.push({
          operationId: op.id,
          resourceId: op.resourceId,
          enqueueSeq: result.enqueueSeq,
        });
        continue;
      }

      // running and the lease has passed: a failed attempt.
      const decision = isOperationKind(op.kind)
        ? decideFailure({
            kind: op.kind,
            attempts: op.attempts,
            now,
            facts: {
              code: "lease_expired",
              retryable: true,
              poolFull: false,
              awsErrorName: null,
            },
          })
        : decideRefusal("unknown_kind", op.attempts);
      if (decision.to === "waiting") {
        const result = await transitionOperation(tx, "worker", {
          id: op.id,
          from: "running",
          to: "waiting",
          attempts: decision.attempts,
          nextRunAt: decision.nextRunAt,
          lastError: decision.lastError,
        });
        if (result.applied) recovered += 1;
      } else {
        const result = await transitionOperation(tx, "worker", {
          id: op.id,
          from: "running",
          to: "needs_attention",
          attempts: decision.attempts,
          lastError: decision.lastError,
        });
        if (!result.applied) continue;
        escalated += 1;
        await deps.onAttention?.(tx, {
          operationId: op.id,
          resourceId: op.resourceId,
          kind: op.kind,
          code: decision.lastError,
        });
      }
    }
    return { released, resent, recovered, escalated, messages };
  });

  let sent = 0;
  let sendFailures = 0;
  for (const message of outcome.messages) {
    if (await sendAfterCommit(deps.queue, message)) sent += 1;
    else sendFailures += 1;
  }
  return {
    released: outcome.released,
    resent: outcome.resent,
    recovered: outcome.recovered,
    escalated: outcome.escalated,
    sent,
    sendFailures,
  };
}
