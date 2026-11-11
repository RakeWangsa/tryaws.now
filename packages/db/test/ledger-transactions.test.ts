import { describe, expect, it } from "vitest";
import type { Tx } from "../client";
import {
  findLedgerTransactionById,
  findLedgerTransactionByKey,
  findReversalOf,
  insertLedgerEntries,
  insertLedgerTransaction,
  type NewLedgerTransaction,
} from "../ledger/transactions";
import { runTransaction, type DatabaseRole } from "../tx";
import { useTempDatabase } from "./temp-db";
import { newCustomer, newLedgerAccount, systemAccount, uniqueSuffix } from "./fixtures";

const t = useTempDatabase();
const run = <T>(fn: (tx: Tx) => Promise<T>, role?: DatabaseRole) =>
  runTransaction(t.db, fn, role === undefined ? {} : { role });
const ROLES = ["web_rw", "admin_rw", "worker_rw"] as const;

const header = (key: string): NewLedgerTransaction => ({
  kind: "topup",
  referenceType: "payment",
  referenceId: crypto.randomUUID(),
  idempotencyKey: key,
  actorType: "system",
  actorId: null,
  memo: null,
});
async function accounts() {
  const clearing = await systemAccount(t.pool, "gateway_clearing");
  const customerId = await newCustomer(t.pool);
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", customerId);
  return { clearing, wallet, customerId };
}
const pair = (a: { clearing: string; wallet: string }, debit: bigint, credit: bigint) => [
  { accountId: a.clearing, direction: "debit" as const, amountMinor: debit },
  { accountId: a.wallet, direction: "credit" as const, amountMinor: credit },
];

describe("a ledger transaction", () => {
  it.each(ROLES)(
    "is written and read back as %s, with its lines and their accounts",
    async (role) => {
      const a = await accounts();
      const key = `k:${uniqueSuffix()}`;
      const row = header(key);
      const id = await run(async (tx) => {
        const made = await insertLedgerTransaction(tx, row);
        await insertLedgerEntries(tx, made!, pair(a, 9007199254740993n, 9007199254740993n));
        return made!;
      }, role);
      const found = await run((tx) => findLedgerTransactionByKey(tx, key), role);
      expect(found).toEqual({
        ...row,
        id,
        entries: [
          {
            id: expect.any(String),
            accountId: a.clearing,
            accountType: "gateway_clearing",
            accountCustomerId: null,
            currency: "BDT",
            direction: "debit",
            amountMinor: 9007199254740993n,
          },
          {
            id: expect.any(String),
            accountId: a.wallet,
            accountType: "customer_wallet",
            accountCustomerId: a.customerId,
            currency: "BDT",
            direction: "credit",
            amountMinor: 9007199254740993n,
          },
        ],
      });
      expect(await run((tx) => findLedgerTransactionById(tx, id), role)).toEqual(found);
    },
  );
  it("is not found by an unknown key or id", async () => {
    expect(await run((tx) => findLedgerTransactionByKey(tx, "nope:" + uniqueSuffix()))).toBeNull();
    expect(await run((tx) => findLedgerTransactionById(tx, crypto.randomUUID()))).toBeNull();
  });
  it("findReversalOf finds a reversal by the transaction it refers to, and only that one", async () => {
    const a = await accounts();
    const original = crypto.randomUUID();
    expect(await run((tx) => findReversalOf(tx, original))).toBeNull();
    const made = await run(async (tx) => {
      // a topup that refers to the same id is not a reversal; a reversal that refers to another id is not this one's
      const other = await insertLedgerTransaction(tx, {
        ...header(`k:${uniqueSuffix()}`),
        referenceId: original,
      });
      await insertLedgerEntries(tx, other!, pair(a, 5n, 5n));
      const elsewhere = await insertLedgerTransaction(tx, {
        ...header(`k:${uniqueSuffix()}`),
        kind: "reversal",
        referenceType: "ledger_transaction",
      });
      await insertLedgerEntries(tx, elsewhere!, pair(a, 5n, 5n));
      const reversal = await insertLedgerTransaction(tx, {
        ...header(`k:${uniqueSuffix()}`),
        kind: "reversal",
        referenceType: "ledger_transaction",
        referenceId: original,
      });
      await insertLedgerEntries(tx, reversal!, pair(a, 5n, 5n));
      return reversal!;
    });
    expect(await run((tx) => findReversalOf(tx, original))).toBe(made);
  });
  it("cannot take a key twice: the second insert returns null, also with other content and in a later transaction", async () => {
    const a = await accounts();
    const key = `k:${uniqueSuffix()}`;
    const ids = await run(async (tx) => {
      const first = await insertLedgerTransaction(tx, header(key));
      await insertLedgerEntries(tx, first!, pair(a, 5n, 5n));
      const again = await insertLedgerTransaction(tx, { ...header(key), kind: "refund" });
      return { first, again };
    });
    expect(typeof ids.first).toBe("string");
    expect(ids.again).toBeNull();
    expect(await run((tx) => insertLedgerTransaction(tx, header(key)))).toBeNull();
  });
});

describe("the database checks what the functions write", () => {
  it("lines that do not balance fail the COMMIT with 23514", async () => {
    const a = await accounts();
    await expect(
      run(async (tx) => {
        const made = await insertLedgerTransaction(tx, header(`k:${uniqueSuffix()}`));
        await insertLedgerEntries(tx, made!, pair(a, 10n, 9n));
      }),
    ).rejects.toMatchObject({ name: "DbError", code: "23514" });
  });
  it("a committed transaction cannot get more lines later: 23001", async () => {
    const a = await accounts();
    const id = await run(async (tx) => {
      const made = await insertLedgerTransaction(tx, header(`k:${uniqueSuffix()}`));
      await insertLedgerEntries(tx, made!, pair(a, 10n, 10n));
      return made!;
    });
    await expect(run((tx) => insertLedgerEntries(tx, id, pair(a, 5n, 5n)))).rejects.toMatchObject({
      name: "DbError",
      code: "23001",
    });
  });
  it("no entries is a TypeError before any query", async () => {
    await expect(run((tx) => insertLedgerEntries(tx, crypto.randomUUID(), []))).rejects.toThrow(
      new TypeError("ledger: a transaction needs entries"),
    );
  });
});
