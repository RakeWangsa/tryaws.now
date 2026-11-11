import { describe, expect, it } from "vitest";
import { useLedgerDatabase } from "../test/ledger-fixtures";
import { lockWallet, walletBalance, walletEntriesSum } from "./balance";
import { LedgerError } from "./errors";

const L = useLedgerDatabase();

describe("walletBalance and walletEntriesSum", () => {
  it("a new wallet has 0n; a top-up moves both to the same bigint", async () => {
    const w = await L.newWallet();
    const balance = await L.run((tx) => walletBalance(tx, w.customerId));
    expect(typeof balance).toBe("bigint");
    expect(balance).toBe(0n);
    await L.fund(w, 150000n);
    expect(await L.run((tx) => walletBalance(tx, w.customerId))).toBe(150000n);
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(150000n);
  });
  it("keeps amounts above 2^53 exact", async () => {
    const w = await L.newWallet();
    await L.fund(w, 9007199254740993n);
    expect(await L.run((tx) => walletBalance(tx, w.customerId))).toBe(9007199254740993n);
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(9007199254740993n);
  });
  it("works for the roles that read wallets", async () => {
    const w = await L.newWallet();
    for (const role of ["web_rw", "admin_rw", "worker_rw"] as const) {
      expect(await L.run((tx) => walletBalance(tx, w.customerId), role)).toBe(0n);
    }
  });
  it("throws LedgerError no_wallet for a customer with no wallet, and TypeError for an id that is not a UUID", async () => {
    const stranger = crypto.randomUUID();
    for (const call of [walletBalance, lockWallet, walletEntriesSum]) {
      await expect(L.run((tx) => call(tx, stranger))).rejects.toThrow(LedgerError);
      await expect(L.run((tx) => call(tx, stranger))).rejects.toMatchObject({
        code: "no_wallet",
      });
      await expect(L.run((tx) => call(tx, "42"))).rejects.toThrow(TypeError);
    }
  });
});

describe("lockWallet", () => {
  it("holds the wallet row until the transaction ends: a second locker waits and then sees the new balance", async () => {
    const w = await L.newWallet();
    const first = L.holdOpen((tx) => lockWallet(tx, w.customerId));
    await first.reached;
    const second = L.run((tx) => lockWallet(tx, w.customerId));
    await L.waitForLockWaiter();
    first.release();
    expect(await Promise.all([first.result, second])).toEqual([0n, 0n]);
  }, 20_000);
});
