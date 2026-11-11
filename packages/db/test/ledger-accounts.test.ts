import { describe, expect, it } from "vitest";
import type { Tx } from "../client";
import {
  addToWallet,
  customerMarketCurrency,
  findPlatformAccounts,
  findWalletAccount,
  insertPlatformAccount,
  insertWallet,
  insertWalletAccount,
  lockWalletRow,
  readWalletRow,
  sumWalletEntries,
} from "../ledger/accounts";
import { asInt, asNullableText, asText, toMinor } from "../ledger/values";
import { runTransaction, type DatabaseRole } from "../tx";
import { inTransaction } from "./sql";
import { useTempDatabase } from "./temp-db";
import { newCustomer, postLedger, systemAccount } from "./fixtures";
import { holdOpen, waitForLockWaiter } from "./ledger-helpers";

const t = useTempDatabase();
const run = <T>(fn: (tx: Tx) => Promise<T>, role?: DatabaseRole) =>
  runTransaction(t.db, fn, role === undefined ? {} : { role });
const ROLES = ["web_rw", "admin_rw", "worker_rw"] as const;

// A customer with a wallet row and a wallet account, made as web_rw (sign-up).
async function wallet() {
  const customerId = await newCustomer(t.pool);
  const ids = await run(
    async (tx) => ({
      walletId: await insertWallet(tx, customerId, "BDT"),
      accountId: await insertWalletAccount(tx, customerId, "BDT"),
    }),
    "web_rw",
  );
  return { customerId, walletId: ids.walletId!, accountId: ids.accountId! };
}

describe("values", () => {
  it("toMinor is exact above 2^53 and above the bigint range, and refuses everything else", () => {
    expect(toMinor("9007199254740993")).toBe(9007199254740993n);
    expect(toMinor("9223372036854775808")).toBe(9223372036854775808n);
    expect(toMinor("-5")).toBe(-5n);
    expect(toMinor(7n)).toBe(7n);
    for (const bad of [5, 1.5, "1.5", "", "12a", "1e3", null, undefined, {}]) {
      expect(() => toMinor(bad)).toThrow(new TypeError("ledger: not an integer amount"));
    }
  });
  it("asText, asNullableText and asInt refuse what they do not know", () => {
    expect(asText("x")).toBe("x");
    expect(asNullableText(null)).toBeNull();
    expect(asInt("12")).toBe(12);
    expect(asInt(3)).toBe(3);
    for (const bad of [5, null, undefined]) expect(() => asText(bad)).toThrow(TypeError);
    for (const bad of ["1e3", "-1", 1.5, "9".repeat(16), null]) {
      expect(() => asInt(bad)).toThrow(TypeError);
    }
  });
});

describe("accounts", () => {
  it("a platform account is created once; the second insert returns null", async () => {
    expect(typeof (await run((tx) => insertPlatformAccount(tx, "refunds", "BDT")))).toBe("string");
    expect(await run((tx) => insertPlatformAccount(tx, "refunds", "BDT"))).toBeNull();
    const found = await run((tx) => findPlatformAccounts(tx, "BDT", ["refunds", "adjustments"]));
    expect(found.map((a) => [a.type, a.customerId, a.currency])).toEqual([
      ["refunds", null, "BDT"],
    ]);
    expect(await run((tx) => findPlatformAccounts(tx, "USD", ["refunds"]))).toEqual([]);
    expect(await run((tx) => findPlatformAccounts(tx, "BDT", []))).toEqual([]);
  });
  it("a wallet and its account are created once as web_rw, and read back", async () => {
    const w = await wallet();
    expect(await run((tx) => insertWallet(tx, w.customerId, "BDT"), "web_rw")).toBeNull();
    expect(await run((tx) => insertWalletAccount(tx, w.customerId, "BDT"), "web_rw")).toBeNull();
    expect(await run((tx) => readWalletRow(tx, w.customerId))).toEqual({
      id: w.walletId,
      customerId: w.customerId,
      currency: "BDT",
      balanceMinor: 0n,
      version: 0,
    });
    expect(await run((tx) => findWalletAccount(tx, w.customerId, "BDT"))).toEqual({
      id: w.accountId,
      type: "customer_wallet",
      customerId: w.customerId,
      currency: "BDT",
    });
    expect(await run((tx) => findWalletAccount(tx, w.customerId, "USD"))).toBeNull();
    expect(await run((tx) => readWalletRow(tx, crypto.randomUUID()))).toBeNull();
  });
  it("reads and locks the rows of the customer it is given and no other customer's (the cross-tenant case of R8 for these functions)", async () => {
    const a = await wallet();
    const b = await wallet();
    await run((tx) => addToWallet(tx, b.walletId, 777n));
    expect(await run((tx) => readWalletRow(tx, a.customerId))).toMatchObject({
      id: a.walletId,
      customerId: a.customerId,
      balanceMinor: 0n,
    });
    expect(await run((tx) => lockWalletRow(tx, a.customerId))).toMatchObject({
      id: a.walletId,
      customerId: a.customerId,
      balanceMinor: 0n,
    });
    expect(await run((tx) => findWalletAccount(tx, a.customerId, "BDT"))).toMatchObject({
      id: a.accountId,
      customerId: a.customerId,
    });
    expect(await run((tx) => readWalletRow(tx, b.customerId))).toMatchObject({
      id: b.walletId,
      balanceMinor: 777n,
    });
    expect(await run((tx) => findWalletAccount(tx, b.customerId, "BDT"))).toMatchObject({
      id: b.accountId,
    });
  });
  it.each(["admin_rw", "worker_rw"] as const)(
    "%s cannot insert a wallet or an account (42501)",
    async (role) => {
      const customerId = await newCustomer(t.pool);
      for (const insert of [
        (tx: Tx) => insertWallet(tx, customerId, "BDT"),
        (tx: Tx) => insertWalletAccount(tx, customerId, "BDT"),
        (tx: Tx) => insertPlatformAccount(tx, "markup_income", "BDT"),
      ]) {
        await expect(run(insert, role)).rejects.toMatchObject({ name: "DbError", code: "42501" });
      }
    },
  );
  it.each(ROLES)("the market currency of a customer is readable as %s", async (role) => {
    const customerId = await newCustomer(t.pool);
    expect(await run((tx) => customerMarketCurrency(tx, customerId), role)).toBe("BDT");
    expect(await run((tx) => customerMarketCurrency(tx, crypto.randomUUID()), role)).toBeNull();
  });
});

describe("the wallet cache", () => {
  it.each(ROLES)("addToWallet moves it, never below 0, as %s", async (role) => {
    const w = await wallet();
    expect(await run((tx) => addToWallet(tx, w.walletId, 1000n), role)).toBe(1000n);
    expect(await run((tx) => addToWallet(tx, w.walletId, -1001n), role)).toBeNull();
    expect(await run((tx) => addToWallet(tx, w.walletId, -1000n), role)).toBe(0n);
    expect(await run((tx) => readWalletRow(tx, w.customerId))).toMatchObject({
      balanceMinor: 0n,
      version: 2,
    });
  });
  it("addToWallet refuses a result above the bigint range, and an unknown wallet", async () => {
    const w = await wallet();
    await t.pool.query("update wallets set balance_minor = 9223372036854775807 where id = $1", [
      w.walletId,
    ]);
    expect(await run((tx) => addToWallet(tx, w.walletId, 1n))).toBeNull();
    expect(await run((tx) => addToWallet(tx, w.walletId, -1n))).toBe(9223372036854775806n);
    expect(await run((tx) => addToWallet(tx, crypto.randomUUID(), 1n))).toBeNull();
  });
  it("lockWalletRow holds the row: a second locker waits and then reads what the first wrote", async () => {
    const w = await wallet();
    const first = holdOpen(
      (fn) => run(fn, "web_rw"),
      async (tx) => {
        await lockWalletRow(tx, w.customerId);
        await addToWallet(tx, w.walletId, 500n);
        return null;
      },
    );
    await first.reached;
    const second = run((tx) => lockWalletRow(tx, w.customerId), "worker_rw");
    await waitForLockWaiter(t.pool);
    first.release();
    await first.result;
    expect((await second)?.balanceMinor).toBe(500n);
    expect(await run((tx) => lockWalletRow(tx, crypto.randomUUID()))).toBeNull();
  }, 20_000);
  it("sumWalletEntries is credits minus debits on the wallet account, 0n without entries, null without a wallet", async () => {
    const w = await wallet();
    expect(await run((tx) => sumWalletEntries(tx, w.walletId))).toBe(0n);
    const clearing = await systemAccount(t.pool, "gateway_clearing");
    const revenue = await systemAccount(t.pool, "revenue_aws_base");
    await inTransaction(t.pool, (c) =>
      postLedger(c, "s1:" + w.walletId, [
        [clearing, "debit", 1000],
        [w.accountId, "credit", 1000],
      ]),
    );
    await inTransaction(t.pool, (c) =>
      postLedger(c, "s2:" + w.walletId, [
        [w.accountId, "debit", 300],
        [revenue, "credit", 300],
      ]),
    );
    expect(await run((tx) => sumWalletEntries(tx, w.walletId))).toBe(700n);
    expect(await run((tx) => sumWalletEntries(tx, crypto.randomUUID()))).toBeNull();
  });
});
