import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import {
  fundedWallet,
  newPayment,
  refusingPoster,
  testPoster,
  walletOf,
} from "./admin-money-support";
import { newAdmin, newCustomer } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// 16.12 /payments: search by transaction id, the state and the verify payload, `reverifyPayment`
// (back to the sweeper's verified path, never a credit, R6), `recordManualRefund` (a ledger posting,
// R5) and the discrepancies queue with `resolveDiscrepancy`. Every write has its audit row (R10).
const t = useTempDatabase();
const asAdmin = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "finance"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const one = async (sql: string, args: unknown[]) => (await t.pool.query(sql, args)).rows[0];

// A customer whose top-up of `amount` was credited: the payment and its ledger transaction.
async function credited(amount: bigint) {
  const w = await fundedWallet(t.pool, amount);
  const p = await newPayment(t.pool, w.customerId, {
    amount_minor: amount,
    status: "credited",
    ledger_transaction_id: w.topupId,
    gateway_transaction_id: "EPS-" + uuidv7(),
    verified_at: new Date("2026-11-12T05:00:00.000Z"),
    verify_payload: { Status: "Success", TotalAmount: "500.00", nested: { a: 1 } },
  });
  return { ...w, ...p };
}

it("search finds a payment by its merchant transaction id, its id and its state, newest first", async () => {
  const a = await actorOf();
  const customerId = await newCustomer(t.pool);
  const first = await newPayment(t.pool, customerId, { status: "review" });
  const second = await newPayment(t.pool, customerId, { status: "initiated" });
  const byMerchant = await asAdmin(a, (r) => r.payments.search({ q: first.merchantTransactionId }));
  expect(byMerchant.ok && byMerchant.value.rows.map((x) => x.id)).toEqual([first.id]);
  const byId = await asAdmin(a, (r) => r.payments.search({ q: second.id }));
  expect(byId.ok && byId.value.rows.map((x) => x.id)).toEqual([second.id]);
  const byCustomer = await asAdmin(a, (r) => r.payments.search({ q: customerId }));
  expect(byCustomer.ok && byCustomer.value.rows.map((x) => x.id)).toEqual([second.id, first.id]);
  const review = await asAdmin(a, (r) => r.payments.search({ q: customerId, status: "review" }));
  expect(review.ok && review.value.rows.map((x) => x.id)).toEqual([first.id]);
  // "pending" is initiated and redirected (9.2)
  const pending = await asAdmin(a, (r) => r.payments.search({ q: customerId, status: "pending" }));
  expect(pending.ok && pending.value.rows.map((x) => x.id)).toEqual([second.id]);
  expect(byMerchant.ok && byMerchant.value.rows[0]).toMatchObject({
    amountMinor: 10_000n,
    currency: "BDT",
    status: "review",
    gateway: "eps",
  });
  expect(
    JSON.stringify(byMerchant, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  ).not.toContain("verify");
});

it("search pages by id and refuses a bad status, query, limit or cursor", async () => {
  const a = await actorOf();
  const customerId = await newCustomer(t.pool);
  for (let i = 0; i < 3; i += 1) await newPayment(t.pool, customerId);
  const first = await asAdmin(a, (r) => r.payments.search({ q: customerId, limit: 2 }));
  expect(first.ok && first.value.rows).toHaveLength(2);
  const next = await asAdmin(a, (r) =>
    r.payments.search({ q: customerId, limit: 2, after: first.ok ? first.value.nextAfter! : "" }),
  );
  expect(next.ok && next.value.rows).toHaveLength(1);
  expect(next.ok && next.value.nextAfter).toBeNull();
  for (const bad of [
    { status: "bogus" },
    { q: "x".repeat(101) },
    { limit: 0 },
    { limit: 101 },
    { after: "nope" },
  ]) {
    expect(await asAdmin(a, (r) => r.payments.search(bad as never)), JSON.stringify(bad)).toEqual({
      ok: false,
      error: "validation",
    });
  }
  // a query that is no id and no transaction id finds nothing, without an error
  const none = await asAdmin(a, (r) => r.payments.search({ q: "no such thing" }));
  expect(none.ok && none.value.rows).toEqual([]);
});

it("only finance and superadmin read payments", async () => {
  for (const role of ["support", "ops"] as const) {
    const actor = await actorOf(role);
    expect(await asAdmin(actor, (r) => r.payments.search({}))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await asAdmin(actor, (r) => r.payments.detail(uuidv7()))).toEqual({
      ok: false,
      error: "forbidden",
    });
  }
  expect((await asAdmin(await actorOf("superadmin"), (r) => r.payments.search({}))).ok).toBe(true);
});

it("detail shows the state, a safe projection of the verify payload, the refund and the discrepancies", async () => {
  const a = await actorOf();
  const p = await credited(50_000n);
  await insertRow(t.pool, "discrepancies", {
    kind: "payment",
    details: {
      paymentId: p.id,
      reason: "amount_mismatch",
      expectedMinor: "50000",
      gotMinor: "49000",
      state: "review",
    },
  });
  const out = await asAdmin(a, (r) => r.payments.detail(p.id));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value).toMatchObject({
    id: p.id,
    customerId: p.customerId,
    merchantTransactionId: p.merchantTransactionId,
    amountMinor: 50_000n,
    status: "credited",
    refund: null,
  });
  expect(out.value.gatewayTransactionId).toMatch(/^EPS-/);
  // only flat values: the nested object is dropped
  expect(out.value.verifyPayload).toEqual({ Status: "Success", TotalAmount: "500.00" });
  expect(out.value.discrepancies).toMatchObject([
    {
      kind: "payment",
      status: "open",
      paymentId: p.id,
      reason: "amount_mismatch",
      expectedMinor: 50_000n,
      gotMinor: 49_000n,
    },
  ]);
  expect(await asAdmin(a, (r) => r.payments.detail("nope"))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await asAdmin(a, (r) => r.payments.detail(uuidv7()))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("reverify puts a payment in review or expired back on the sweeper path; it never credits (R6)", async () => {
  const a = await actorOf();
  const customerId = await newCustomer(t.pool);
  for (const status of ["review", "expired"]) {
    const p = await newPayment(t.pool, customerId, { status });
    const out = await asAdmin(a, (r) =>
      r.payments.reverify({ paymentId: p.id }, "customer sent the receipt"),
    );
    expect(out, status).toMatchObject({
      ok: true,
      replayed: false,
      value: { id: p.id, status: "redirected" },
    });
    const row = await one("select status, ledger_transaction_id from payments where id = $1", [
      p.id,
    ]);
    expect(row).toEqual({ status: "redirected", ledger_transaction_id: null });
    const audit = (await auditRowsOf(t.pool, a.adminId)).filter(
      (x) => x.action === "payment.reverify" && x.target_id === p.id,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target_type: "payment", ip: "203.0.113.9" });
    expect(audit[0]?.metadata).toMatchObject({
      reason: "customer sent the receipt",
      before: { status },
      after: { status: "redirected" },
    });
    // a second click is a replay
    expect(
      await asAdmin(a, (r) => r.payments.reverify({ paymentId: p.id }, "again")),
    ).toMatchObject({ ok: true, replayed: true });
  }
  expect(
    await one(
      "select count(*)::int as n from ledger_transactions where kind = 'topup' and reference_id in (select id from payments where customer_id = $1)",
      [customerId],
    ),
  ).toEqual({ n: 0 });
});

it("reverify refuses a payment in another state and a role other than finance", async () => {
  const a = await actorOf();
  const customerId = await newCustomer(t.pool);
  for (const status of ["failed", "cancelled", "initiated"]) {
    const p = await newPayment(t.pool, customerId, { status });
    expect(await asAdmin(a, (r) => r.payments.reverify({ paymentId: p.id }, "try"))).toEqual({
      ok: false,
      error: "conflict",
    });
    expect((await one("select status from payments where id = $1", [p.id])).status).toBe(status);
  }
  const done = await credited(1_000n);
  expect(await asAdmin(a, (r) => r.payments.reverify({ paymentId: done.id }, "try"))).toEqual({
    ok: false,
    error: "conflict",
  });
  const review = await newPayment(t.pool, customerId, { status: "review" });
  for (const role of ["support", "ops", "superadmin"] as const) {
    expect(
      await asAdmin(await actorOf(role), (r) => r.payments.reverify({ paymentId: review.id }, "x")),
      role,
    ).toEqual({ ok: false, error: "forbidden" });
  }
  expect(await asAdmin(a, (r) => r.payments.reverify({ paymentId: "nope" }, "x"))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.payments.reverify({ paymentId: review.id }, "  "))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await asAdmin(a, (r) => r.payments.reverify({ paymentId: uuidv7() }, "x"))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect((await one("select status from payments where id = $1", [review.id])).status).toBe(
    "review",
  );
});

it("a manual refund debits the wallet and credits the refunds account, with the audit row", async () => {
  const a = await actorOf();
  const p = await credited(50_000n);
  const out = await asAdmin(a, (r) =>
    r.payments.recordManualRefund(
      { paymentId: p.id, amountMinor: 20_000n },
      "refunded in the EPS dashboard, ref 991",
      testPoster,
    ),
  );
  expect(out).toMatchObject({
    ok: true,
    replayed: false,
    value: { paymentId: p.id, amountMinor: 20_000n },
  });
  expect(await walletOf(t.pool, p.customerId)).toEqual({ balance: 30_000n, entriesSum: 30_000n });
  const tx = await one(
    "select kind, reference_type, reference_id, idempotency_key, actor_type, actor_id, memo from ledger_transactions where idempotency_key = $1",
    [`refund:${p.id}`],
  );
  expect(tx).toEqual({
    kind: "refund",
    reference_type: "payment",
    reference_id: p.id,
    idempotency_key: `refund:${p.id}`,
    actor_type: "admin",
    actor_id: a.adminId,
    memo: "refunded in the EPS dashboard, ref 991",
  });
  const lines = (
    await t.pool.query(
      `select a.type, e.direction, e.amount_minor::text as amount from ledger_entries e
         join ledger_accounts a on a.id = e.account_id
         join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = $1 order by e.id`,
      [`refund:${p.id}`],
    )
  ).rows;
  expect(lines).toEqual([
    { type: "customer_wallet", direction: "debit", amount: "20000" },
    { type: "refunds", direction: "credit", amount: "20000" },
  ]);
  const audit = (await auditRowsOf(t.pool, a.adminId)).filter((x) => x.action === "payment.refund");
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ target_type: "payment", target_id: p.id, ip: "203.0.113.9" });
  expect(audit[0]?.metadata).toMatchObject({ reason: "refunded in the EPS dashboard, ref 991" });
  const detail = await asAdmin(a, (r) => r.payments.detail(p.id));
  expect(detail.ok && detail.value.refund).toMatchObject({ amountMinor: 20_000n });
});

it("a refund is posted once: a double submit is a replay, another amount a conflict", async () => {
  const a = await actorOf();
  const p = await credited(50_000n);
  const input = { paymentId: p.id, amountMinor: 10_000n };
  expect(
    await asAdmin(a, (r) => r.payments.recordManualRefund(input, "slip 5", testPoster)),
  ).toMatchObject({ ok: true, replayed: false });
  expect(
    await asAdmin(a, (r) => r.payments.recordManualRefund(input, "slip 5", testPoster)),
  ).toMatchObject({ ok: true, replayed: true });
  expect(
    await asAdmin(a, (r) =>
      r.payments.recordManualRefund({ ...input, amountMinor: 11_000n }, "slip 5", testPoster),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await walletOf(t.pool, p.customerId)).toEqual({ balance: 40_000n, entriesSum: 40_000n });
  expect(
    await one(
      "select count(*)::int as n from ledger_transactions where kind = 'refund' and reference_id = $1",
      [p.id],
    ),
  ).toEqual({ n: 1 });
  const q = await credited(50_000n);
  const results = await Promise.all([
    asAdmin(a, (r) =>
      r.payments.recordManualRefund({ paymentId: q.id, amountMinor: 5_000n }, "twice", testPoster),
    ),
    asAdmin(a, (r) =>
      r.payments.recordManualRefund({ paymentId: q.id, amountMinor: 5_000n }, "twice", testPoster),
    ),
  ]);
  expect(results.every((x) => x.ok)).toBe(true);
  expect(await walletOf(t.pool, q.customerId)).toEqual({ balance: 45_000n, entriesSum: 45_000n });
});

it("a refund is refused above the payment, for a payment that was not credited, or for money already spent", async () => {
  const a = await actorOf();
  const p = await credited(50_000n);
  expect(
    await asAdmin(a, (r) =>
      r.payments.recordManualRefund(
        { paymentId: p.id, amountMinor: 50_001n },
        "too much",
        testPoster,
      ),
    ),
  ).toEqual({ ok: false, error: "validation" });
  for (const bad of [0n, -1n, 1.5, 100, 9223372036854775808n]) {
    expect(
      await asAdmin(a, (r) =>
        r.payments.recordManualRefund(
          { paymentId: p.id, amountMinor: bad as bigint },
          "x",
          testPoster,
        ),
      ),
      String(bad),
    ).toEqual({ ok: false, error: "validation" });
  }
  const customerId = await newCustomer(t.pool);
  const open = await newPayment(t.pool, customerId, { status: "review" });
  expect(
    await asAdmin(a, (r) =>
      r.payments.recordManualRefund({ paymentId: open.id, amountMinor: 100n }, "x", testPoster),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  // the poster refuses (for example the customer spent the money): nothing is written
  expect(
    await asAdmin(a, (r) =>
      r.payments.recordManualRefund(
        { paymentId: p.id, amountMinor: 1n },
        "x",
        refusingPoster("insufficient_balance"),
      ),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(
    await one(
      "select count(*)::int as n from ledger_transactions where kind = 'refund' and reference_id = $1",
      [open.id],
    ),
  ).toEqual({ n: 0 });
  expect(
    await asAdmin(a, (r) =>
      r.payments.recordManualRefund({ paymentId: uuidv7(), amountMinor: 1n }, "x", testPoster),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  expect(
    await asAdmin(a, (r) =>
      r.payments.recordManualRefund({ paymentId: p.id, amountMinor: 1n }, "x", undefined as never),
    ),
  ).toEqual({ ok: false, error: "validation" });
});

it("only finance records a refund", async () => {
  const p = await credited(5_000n);
  for (const role of ["support", "ops", "superadmin"] as const) {
    expect(
      await asAdmin(await actorOf(role), (r) =>
        r.payments.recordManualRefund({ paymentId: p.id, amountMinor: 100n }, "x", testPoster),
      ),
      role,
    ).toEqual({ ok: false, error: "forbidden" });
  }
  expect(
    await one(
      "select count(*)::int as n from ledger_transactions where kind = 'refund' and reference_id = $1",
      [p.id],
    ),
  ).toEqual({ n: 0 });
});

it("the discrepancies queue lists open payment discrepancies; resolving one is audited and a replay the second time", async () => {
  const finance = await actorOf();
  const ops = await actorOf("ops");
  const customerId = await newCustomer(t.pool);
  const p = await newPayment(t.pool, customerId, { status: "review" });
  const id = await insertRow(t.pool, "discrepancies", {
    kind: "payment",
    details: {
      paymentId: p.id,
      reason: "amount_mismatch",
      expectedMinor: "10000",
      gotMinor: "9000",
      state: "review",
      name: "Secret Person",
    },
  });
  const orphan = await insertRow(t.pool, "discrepancies", {
    kind: "orphan",
    details: { resourceName: "tc-x" },
  });
  for (const actor of [finance, ops]) {
    const list = await asAdmin(actor, (r) =>
      r.payments.discrepancies({ kind: "payment", status: "open" }),
    );
    expect(list.ok && list.value.map((d) => d.id)).toContain(id);
    expect(list.ok && list.value.map((d) => d.id)).not.toContain(orphan);
    expect(JSON.stringify(list, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(
      "Secret Person",
    );
  }
  const out = await asAdmin(ops, (r) =>
    r.payments.resolveDiscrepancy({ id }, "customer paid the difference by bank"),
  );
  expect(out).toMatchObject({ ok: true, replayed: false, value: { id, status: "resolved" } });
  expect((await one("select status from discrepancies where id = $1", [id])).status).toBe(
    "resolved",
  );
  const audit = (await auditRowsOf(t.pool, ops.adminId)).filter(
    (x) => x.action === "discrepancy.resolve",
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ target_type: "discrepancy", target_id: id, ip: "203.0.113.9" });
  expect(
    await asAdmin(finance, (r) => r.payments.resolveDiscrepancy({ id }, "again")),
  ).toMatchObject({ ok: true, replayed: true });
  const open = await asAdmin(finance, (r) =>
    r.payments.discrepancies({ kind: "payment", status: "open" }),
  );
  expect(open.ok && open.value.map((d) => d.id)).not.toContain(id);
  expect(
    await asAdmin(finance, (r) => r.payments.resolveDiscrepancy({ id: uuidv7() }, "x")),
  ).toEqual({ ok: false, error: "not_found" });
  expect(await asAdmin(finance, (r) => r.payments.resolveDiscrepancy({ id: "nope" }, "x"))).toEqual(
    { ok: false, error: "validation" },
  );
  expect(await asAdmin(finance, (r) => r.payments.resolveDiscrepancy({ id: orphan }, ""))).toEqual({
    ok: false,
    error: "validation",
  });
  const support = await actorOf("support");
  expect(await asAdmin(support, (r) => r.payments.resolveDiscrepancy({ id: orphan }, "x"))).toEqual(
    { ok: false, error: "forbidden" },
  );
  expect(await asAdmin(support, (r) => r.payments.discrepancies({}))).toEqual({
    ok: false,
    error: "forbidden",
  });
});
