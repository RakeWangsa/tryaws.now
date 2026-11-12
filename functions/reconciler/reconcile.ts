import {
  compareInventory,
  dayKeyOf,
  findingId,
  planCapacityChecks,
  planUsageWrites,
  recomputeUsed,
  staleOperations,
  type Clock,
  type Finding,
  type Logger,
  type RunTx,
} from "@tc/core";
import { currentDatabaseUser, meteringRepo, reconcileRepo, type PoolAccountRef } from "@tc/db";
import type { InventoryFailure, InventoryPort } from "./inventory";

// The nightly run (WP7-T6, spec 3, 10.2). It compares, reports and corrects nothing in AWS or in the
// ledger. The only value it changes is pool_capacity.used, through recomputeUsed, with an audit row.
// One run per day: every finding row has an id made from the day, so a repeat is a no-op (R7). An
// account that could not be read is reported and left out of every comparison (R16).

const MAX_LOGGED = 20;
const OPEN_OPERATIONS_LIMIT = 1000;

export interface ReconcileDeps {
  readonly runTx: RunTx; // withTx in production
  readonly port: InventoryPort;
  readonly clock: Clock;
  readonly log: Logger;
  readonly graceMs?: number;
  /** "worker_rw" in production: refuse to run under any other role. */
  readonly requireRole?: string;
}

export interface ReconcileResult {
  readonly dayKey: string;
  readonly accounts: number;
  readonly orphans: number;
  readonly missing: number;
  readonly newFindings: number;
  readonly replayedFindings: number;
  readonly unreachable: { poolAccountId: string; reason: InventoryFailure }[];
  readonly capacityCorrected: number;
  readonly capacitySkipped: number;
  readonly capacityOverLimit: number;
  readonly capacityFailed: number;
  /** WPU-B3: usage rows written (snapshot GB, transfer GB), samples dropped, accounts whose write failed. */
  readonly usageWritten: number;
  readonly usageSkipped: number;
  readonly usageFailed: number;
  readonly staleOperations: number;
  /** True when something could not be read or checked: the answer is not "all clear". */
  readonly incomplete: boolean;
}

export class ReconcileIncompleteError extends Error {
  constructor(unreachable: number, skipped: number) {
    super(
      `reconcile: ${unreachable} accounts unreachable, ${skipped} capacity cells without a live count`,
    );
    this.name = "ReconcileIncompleteError";
  }
}

function details(dayKey: string, f: Finding): Record<string, string | null> {
  return {
    reason: f.reason,
    poolAccountId: f.poolAccountId,
    region: f.region,
    family: f.family,
    awsName: f.awsName,
    resourceId: f.resourceId ?? null,
    dbState: f.dbState ?? null,
    awsState: f.awsState ?? null,
    dayKey,
  };
}

export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { runTx, port, clock, log } = deps;
  const now = clock.now();
  const dayKey = dayKeyOf(now);

  const accounts = await runTx(async (tx) => {
    // First statement: the role. A connection with wider rights would pass every query (R3).
    if (deps.requireRole !== undefined) {
      const role = await currentDatabaseUser(tx);
      if (role !== deps.requireRole) {
        throw new Error("reconcile: the connection does not have the role of the job");
      }
    }
    return reconcileRepo(tx).activePoolAccounts();
  });

  const out = {
    orphans: 0,
    missing: 0,
    newFindings: 0,
    replayedFindings: 0,
    capacityCorrected: 0,
    capacitySkipped: 0,
    capacityOverLimit: 0,
    capacityFailed: 0,
    usageWritten: 0,
    usageSkipped: 0,
    usageFailed: 0,
  };
  const unreachable: ReconcileResult["unreachable"] = [];

  for (const account of accounts) {
    await reconcileAccount(account);
  }

  async function reconcileAccount(account: PoolAccountRef): Promise<void> {
    // The read of AWS is outside any transaction: nothing is held while we wait for it.
    let read;
    try {
      read = await port.read(account);
    } catch {
      unreachable.push({ poolAccountId: account.id, reason: "unreachable" });
      return;
    }
    if (!read.ok) {
      unreachable.push({ poolAccountId: account.id, reason: read.reason });
      return;
    }
    const { items, live, usage } = read.value;

    // The rows are read after AWS: a resource found in AWS has its row committed already.
    await runTx(async (tx) => {
      const repo = reconcileRepo(tx);
      const rows = await repo.resourcesOfAccount(account.id);
      const findings = compareInventory({
        poolAccountId: account.id,
        aws: items,
        rows,
        now,
        ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
      });
      for (const f of findings) {
        if (f.kind === "orphan") out.orphans += 1;
        else out.missing += 1;
        const id = findingId(dayKey, f.kind, `${account.id}:${f.awsName}:${f.reason}`);
        const written = await repo.recordFinding(id, f.kind, details(dayKey, f));
        if (written) out.newFindings += 1;
        else out.replayedFindings += 1;
      }
    });

    // WPU-B3: the usage that AWS reported goes into usage_records, one transaction for the account. A
    // failure leaves the account's usage as it was and makes the run incomplete (R16).
    if (usage !== undefined && usage.length > 0) {
      try {
        const written = await runTx(async (tx) => {
          const rows = await reconcileRepo(tx).resourcesOfAccount(account.id);
          const plan = planUsageWrites(usage, rows, now);
          const metering = meteringRepo(tx);
          for (const w of plan.writes) {
            await metering.upsertUsage(w.resourceId, w.metric, w.period, w.quantity);
          }
          return {
            count: plan.writes.length,
            skipped: Object.values(plan.skipped).reduce((a, b) => a + (b ?? 0), 0),
            reasons: Object.keys(plan.skipped).sort().join(","),
          };
        });
        out.usageWritten += written.count;
        out.usageSkipped += written.skipped;
        if (written.skipped > 0) {
          log({
            event: "reconcile_usage_skipped",
            severity: "warn",
            poolAccountId: account.id,
            skipped: written.skipped,
            reasons: written.reasons,
          });
        }
      } catch {
        out.usageFailed += 1;
        log({ event: "reconcile_usage_failed", severity: "alert", poolAccountId: account.id });
      }
    }

    const capacityRows = await runTx((tx) => reconcileRepo(tx).capacityRows(account.id));
    const plan = planCapacityChecks(capacityRows, live);
    out.capacitySkipped += plan.skipped.length;
    for (const check of plan.checks) {
      try {
        await runTx(async (tx) => {
          const outcome = await recomputeUsed(tx, {
            poolAccountId: account.id,
            region: check.region,
            quotaCode: check.quotaCode as Parameters<typeof recomputeUsed>[1]["quotaCode"],
            live: check.live,
            clock,
          });
          if (outcome.previous !== outcome.used) {
            await reconcileRepo(tx).recordCapacityCorrection({
              poolAccountId: account.id,
              region: check.region,
              quotaCode: check.quotaCode,
              previous: outcome.previous,
              used: outcome.used,
            });
            out.capacityCorrected += 1;
          }
          const limit = capacityRows.find(
            (r) => r.region === check.region && r.quotaCode === check.quotaCode,
          )?.quotaLimit;
          if (limit !== undefined && outcome.used > limit) {
            out.capacityOverLimit += 1;
            log({
              event: "reconcile_capacity_over_limit",
              severity: "alert",
              poolAccountId: account.id,
              region: check.region,
              quotaCode: check.quotaCode,
              used: outcome.used,
              limit,
            });
          }
        });
      } catch {
        // Fail closed: this cell stays as it was and the run is reported incomplete.
        out.capacityFailed += 1;
      }
    }
  }

  const stale = staleOperations(
    await runTx((tx) => reconcileRepo(tx).openOperations(OPEN_OPERATIONS_LIMIT)),
    now,
  );
  if (stale.length > 0) {
    log({
      event: "reconcile_stale_operations",
      severity: "alert",
      count: stale.length,
      operationIds: stale
        .slice(0, MAX_LOGGED)
        .map((s) => s.operationId)
        .join(","),
    });
  }

  const incomplete =
    unreachable.length > 0 ||
    out.capacitySkipped > 0 ||
    out.capacityFailed > 0 ||
    out.usageFailed > 0;
  if (out.orphans + out.missing > 0) {
    log({
      event: "reconcile_findings",
      severity: "alert",
      dayKey,
      orphans: out.orphans,
      missing: out.missing,
      newFindings: out.newFindings,
    });
  }
  if (incomplete) {
    log({
      event: "reconcile_incomplete",
      severity: "alert",
      dayKey,
      unreachable: unreachable.length,
      reasons: [...new Set(unreachable.map((u) => u.reason))].sort().join(","),
      capacitySkipped: out.capacitySkipped,
      capacityFailed: out.capacityFailed,
      usageFailed: out.usageFailed,
    });
  } else {
    log({ event: "reconcile_ok", severity: "info", dayKey, accounts: accounts.length });
  }

  return {
    dayKey,
    accounts: accounts.length,
    ...out,
    unreachable,
    staleOperations: stale.length,
    incomplete,
  };
}
