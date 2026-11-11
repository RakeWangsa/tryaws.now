import { type Clock } from "@tc/core";
import { withTx } from "@tc/db";
import { unconfiguredInventory, type InventoryPort } from "./inventory";
import { ledgerCheckHandler } from "./ledger-check";
import {
  ReconcileIncompleteError,
  runReconcile,
  type ReconcileDeps,
  type ReconcileResult,
} from "./reconcile";

// The daily handler. The schedule and the alarms are infra. It runs the inventory comparison and then
// the ledger check (trial balance and wallet-equals-ledger, ledger-check.ts); both always run, and the
// first error is thrown after both are done, so the error alarm of the function fires (R16). A run that
// found orphans or missing resources reports them (log and discrepancies) and still succeeds: that is
// data for the admin, not a failed job. An incomplete run fails.

export interface NightlyDeps {
  readonly reconcile: () => Promise<ReconcileResult>;
  readonly ledger: () => Promise<unknown>;
}

export function makeNightlyHandler(deps: NightlyDeps): () => Promise<ReconcileResult | undefined> {
  return async () => {
    let result: ReconcileResult | undefined;
    let failure: unknown;
    try {
      result = await deps.reconcile();
      if (result.incomplete) {
        failure = new ReconcileIncompleteError(result.unreachable.length, result.capacitySkipped);
      }
    } catch (error) {
      failure = error;
    }
    try {
      await deps.ledger();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
    return result;
  };
}

const systemClock: Clock = { now: () => new Date() };

export function makeReconcilerHandler(
  port: InventoryPort = unconfiguredInventory,
  overrides: Partial<ReconcileDeps> = {},
): () => Promise<ReconcileResult | undefined> {
  return makeNightlyHandler({
    reconcile: () =>
      runReconcile({
        runTx: withTx,
        port,
        clock: systemClock,
        log: (event) => console.log(JSON.stringify(event)),
        requireRole: "worker_rw",
        ...overrides,
      }),
    ledger: ledgerCheckHandler,
  });
}

// Until the STS inventory exists (manual VERIFY of WP7-T6) every account is reported as not read.
export const reconcilerHandler = makeReconcilerHandler();
