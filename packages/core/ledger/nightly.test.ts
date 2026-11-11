import { describe, expect, it, vi } from "vitest";
import type { LedgerCheckResult } from "./check";
import {
  LedgerMismatchError,
  runLedgerCheck,
  type LedgerAlert,
  type LedgerAlertEvent,
} from "./nightly";

const clean: LedgerCheckResult = {
  ok: true,
  wallets: 2,
  transactions: 3,
  entries: 9,
  findingCount: 0,
  findings: [],
  truncated: false,
};
const dirty: LedgerCheckResult = {
  ok: false,
  wallets: 2,
  transactions: 3,
  entries: 9,
  findingCount: 1,
  truncated: false,
  findings: [
    {
      kind: "wallet_mismatch",
      walletId: "w",
      customerId: "c",
      cachedMinor: 1001n,
      entriesMinor: 1000n,
    },
  ],
};
const run = <T>(fn: (tx: never) => Promise<T>) => fn({} as never);
const recorder = () => {
  const events: LedgerAlertEvent[] = [];
  const alert: LedgerAlert = { raise: async (e) => void events.push(e) };
  return { events, alert };
};

describe("runLedgerCheck", () => {
  it("returns the result of a clean ledger and raises nothing", async () => {
    const { events, alert } = recorder();
    expect(await runLedgerCheck({ run, alert, check: async () => clean })).toBe(clean);
    expect(events).toEqual([]);
  });
  it("raises one mismatch alert and ends in failure when the ledger has findings (R16)", async () => {
    const { events, alert } = recorder();
    const options = { maxFindings: 5 };
    const check = vi.fn(async () => dirty);
    const error = await runLedgerCheck({ run, alert, check }, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerMismatchError);
    expect(error).toMatchObject({ findingCount: 1, message: "ledger check: 1 finding" });
    expect(events).toEqual([{ kind: "mismatch", result: dirty }]);
    expect(check).toHaveBeenCalledWith(expect.anything(), options);
  });
  it("raises a check_failed alert and rethrows the error of a check that cannot run", async () => {
    const { events, alert } = recorder();
    const dbError = Object.assign(new Error("database error 57P01"), { name: "DbError" });
    await expect(
      runLedgerCheck({
        run,
        alert,
        check: async () => {
          throw dbError;
        },
      }),
    ).rejects.toBe(dbError);
    const other = new Error("boom");
    await expect(
      runLedgerCheck({
        run,
        alert,
        check: async () => {
          throw other;
        },
      }),
    ).rejects.toBe(other);
    expect(events).toEqual([
      { kind: "check_failed", reason: "database_error" },
      { kind: "check_failed", reason: "unexpected" },
    ]);
  });
  it("an alert that fails never hides the real error", async () => {
    const alert: LedgerAlert = {
      raise: async () => {
        throw new Error("sink down");
      },
    };
    await expect(runLedgerCheck({ run, alert, check: async () => dirty })).rejects.toBeInstanceOf(
      LedgerMismatchError,
    );
    const original = new Error("db down");
    await expect(
      runLedgerCheck({
        run,
        alert,
        check: async () => {
          throw original;
        },
      }),
    ).rejects.toBe(original);
  });
  it("raises the alert after the transaction is closed, never inside it", async () => {
    let open = false;
    const seen: boolean[] = [];
    const trackedRun = async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
      open = true;
      try {
        return await fn({} as never);
      } finally {
        open = false;
      }
    };
    const alert: LedgerAlert = { raise: async () => void seen.push(open) };
    await runLedgerCheck({ run: trackedRun, alert, check: async () => dirty }).catch(
      () => undefined,
    );
    await runLedgerCheck({
      run: trackedRun,
      alert,
      check: async () => {
        throw new Error("boom");
      },
    }).catch(() => undefined);
    expect(seen).toEqual([false, false]);
  });
  it("refuses to run under another role than the one it requires, before any ledger query", async () => {
    const { events, alert } = recorder();
    const check = vi.fn(async () => clean);
    await expect(
      runLedgerCheck({
        run,
        alert,
        check,
        requireRole: "worker_rw",
        currentRole: async () => "web_rw",
      }),
    ).rejects.toThrow("ledger check: the connection does not have the role of the job");
    expect(check).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: "check_failed", reason: "unexpected" }]);
  });
  it("runs under the role it requires", async () => {
    const { events, alert } = recorder();
    const deps = {
      run,
      alert,
      check: async () => clean,
      requireRole: "worker_rw",
      currentRole: async () => "worker_rw",
    };
    expect(await runLedgerCheck(deps)).toBe(clean);
    expect(events).toEqual([]);
  });
});
