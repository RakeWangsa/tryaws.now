import {
  runLedgerCheck,
  type LedgerAlert,
  type LedgerAlertEvent,
  type LedgerCheckDeps,
  type LedgerCheckResult,
} from "@tc/core";
import { withTx } from "@tc/db";

// The handler of the nightly ledger check (spec 9.1, 15, K). The schedule and the alarms are infra
// (open point 12). A metric filter of the alarm work can match the messages `ledger_mismatch`,
// `ledger_check_failed` and, for the silence of the job, `ledger_check_ok`. No AWS code here.

const MAX_LOGGED_FINDINGS = 10;

// R14: counts, kinds, ids and amounts. Every bigint is written as its decimal text.
function bigintAsText(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function describeAlert(event: LedgerAlertEvent): Record<string, unknown> {
  if (event.kind === "check_failed") {
    return { level: "error", msg: "ledger_check_failed", reason: event.reason };
  }
  const { result } = event;
  const kinds: Record<string, number> = {};
  for (const finding of result.findings) {
    kinds[finding.kind] = (kinds[finding.kind] ?? 0) + 1;
  }
  const shown = result.findings.slice(0, MAX_LOGGED_FINDINGS);
  return {
    level: "error",
    msg: "ledger_mismatch",
    findingCount: result.findingCount,
    truncated: result.truncated,
    kinds,
    findings: JSON.parse(JSON.stringify(shown, bigintAsText)) as unknown,
  };
}

export const logAlert: LedgerAlert = {
  async raise(event) {
    console.error(JSON.stringify(describeAlert(event)));
  },
};

export function makeLedgerCheckHandler(
  deps: LedgerCheckDeps = { run: withTx, alert: logAlert, requireRole: "worker_rw" },
): () => Promise<LedgerCheckResult> {
  return async () => {
    const result = await runLedgerCheck(deps);
    // After the run has returned, so a failed run writes no such line.
    console.info(
      JSON.stringify({
        level: "info",
        msg: "ledger_check_ok",
        wallets: result.wallets,
        transactions: result.transactions,
        entries: result.entries,
      }),
    );
    return result;
  };
}

export const ledgerCheckHandler = makeLedgerCheckHandler();
