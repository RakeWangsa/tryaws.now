import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerMismatchError, type LedgerCheckResult } from "@tc/core";
import { describeAlert, logAlert, makeLedgerCheckHandler } from "./ledger-check";

const clean: LedgerCheckResult = {
  ok: true,
  wallets: 1,
  transactions: 1,
  entries: 2,
  findingCount: 0,
  findings: [],
  truncated: false,
};
const finding = (i: number) => ({
  kind: "wallet_mismatch" as const,
  walletId: `w${i}`,
  customerId: `c${i}`,
  cachedMinor: 9007199254740994n,
  entriesMinor: 9007199254740993n,
});
const dirty: LedgerCheckResult = {
  ok: false,
  wallets: 12,
  transactions: 1,
  entries: 2,
  findingCount: 12,
  truncated: false,
  findings: Array.from({ length: 12 }, (_, i) => finding(i)),
};
const run = <T>(fn: (tx: never) => Promise<T>) => fn({} as never);
afterEach(() => vi.restoreAllMocks());

describe("the alert in the log", () => {
  it("says only that the check could not run", () => {
    expect(describeAlert({ kind: "check_failed", reason: "database_error" })).toEqual({
      level: "error",
      msg: "ledger_check_failed",
      reason: "database_error",
    });
  });
  it("counts the findings by kind, shows the first ten, and writes every bigint as text", () => {
    const line = describeAlert({ kind: "mismatch", result: dirty });
    expect(line).toMatchObject({
      level: "error",
      msg: "ledger_mismatch",
      findingCount: 12,
      truncated: false,
      kinds: { wallet_mismatch: 12 },
    });
    const findings = line.findings as Record<string, unknown>[];
    expect(findings).toHaveLength(10);
    expect(findings[0]).toEqual({
      kind: "wallet_mismatch",
      walletId: "w0",
      customerId: "c0",
      cachedMinor: "9007199254740994",
      entriesMinor: "9007199254740993",
    });
    expect(() => JSON.stringify(line)).not.toThrow();
  });
  it("logAlert writes one JSON line to the error log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await logAlert.raise({ kind: "check_failed", reason: "unexpected" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]![0] as string)).toEqual({
      level: "error",
      msg: "ledger_check_failed",
      reason: "unexpected",
    });
  });
});

describe("the handler of the nightly job", () => {
  it("returns the result of a clean ledger, logs no error and writes one line of counts, so that the silence of the job can be alarmed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const handler = makeLedgerCheckHandler({ run, alert: logAlert, check: async () => clean });
    expect(await handler()).toBe(clean);
    expect(errors).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({
      level: "info",
      msg: "ledger_check_ok",
      wallets: 1,
      transactions: 1,
      entries: 2,
    });
  });
  it("logs one line and ends in failure when the ledger has findings (R16), and writes no ledger_check_ok line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const handler = makeLedgerCheckHandler({ run, alert: logAlert, check: async () => dirty });
    await expect(handler()).rejects.toBeInstanceOf(LedgerMismatchError);
    expect(info).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]![0] as string)).toMatchObject({
      msg: "ledger_mismatch",
      findingCount: 12,
    });
  });
});
