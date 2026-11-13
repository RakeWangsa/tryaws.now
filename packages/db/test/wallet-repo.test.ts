import { readFileSync } from "node:fs";
import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { newUuidV7 } from "../ids";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newLedgerAccount, systemAccount } from "./fixtures";
import { inTransaction, insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);

const T0 = Date.UTC(2026, 10, 11, 10, 0, 0);
const at = (offsetMs: number, micros = 0): string =>
  new Date(T0 + offsetMs).toISOString().replace("Z", String(micros).padStart(3, "0") + "Z");

// One wallet with its ledger account; the cache row is only written when asked.
async function walletOf(customerId: string, cache?: bigint): Promise<string> {
  if (cache !== undefined) {
    await insertRow(t.pool, "wallets", {
      customer_id: customerId,
      currency: "BDT",
      balance_minor: cache.toString(),
    });
  }
  return newLedgerAccount(t.pool, "customer_wallet", customerId);
}

// A balanced transaction of two lines: the wallet and the gateway clearing account (or revenue).
async function post(
  wallet: string,
  kind: string,
  direction: "credit" | "debit",
  amountMinor: number,
  createdAt: string,
  entryId: string = uuidv7(),
): Promise<string> {
  const other = await systemAccount(
    t.pool,
    direction === "credit" ? "gateway_clearing" : "revenue_aws_base",
  );
  return inTransaction(t.pool, async (c: pg.PoolClient) => {
    const tx = await insertRow(c, "ledger_transactions", {
      kind,
      reference_type: "test",
      reference_id: uuidv7(),
      idempotency_key: "k-" + uuidv7(),
      actor_type: "system",
      memo: "staff note that the customer must never see",
      created_at: createdAt,
      // WPU-Y9: a sale row must carry a price snapshot
      ...(["purchase", "renewal", "metered_charge"].includes(kind) ? { price_snapshot: "{}" } : {}),
    });
    await insertRow(c, "ledger_entries", {
      id: entryId,
      transaction_id: tx,
      account_id: wallet,
      direction,
      amount_minor: amountMinor,
      created_at: createdAt,
    });
    await insertRow(c, "ledger_entries", {
      transaction_id: tx,
      account_id: other,
      direction: direction === "credit" ? "debit" : "credit",
      amount_minor: amountMinor,
      created_at: createdAt,
    });
    return tx;
  });
}

it("view returns the cached balance and the currency of the scope's customer", async () => {
  const c = await newCustomer(t.pool);
  await walletOf(c, 123_456n);
  expect(await as(c, (r) => r.wallet.view())).toEqual({ balanceMinor: 123_456n, currency: "BDT" });
});

it("view is null for a customer with no wallet row", async () => {
  const c = await newCustomer(t.pool);
  expect(await as(c, (r) => r.wallet.view())).toBeNull();
});

it("a statement of a customer with no account is empty", async () => {
  const c = await newCustomer(t.pool);
  expect(await as(c, (r) => r.wallet.statement({ limit: 10 }))).toEqual({
    lines: [],
    nextCursor: null,
  });
});

it("the statement lists newest first with the running balance, and the last equals the cache", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await walletOf(c, 100_000n);
  await post(wallet, "topup", "credit", 100_000, at(0));
  await post(wallet, "purchase", "debit", 30_000, at(1000));
  await post(wallet, "reversal", "credit", 30_000, at(2000));

  const page = await as(c, (r) => r.wallet.statement({ limit: 10 }));
  expect(page.nextCursor).toBeNull();
  expect(page.lines.map((l) => [l.kind, l.direction, l.amountMinor, l.balanceAfterMinor])).toEqual([
    ["reversal", "credit", 30_000n, 100_000n],
    ["purchase", "debit", 30_000n, 70_000n],
    ["topup", "credit", 100_000n, 100_000n],
  ]);
  const view = await as(c, (r) => r.wallet.view());
  expect(page.lines[0]?.balanceAfterMinor).toBe(view?.balanceMinor);
  for (const line of page.lines) {
    expect(line.referenceType).toBe("test");
    expect(line.createdAt).toBeInstanceOf(Date);
    expect(typeof line.entryId).toBe("string");
    expect(typeof line.transactionId).toBe("string");
  }
});

it("no line has a memo, and the repository never selects it", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await walletOf(c, 100n);
  await post(wallet, "topup", "credit", 100, at(0));
  const page = await as(c, (r) => r.wallet.statement({ limit: 10 }));
  for (const line of page.lines) {
    expect(Object.keys(line)).not.toContain("memo");
    expect(JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(
      /staff note/,
    );
  }
  const source = readFileSync(
    new URL("../repositories/customer/wallet.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(/memo/);
});

it("paging with limit 2 continues without a gap or a repeat and keeps the running sum of older lines", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await walletOf(c, 500n);
  for (let i = 0; i < 5; i += 1) await post(wallet, "topup", "credit", 100, at(i * 1000));

  const first = await as(c, (r) => r.wallet.statement({ limit: 2 }));
  expect(first.lines.map((l) => l.balanceAfterMinor)).toEqual([500n, 400n]);
  expect(first.nextCursor).toMatch(/^[0-9]{10,16}\.[0-9a-f-]{36}$/);
  const second = await as(c, (r) =>
    r.wallet.statement({ limit: 2, cursor: first.nextCursor as string }),
  );
  expect(second.lines.map((l) => l.balanceAfterMinor)).toEqual([300n, 200n]);
  const third = await as(c, (r) =>
    r.wallet.statement({ limit: 2, cursor: second.nextCursor as string }),
  );
  expect(third.lines.map((l) => l.balanceAfterMinor)).toEqual([100n]);
  expect(third.nextCursor).toBeNull();

  const all = [...first.lines, ...second.lines, ...third.lines].map((l) => l.entryId);
  expect(new Set(all).size).toBe(5);
});

it("lines that share a millisecond are ordered and paged by microsecond, then id", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await walletOf(c, 400n);
  await post(wallet, "topup", "credit", 100, at(0, 1));
  await post(wallet, "topup", "credit", 100, at(0, 2));
  await post(wallet, "topup", "credit", 100, at(0, 3));
  await post(wallet, "topup", "credit", 100, at(0, 3));

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 6; i += 1) {
    const page = await as(c, (r) =>
      r.wallet.statement(cursor === undefined ? { limit: 1 } : { limit: 1, cursor }),
    );
    seen.push(...page.lines.map((l) => `${l.entryId}:${l.balanceAfterMinor}`));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  expect(seen).toHaveLength(4);
  expect(new Set(seen.map((s) => s.split(":")[0])).size).toBe(4);
  expect(seen.map((s) => s.split(":")[1])).toEqual(["400", "300", "200", "100"]);
});

it("entries of other accounts of the same transaction never appear", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await walletOf(c, 100n);
  await post(wallet, "topup", "credit", 100, at(0));
  const page = await as(c, (r) => r.wallet.statement({ limit: 10 }));
  expect(page.lines).toHaveLength(1);
  const { rows } = await t.pool.query("select count(*)::int as n from ledger_entries");
  expect(rows[0].n).toBeGreaterThan(1);
});

it("two customers each see only their own lines", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const wa = await walletOf(a, 100n);
  const wb = await walletOf(b, 700n);
  await post(wa, "topup", "credit", 100, at(0));
  await post(wb, "topup", "credit", 700, at(0));
  const pa = await as(a, (r) => r.wallet.statement({ limit: 10 }));
  const pb = await as(b, (r) => r.wallet.statement({ limit: 10 }));
  expect(pa.lines.map((l) => l.amountMinor)).toEqual([100n]);
  expect(pb.lines.map((l) => l.amountMinor)).toEqual([700n]);
});

it.each([
  "",
  "abc",
  "1.2",
  "1234567890.not-a-uuid",
  "123456789012345678.0189d1f0-0000-7000-8000-000000000000",
])("an invalid cursor %j gives an empty page", async (cursor) => {
  const c = await newCustomer(t.pool);
  const wallet = await walletOf(c, 100n);
  await post(wallet, "topup", "credit", 100, at(0));
  expect(await as(c, (r) => r.wallet.statement({ limit: 10, cursor }))).toEqual({
    lines: [],
    nextCursor: null,
  });
});

it.each([0, 101, 1.5, -1, Number.NaN])("limit %s is a TypeError", async (limit) => {
  const c = await newCustomer(t.pool);
  await expect(as(c, (r) => r.wallet.statement({ limit }))).rejects.toThrow(TypeError);
});

it("the wallet repository source holds no float parse of money", () => {
  const source = readFileSync(
    new URL("../repositories/customer/wallet.ts", import.meta.url),
    "utf8",
  );
  for (const bad of ["Number(", "parseInt(", "parseFloat("]) expect(source).not.toContain(bad);
});

it("newUuidV7 gives version 7 ids that differ and sort in call order", () => {
  const ids = Array.from({ length: 10 }, () => newUuidV7());
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  expect(new Set(ids).size).toBe(10);
  expect([...ids].sort()).toEqual(ids);
});
