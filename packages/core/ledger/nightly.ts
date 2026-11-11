import { currentDatabaseUser, type Tx } from "@tc/db";
import { checkLedger, type LedgerCheckOptions, type LedgerCheckResult } from "./check";

// The nightly job (spec 9.1, 15, K, R16). It runs the balance check in one transaction and makes a
// finding loud: the alert is an interface (no AWS here), and the job ends in failure so that the
// error alarm of the function fires as well. It corrects nothing.

export type LedgerAlertEvent =
  | { readonly kind: "mismatch"; readonly result: LedgerCheckResult }
  | { readonly kind: "check_failed"; readonly reason: "database_error" | "unexpected" };

export interface LedgerAlert {
  raise(event: LedgerAlertEvent): Promise<void>;
}

export interface LedgerCheckDeps {
  readonly run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>; // withTx in production
  readonly alert: LedgerAlert;
  readonly check?: (tx: Tx, options?: LedgerCheckOptions) => Promise<LedgerCheckResult>; // checkLedger; replaced in tests
  readonly requireRole?: string; // "worker_rw" in production: refuse to run under any other role
  readonly currentRole?: (tx: Tx) => Promise<string>; // currentDatabaseUser; replaced in tests
}

export class LedgerMismatchError extends Error {
  readonly findingCount: number;
  constructor(findingCount: number) {
    super(`ledger check: ${findingCount} ${findingCount === 1 ? "finding" : "findings"}`);
    this.name = "LedgerMismatchError";
    this.findingCount = findingCount;
  }
}

// An error of the alert sink never hides the real error.
async function raiseQuietly(alert: LedgerAlert, event: LedgerAlertEvent): Promise<void> {
  try {
    await alert.raise(event);
  } catch {
    // swallowed on purpose: the job fails with its own error right after
  }
}

export async function runLedgerCheck(
  deps: LedgerCheckDeps,
  options?: LedgerCheckOptions,
): Promise<LedgerCheckResult> {
  let result: LedgerCheckResult;
  try {
    result = await deps.run(async (tx) => {
      // First statement: the role. A connection with wider rights (the table owner, for example)
      // would pass every query of the check (R3).
      if (deps.requireRole !== undefined) {
        const role = await (deps.currentRole ?? currentDatabaseUser)(tx);
        if (role !== deps.requireRole) {
          throw new Error("ledger check: the connection does not have the role of the job");
        }
      }
      return (deps.check ?? checkLedger)(tx, options);
    });
  } catch (error) {
    // After deps.run has rejected: the transaction is closed, a slow sink holds nothing.
    const reason =
      error instanceof Error && error.name === "DbError" ? "database_error" : "unexpected";
    await raiseQuietly(deps.alert, { kind: "check_failed", reason });
    throw error;
  }
  if (result.ok && result.findingCount === 0) return result;
  await raiseQuietly(deps.alert, { kind: "mismatch", result });
  throw new LedgerMismatchError(result.findingCount);
}
