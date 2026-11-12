import {
  insertOperation,
  lifecycleRepo,
  patchResource,
  type LifecycleRow,
  type OperationKind,
  type Tx,
} from "@tc/db";
import { walletBalance } from "../ledger/balance";
import {
  firstMessage,
  sendAfterCommit,
  type OperationQueue,
  type QueueMessage,
} from "../operations/queue";
import type { Logger, RunTx } from "../operations/types";
import type { Clock } from "../types";
import { readLifecycleConfig, type LifecycleConfig } from "./config";
import { decideSubscription, type LifecycleAction } from "./decide";
import { SNAPSHOT_FAMILIES } from "./guard";
import { planApplyWait, queuePlanApply } from "./plan-change";
import { renewalQuote, renewSubscription } from "./renew";

const HOUR_MS = 3_600_000;
export const LIFECYCLE_LIMIT = 500;

export interface LifecycleDeps {
  readonly runTx: RunTx;
  // The only source of time (section 11): a test moves it, the function reads the real one.
  readonly clock: Clock;
  readonly log: Logger;
  // With a queue the new operations are sent after the commit; without one the sweeper sends them
  // within minutes (3.4). A lost send is found again by the sweeper either way.
  readonly queue?: OperationQueue;
  readonly limit?: number;
}

export interface LifecycleReport {
  readonly examined: number;
  readonly reminded: number;
  readonly renewed: number;
  readonly graced: number;
  readonly retained: number;
  readonly ended: number;
  readonly failed: number;
}

type Step = Exclude<keyof LifecycleReport, "examined" | "failed"> | "none";

interface StepResult {
  readonly step: Step;
  readonly messages: readonly QueueMessage[];
}

// The key of an operation of the lifecycle: one per subscription, kind and period, so a repeat of
// any run is a replay of the stored row (R7) and a new period starts afresh.
function opKey(kind: string, row: LifecycleRow, at: Date): string {
  return `lifecycle:${kind}:${row.id}:${at.toISOString()}`;
}

class Work {
  readonly messages: QueueMessage[] = [];
  constructor(
    readonly tx: Tx,
    readonly row: LifecycleRow,
    readonly now: Date,
    readonly config: LifecycleConfig,
  ) {}

  // R1: only an operation row. The queue message goes out after the commit.
  async enqueue(kind: OperationKind, keyAt: Date): Promise<void> {
    const inserted = await insertOperation(
      this.tx,
      {
        resourceId: this.row.resourceId,
        kind,
        payload: { subscriptionId: this.row.id },
        idempotencyKey: opKey(kind.replaceAll("_", "-"), this.row, keyAt),
      },
      this.now,
    );
    if (inserted.created && inserted.state === "queued") {
      this.messages.push(firstMessage(inserted.operationId, this.row.resourceId));
    }
  }

  async notify(
    template: string,
    dedupe: string,
    payload: Record<string, unknown>,
    channels: readonly ("email" | "sms")[] = ["email"],
  ): Promise<boolean> {
    let any = false;
    for (const channel of channels) {
      const written = await lifecycleRepo(this.tx).insertNotification({
        customerId: this.row.customerId,
        channel,
        template,
        payload,
        dedupeKey: `lifecycle:${template}:${dedupe}:${channel}`,
      });
      any = any || written;
    }
    return any;
  }
}

async function amountText(tx: Tx, row: LifecycleRow, clock: Clock): Promise<string | null> {
  const priced = await renewalQuote(tx, row, clock);
  return priced.ok ? priced.value.totalMinor : null;
}

async function ensureSuspended(work: Work): Promise<void> {
  const { row } = work;
  // A resource that is already suspended (by an admin too) needs no operation.
  if (row.resource.state !== "active" && row.resource.state !== "stopped") return;
  await work.enqueue("suspend", row.periodEnd);
}

async function afterRenewal(
  work: Work,
  renewed: { periodStart: Date; totalMinor: bigint; periodEnd: Date },
  fromGrace: boolean,
): Promise<void> {
  const { row } = work;
  // 11: an admin's suspension is never lifted by a renewal; only an admin action lifts it.
  if (
    fromGrace &&
    row.resource.state === "suspended" &&
    row.resource.config.adminSuspended !== true
  ) {
    await work.enqueue("resume", renewed.periodStart);
  }
  await work.notify("lifecycle_renewed", renewed.periodStart.toISOString(), {
    subscriptionId: row.id,
    resourceId: row.resourceId,
    amountMinor: renewed.totalMinor.toString(),
    periodEnd: renewed.periodEnd.toISOString(),
  });
}

async function enterGrace(work: Work, deps: LifecycleDeps): Promise<void> {
  const { row, config } = work;
  await lifecycleRepo(work.tx).setStatus(row.id, "grace");
  await ensureSuspended(work);
  const graceUntil = new Date(row.periodEnd.getTime() + config.graceHours * HOUR_MS);
  await work.notify(
    "lifecycle_grace_started",
    row.periodEnd.toISOString(),
    {
      subscriptionId: row.id,
      resourceId: row.resourceId,
      graceUntil: graceUntil.toISOString(),
      renewalAmountMinor: await amountText(work.tx, row, deps.clock),
    },
    ["email", "sms"],
  );
}

// Also what a customer's own destroy flow (WP5-T6) calls: the state becomes `retained`, the final
// snapshot is queued where the family has snapshots, and the destroy follows it. Before the end
// date of R13 the destroy waits for an admin (the insert path decides); the guard checks the state
// and the snapshot again when it is claimed.
async function retain(work: Work): Promise<void> {
  const { row } = work;
  await lifecycleRepo(work.tx).setStatus(row.id, "retained");
  await queueRetentionOperations(work);
}

async function queueRetentionOperations(work: Work): Promise<void> {
  if (SNAPSHOT_FAMILIES.includes(work.row.resource.family)) {
    await work.enqueue("final_snapshot", work.row.periodEnd);
  }
  await work.enqueue("destroy", work.row.periodEnd);
}

async function end(work: Work): Promise<void> {
  const { row } = work;
  await lifecycleRepo(work.tx).setStatus(row.id, "ended");
  await work.enqueue("purge_snapshots", row.periodEnd);
  await work.notify("lifecycle_ended", row.periodEnd.toISOString(), {
    subscriptionId: row.id,
    resourceId: row.resourceId,
  });
}

async function remind(work: Work, day: number, deps: LifecycleDeps): Promise<boolean> {
  const { row, config } = work;
  const balance = await walletBalance(work.tx, row.customerId);
  return work.notify(
    "lifecycle_renewal_reminder",
    `${row.id}:${row.periodEnd.toISOString()}:${day}`,
    {
      subscriptionId: row.id,
      resourceId: row.resourceId,
      day,
      periodEnd: row.periodEnd.toISOString(),
      renewalAmountMinor: await amountText(work.tx, row, deps.clock),
      balanceMinor: balance.toString(),
    },
    day === config.smsReminderDay ? ["email", "sms"] : ["email"],
  );
}

// One subscription, in its own transaction, under the lock of its row. The decision is taken again
// on the locked row, so two runs together never act twice (and the ledger key stops the money).
async function process(
  tx: Tx,
  id: string,
  now: Date,
  config: LifecycleConfig,
  deps: LifecycleDeps,
): Promise<StepResult> {
  const row = await lifecycleRepo(tx).lock(id);
  if (row === null) return { step: "none", messages: [] };
  const work = new Work(tx, row, now, config);
  const clock: Clock = { now: () => now };

  const action: LifecycleAction = decideSubscription(
    {
      status: row.status,
      periodEnd: row.periodEnd,
      autoRenew: row.autoRenew,
      resourceState: row.resource.state,
      destroyedAt: row.resource.deletedAt,
    },
    now,
    config,
  );

  // WPU-S5: a pending power, scale or bundle change is applied shortly BEFORE the renewal, so the
  // renewal charges the plan the customer then has. Inside the lead window only, once per period.
  const plan = await queuePlanApply(tx, row, now);
  if (plan !== null && plan.ready)
    work.messages.push(firstMessage(plan.operationId, row.resourceId));

  // WPU-S7: a renewal that would charge waits for an apply of this period that is still queued or
  // running (the charge must follow the capacity the customer has). It is neither charged nor failed:
  // the next sweep asks again, for at most PLAN_APPLY_WAIT_HOURS past the due time. After that the
  // renewal goes on at the applied plan, ops are told once, and the late apply is skipped by the
  // adapter because the period has moved. Renewals that cannot be paid enter grace as before.
  if ((action.type === "period_end" && action.tryRenew) || action.type === "retry_renew") {
    const gate = await planApplyWait(tx, row, now);
    if (gate.wait) return { step: "none", messages: work.messages };
    if (
      gate.staleOperationId !== null &&
      (row.resource.config.planApplyLate as { operationId?: unknown } | undefined)?.operationId !==
        gate.staleOperationId
    ) {
      await patchResource(tx, row.resourceId, {
        configMerge: {
          planApplyLate: {
            operationId: gate.staleOperationId,
            periodEnd: row.periodEnd.toISOString(),
          },
        },
      });
      deps.log({
        event: "lifecycle",
        action: "plan_apply_late",
        subscriptionId: row.id,
        operationId: gate.staleOperationId,
      });
    }
  }

  let step: Step = "none";
  switch (action.type) {
    case "remind":
      // A repeat of the same reminder writes no row (dedupe key) and is no step (R7).
      if (await remind(work, action.day, deps)) step = "reminded";
      break;
    case "period_end": {
      if (action.tryRenew) {
        const renewed = await renewSubscription(tx, row, clock);
        if (renewed.ok) {
          await afterRenewal(work, renewed.value, false);
          step = "renewed";
          break;
        }
      }
      await enterGrace(work, deps);
      step = "graced";
      break;
    }
    case "retry_renew": {
      const renewed = await renewSubscription(tx, row, clock);
      if (renewed.ok) {
        await afterRenewal(work, renewed.value, true);
        step = "renewed";
      } else {
        await ensureSuspended(work);
      }
      break;
    }
    case "retain":
      await retain(work);
      step = "retained";
      break;
    case "ensure_retention_operations":
      await queueRetentionOperations(work);
      break;
    case "end":
      await end(work);
      step = "ended";
      break;
    case "none":
      // A subscription in grace whose suspend never ran gets it queued again (a replay if it exists).
      if (row.status === "grace") await ensureSuspended(work);
      break;
  }
  return { step, messages: work.messages };
}

// The scheduler's lifecycle pass (section 11). One clock reading for the whole pass. A failure of
// one subscription is counted and logged by id and does not stop the others; a config that cannot
// be read stops the pass (R16).
export async function runLifecycle(deps: LifecycleDeps): Promise<LifecycleReport> {
  const now = deps.clock.now();
  if (Number.isNaN(now.getTime())) throw new Error("lifecycle: the clock gave no valid time");
  const limit = deps.limit ?? LIFECYCLE_LIMIT;

  const { config, ids } = await deps.runTx(async (tx) => {
    const config = await readLifecycleConfig(tx);
    const horizon = Math.max(...config.reminderDays);
    return { config, ids: await lifecycleRepo(tx).listCandidates(now, horizon, limit) };
  });

  const counts = { reminded: 0, renewed: 0, graced: 0, retained: 0, ended: 0, failed: 0 };
  const outbox: QueueMessage[] = [];
  for (const id of ids) {
    try {
      // runTx can run its callback again: everything built here is local to one run.
      const result = await deps.runTx((tx) => process(tx, id, now, config, deps));
      if (result.step !== "none") {
        counts[result.step] += 1;
        deps.log({ event: "lifecycle", action: result.step, subscriptionId: id });
      }
      outbox.push(...result.messages);
    } catch (error) {
      counts.failed += 1;
      // The name of the error and the id: never its message or its data (R14).
      deps.log({
        event: "lifecycle",
        action: "error",
        subscriptionId: id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (deps.queue !== undefined) {
    for (const message of outbox) await sendAfterCommit(deps.queue, message);
  }
  return { examined: ids.length, ...counts };
}
