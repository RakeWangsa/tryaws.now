import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import type { LedgerPoster } from "../repositories/admin/ledger-port";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import {
  fundedWallet,
  refusingPoster,
  setAdjustmentLimit,
  testPoster,
  walletOf,
} from "./admin-money-support";
import { newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// 16.12 /wallets/[customerId]: the ledger read-only, and an adjustment that posts at once up to the
// limit and waits for a second admin above it (9.1). Every write has its audit row (R10); a repeated
// request is a replay (R7); the ledger stays balanced (R5).
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

const credit = (customerId: string, amountMinor: bigint, over: Record<string, unknown> = {}) => ({
  requestId: uuidv7(),
  at: new Date(),
  customerId,
  direction: "credit" as const,
  amountMinor,
  kind: "deposit" as const,
  ...over,
});

it("detail shows the balance, the ledger lines with the running balance and the pending adjustments", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 100_000n);
  await setAdjustmentLimit(t.pool, "50000");
  const small = credit(w.customerId, 20_000n);
  await asAdmin(a, (r) => r.wallets.createAdjustment(small, "bank deposit slip 1", testPoster));
  const big = credit(w.customerId, 90_000n);
  await asAdmin(a, (r) => r.wallets.createAdjustment(big, "bank deposit slip 2", testPoster));
  const out = await asAdmin(a, (r) => r.wallets.detail(w.customerId));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value).toMatchObject({
    customerId: w.customerId,
    currency: "BDT",
    balanceMinor: 120_000n,
    ledgerSumMinor: 120_000n,
    consistent: true,
    limitMinor: 50_000n,
  });
  // newest first, the running balance counts the whole history
  expect(
    out.value.lines.map((l) => [l.kind, l.direction, l.amountMinor, l.balanceAfterMinor]),
  ).toEqual([
    ["adjustment", "credit", 20_000n, 120_000n],
    ["topup", "credit", 100_000n, 100_000n],
  ]);
  expect(out.value.pending.map((p) => [p.id, p.amountMinor, p.status])).toEqual([
    [big.requestId, 90_000n, "pending"],
  ]);
  expect(out.value.decided.map((p) => [p.id, p.status])).toEqual([[small.requestId, "approved"]]);
});

it("detail pages the lines and refuses a malformed cursor with an empty page", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 1_000n);
  await setAdjustmentLimit(t.pool, "1000000");
  for (let i = 0; i < 3; i += 1) {
    await asAdmin(a, (r) =>
      r.wallets.createAdjustment(credit(w.customerId, 100n), "top", testPoster),
    );
  }
  const first = await asAdmin(a, (r) => r.wallets.detail(w.customerId, { limit: 2 }));
  expect(first.ok && first.value.lines).toHaveLength(2);
  const cursor = first.ok ? first.value.nextCursor : null;
  expect(cursor).not.toBeNull();
  const next = await asAdmin(a, (r) =>
    r.wallets.detail(w.customerId, { limit: 2, cursor: cursor! }),
  );
  expect(next.ok && next.value.lines).toHaveLength(2);
  expect(next.ok && next.value.lines[0]?.entryId).not.toBe(
    first.ok && first.value.lines[1]?.entryId,
  );
  const bad = await asAdmin(a, (r) => r.wallets.detail(w.customerId, { cursor: "nope" }));
  expect(bad.ok && bad.value.lines).toEqual([]);
  expect(await asAdmin(a, (r) => r.wallets.detail(w.customerId, { limit: 0 }))).toEqual({
    ok: false,
    error: "validation",
  });
});

it("detail of an unknown, malformed or wallet-less customer is not_found; only finance and superadmin read", async () => {
  const a = await actorOf();
  expect(await asAdmin(a, (r) => r.wallets.detail(uuidv7()))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await asAdmin(a, (r) => r.wallets.detail("nope"))).toEqual({
    ok: false,
    error: "not_found",
  });
  const w = await fundedWallet(t.pool, 0n);
  for (const role of ["support", "ops"] as const) {
    expect(await asAdmin(await actorOf(role), (r) => r.wallets.detail(w.customerId))).toEqual({
      ok: false,
      error: "forbidden",
    });
  }
  expect(
    (await asAdmin(await actorOf("superadmin"), (r) => r.wallets.detail(w.customerId))).ok,
  ).toBe(true);
});

it("an adjustment up to the limit posts at once, with the audit row of actor, reason, IP and target", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 10_000n);
  await setAdjustmentLimit(t.pool, 50_000);
  const input = credit(w.customerId, 50_000n, { kind: "goodwill", evidenceRef: "ticket 42" });
  const out = await asAdmin(a, (r) =>
    r.wallets.createAdjustment(input, "  goodwill for an outage  ", testPoster),
  );
  expect(out).toMatchObject({
    ok: true,
    replayed: false,
    value: { id: input.requestId, status: "approved" },
  });
  const row = await one("select * from wallet_adjustments where id = $1", [input.requestId]);
  expect(row).toMatchObject({
    customer_id: w.customerId,
    direction: "credit",
    amount_minor: "50000",
    kind: "goodwill",
    reason: "goodwill for an outage",
    evidence_ref: "ticket 42",
    requested_by: a.adminId,
    approved_by: null,
    status: "approved",
  });
  expect(row.ledger_transaction_id).not.toBeNull();
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 60_000n, entriesSum: 60_000n });
  const tx = await one(
    "select kind, reference_type, reference_id, idempotency_key, actor_type, actor_id, memo from ledger_transactions where id = $1",
    [row.ledger_transaction_id],
  );
  expect(tx).toEqual({
    kind: "adjustment",
    reference_type: "wallet_adjustment",
    reference_id: input.requestId,
    idempotency_key: `adjustment:${input.requestId}`,
    actor_type: "admin",
    actor_id: a.adminId,
    memo: "goodwill for an outage",
  });
  const audit = (await auditRowsOf(t.pool, a.adminId)).filter(
    (x) => x.action === "wallet.adjustment.create",
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_type: "admin",
    target_type: "wallet_adjustment",
    target_id: input.requestId,
    ip: "203.0.113.9",
    user_agent: "test",
  });
  expect(audit[0]?.metadata).toMatchObject({ reason: "goodwill for an outage" });
});

it("a debit posts the wallet as debit and the adjustments account as credit", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 30_000n);
  await setAdjustmentLimit(t.pool, "100000");
  const input = credit(w.customerId, 12_000n, { direction: "debit", kind: "correction" });
  const out = await asAdmin(a, (r) =>
    r.wallets.createAdjustment(input, "double top-up removed", testPoster),
  );
  expect(out.ok).toBe(true);
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 18_000n, entriesSum: 18_000n });
  const lines = (
    await t.pool.query(
      `select a.type, e.direction, e.amount_minor::text as amount from ledger_entries e
         join ledger_accounts a on a.id = e.account_id
         join ledger_transactions x on x.id = e.transaction_id
        where x.reference_id = $1 order by e.id`,
      [input.requestId],
    )
  ).rows;
  expect(lines).toEqual([
    { type: "customer_wallet", direction: "debit", amount: "12000" },
    { type: "adjustments", direction: "credit", amount: "12000" },
  ]);
});

it("above the limit it waits as pending: no ledger line, no change of the wallet", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 10_000n);
  await setAdjustmentLimit(t.pool, "50000");
  const input = credit(w.customerId, 50_001n);
  const out = await asAdmin(a, (r) =>
    r.wallets.createAdjustment(input, "large deposit", testPoster),
  );
  expect(out).toMatchObject({ ok: true, replayed: false, value: { status: "pending" } });
  const row = await one(
    "select status, approved_by, ledger_transaction_id from wallet_adjustments where id = $1",
    [input.requestId],
  );
  expect(row).toEqual({ status: "pending", approved_by: null, ledger_transaction_id: null });
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 10_000n, entriesSum: 10_000n });
  expect(
    await one("select count(*)::int as n from ledger_transactions where reference_id = $1", [
      input.requestId,
    ]),
  ).toEqual({ n: 0 });
});

it("without a limit (or a limit that is not a whole number) every adjustment waits (fail closed)", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await t.pool.query("delete from settings where key = 'wallet.adjustment_limit_minor'");
  const first = credit(w.customerId, 1n);
  expect(
    await asAdmin(a, (r) => r.wallets.createAdjustment(first, "one paisa", testPoster)),
  ).toMatchObject({ ok: true, value: { status: "pending" } });
  for (const bad of ["12.5", "-1", "abc", 5.5]) {
    await setAdjustmentLimit(t.pool, bad);
    const input = credit(w.customerId, 1n);
    const out = await asAdmin(a, (r) => r.wallets.createAdjustment(input, "one paisa", testPoster));
    expect(out, String(bad)).toMatchObject({ ok: true, value: { status: "pending" } });
  }
  await t.pool.query("delete from settings where key = 'wallet.adjustment_limit_minor'");
});

it("a second finance admin approves: the posting is made, the approver is stored, two audit rows exist", async () => {
  const requester = await actorOf();
  const approver = await actorOf("finance");
  const w = await fundedWallet(t.pool, 5_000n);
  await setAdjustmentLimit(t.pool, "100");
  const input = credit(w.customerId, 70_000n);
  await asAdmin(requester, (r) =>
    r.wallets.createAdjustment(input, "bank transfer, slip 77", testPoster),
  );
  const out = await asAdmin(approver, (r) =>
    r.wallets.approveAdjustment({ id: input.requestId }, "slip checked", testPoster),
  );
  expect(out).toMatchObject({
    ok: true,
    replayed: false,
    value: { id: input.requestId, status: "approved" },
  });
  const row = await one(
    "select status, approved_by, requested_by, ledger_transaction_id from wallet_adjustments where id = $1",
    [input.requestId],
  );
  expect(row).toMatchObject({
    status: "approved",
    approved_by: approver.adminId,
    requested_by: requester.adminId,
  });
  expect(row.ledger_transaction_id).not.toBeNull();
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 75_000n, entriesSum: 75_000n });
  const audit = (await auditRowsOf(t.pool, approver.adminId)).filter(
    (x) => x.action === "wallet.adjustment.approve",
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    target_type: "wallet_adjustment",
    target_id: input.requestId,
    ip: "203.0.113.9",
  });
  expect(audit[0]?.metadata).toMatchObject({ reason: "slip checked" });
  // a superadmin may approve too
  const second = credit(w.customerId, 70_000n);
  await asAdmin(requester, (r) => r.wallets.createAdjustment(second, "another slip", testPoster));
  const boss = await actorOf("superadmin");
  expect(
    (
      await asAdmin(boss, (r) =>
        r.wallets.approveAdjustment({ id: second.requestId }, "ok", testPoster),
      )
    ).ok,
  ).toBe(true);
});

it("the requester cannot approve or reject their own adjustment (forbidden, nothing written)", async () => {
  const requester = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "100");
  const input = credit(w.customerId, 5_000n);
  await asAdmin(requester, (r) =>
    r.wallets.createAdjustment(input, "needs a second admin", testPoster),
  );
  const before = (await auditRowsOf(t.pool, requester.adminId)).length;
  for (const act of [
    (r: AdminRepos) => r.wallets.approveAdjustment({ id: input.requestId }, "self", testPoster),
    (r: AdminRepos) => r.wallets.rejectAdjustment({ id: input.requestId }, "self"),
  ]) {
    expect(await asAdmin(requester, act)).toEqual({ ok: false, error: "forbidden" });
  }
  expect((await auditRowsOf(t.pool, requester.adminId)).length).toBe(before);
  expect(
    (await one("select status from wallet_adjustments where id = $1", [input.requestId])).status,
  ).toBe("pending");
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 0n, entriesSum: 0n });
});

it("a reject keeps the wallet as it is; approve after reject is a conflict; a repeated reject is a replay", async () => {
  const requester = await actorOf();
  const other = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "100");
  const input = credit(w.customerId, 5_000n);
  await asAdmin(requester, (r) =>
    r.wallets.createAdjustment(input, "doubtful deposit", testPoster),
  );
  const rejected = await asAdmin(other, (r) =>
    r.wallets.rejectAdjustment({ id: input.requestId }, "no slip found"),
  );
  expect(rejected).toMatchObject({ ok: true, replayed: false, value: { status: "rejected" } });
  expect(
    await asAdmin(other, (r) =>
      r.wallets.rejectAdjustment({ id: input.requestId }, "no slip found"),
    ),
  ).toMatchObject({ ok: true, replayed: true });
  expect(
    await asAdmin(other, (r) =>
      r.wallets.approveAdjustment({ id: input.requestId }, "changed my mind", testPoster),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 0n, entriesSum: 0n });
  expect(
    await one("select count(*)::int as n from ledger_transactions where reference_id = $1", [
      input.requestId,
    ]),
  ).toEqual({ n: 0 });
});

it("a double submit is a replay: one row, one ledger transaction, the wallet moves once (R7)", async () => {
  const a = await actorOf();
  const approver = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "10000");
  const input = credit(w.customerId, 4_000n);
  const first = await asAdmin(a, (r) => r.wallets.createAdjustment(input, "slip 1", testPoster));
  const again = await asAdmin(a, (r) => r.wallets.createAdjustment(input, "slip 1", testPoster));
  expect(first).toMatchObject({ ok: true, replayed: false });
  expect(again).toMatchObject({ ok: true, replayed: true });
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 4_000n, entriesSum: 4_000n });
  expect(
    await one("select count(*)::int as n from wallet_adjustments where id = $1", [input.requestId]),
  ).toEqual({ n: 1 });
  // the same request id with other content is refused, not merged
  expect(
    await asAdmin(a, (r) =>
      r.wallets.createAdjustment({ ...input, amountMinor: 5_000n }, "slip 1", testPoster),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(
    await asAdmin(await actorOf(), (r) => r.wallets.createAdjustment(input, "slip 1", testPoster)),
  ).toEqual({ ok: false, error: "conflict" });
  // a pending one approved twice
  const big = credit(w.customerId, 20_000n);
  await asAdmin(a, (r) => r.wallets.createAdjustment(big, "big slip", testPoster));
  const approved = await asAdmin(approver, (r) =>
    r.wallets.approveAdjustment({ id: big.requestId }, "ok", testPoster),
  );
  const approvedAgain = await asAdmin(approver, (r) =>
    r.wallets.approveAdjustment({ id: big.requestId }, "ok", testPoster),
  );
  expect(approved).toMatchObject({ ok: true, replayed: false });
  expect(approvedAgain).toMatchObject({ ok: true, replayed: true });
  // approved by someone else afterwards: the first approval stands
  expect(
    await asAdmin(await actorOf(), (r) =>
      r.wallets.approveAdjustment({ id: big.requestId }, "ok", testPoster),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 24_000n, entriesSum: 24_000n });
});

it("two overlapping creations of the same request post once", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "10000");
  const input = credit(w.customerId, 1_500n);
  const results = await Promise.all([
    asAdmin(a, (r) => r.wallets.createAdjustment(input, "twice", testPoster)),
    asAdmin(a, (r) => r.wallets.createAdjustment(input, "twice", testPoster)),
  ]);
  expect(results.map((x) => x.ok)).toEqual([true, true]);
  expect(results.filter((x) => x.ok && x.replayed)).toHaveLength(1);
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 1_500n, entriesSum: 1_500n });
});

it("a debit that the wallet cannot cover writes nothing: refused at creation, left pending at approval", async () => {
  const a = await actorOf();
  const approver = await actorOf();
  const w = await fundedWallet(t.pool, 1_000n);
  await setAdjustmentLimit(t.pool, "5000");
  const now = credit(w.customerId, 2_000n, { direction: "debit", kind: "correction" });
  expect(await asAdmin(a, (r) => r.wallets.createAdjustment(now, "too much", testPoster))).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(
    await one("select count(*)::int as n from wallet_adjustments where id = $1", [now.requestId]),
  ).toEqual({ n: 1 - 1 });
  const waiting = credit(w.customerId, 9_000n, { direction: "debit", kind: "correction" });
  await asAdmin(a, (r) => r.wallets.createAdjustment(waiting, "large correction", testPoster));
  expect(
    await asAdmin(approver, (r) =>
      r.wallets.approveAdjustment({ id: waiting.requestId }, "ok", testPoster),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  expect(
    (await one("select status from wallet_adjustments where id = $1", [waiting.requestId])).status,
  ).toBe("pending");
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 1_000n, entriesSum: 1_000n });
});

it("a poster that refuses leaves no row and no audit row (fail closed)", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "5000");
  const input = credit(w.customerId, 100n);
  const before = (await auditRowsOf(t.pool, a.adminId)).length;
  const refused: LedgerPoster = refusingPoster("internal");
  expect(await asAdmin(a, (r) => r.wallets.createAdjustment(input, "x", refused))).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(
    await one("select count(*)::int as n from wallet_adjustments where id = $1", [input.requestId]),
  ).toEqual({ n: 0 });
  expect((await auditRowsOf(t.pool, a.adminId)).length).toBe(before);
});

// WPU-X5 (owner decision 2026-11-14): a superadmin creates too, so only support and ops are refused here.
it("only finance and superadmin create; support and ops are refused before any query", async () => {
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "5000");
  for (const role of ["support", "ops"] as const) {
    const actor = await actorOf(role);
    const input = credit(w.customerId, 100n);
    expect(
      await asAdmin(actor, (r) => r.wallets.createAdjustment(input, "x", testPoster)),
      role,
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await one("select count(*)::int as n from wallet_adjustments where id = $1", [
        input.requestId,
      ]),
    ).toEqual({ n: 0 });
  }
  const pending = credit(w.customerId, 9_000n);
  await asAdmin(await actorOf(), (r) => r.wallets.createAdjustment(pending, "waits", testPoster));
  for (const role of ["support", "ops"] as const) {
    const actor = await actorOf(role);
    expect(
      await asAdmin(actor, (r) =>
        r.wallets.approveAdjustment({ id: pending.requestId }, "x", testPoster),
      ),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await asAdmin(actor, (r) => r.wallets.rejectAdjustment({ id: pending.requestId }, "x")),
    ).toEqual({ ok: false, error: "forbidden" });
  }
});

it("refuses a malformed request with 'validation' and writes nothing", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "5000");
  const good = credit(w.customerId, 100n);
  const cases: [string, unknown, string][] = [
    ["zero", { ...good, amountMinor: 0n }, "reason"],
    ["negative", { ...good, amountMinor: -5n }, "reason"],
    ["a float", { ...good, amountMinor: 1.5 }, "reason"],
    ["a number", { ...good, amountMinor: 100 }, "reason"],
    ["past bigint", { ...good, amountMinor: 9223372036854775808n }, "reason"],
    ["direction", { ...good, direction: "sideways" }, "reason"],
    ["kind", { ...good, kind: "gift" }, "reason"],
    ["customer id", { ...good, customerId: "nope" }, "reason"],
    ["request id", { ...good, requestId: "nope" }, "reason"],
    ["evidence", { ...good, evidenceRef: "x".repeat(201) }, "reason"],
    ["a blank reason", good, "   "],
    ["a long reason", good, "x".repeat(501)],
  ];
  for (const [name, input, reason] of cases) {
    expect(
      await asAdmin(a, (r) => r.wallets.createAdjustment(input as never, reason, testPoster)),
      name,
    ).toEqual({ ok: false, error: "validation" });
  }
  expect(
    await one("select count(*)::int as n from wallet_adjustments where customer_id = $1", [
      w.customerId,
    ]),
  ).toEqual({ n: 0 });
  expect(
    await asAdmin(a, (r) =>
      r.wallets.createAdjustment(credit(uuidv7(), 100n), "no such customer", testPoster),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  expect(
    await asAdmin(a, (r) => r.wallets.approveAdjustment({ id: "nope" }, "x", testPoster)),
  ).toEqual({ ok: false, error: "validation" });
  expect(
    await asAdmin(a, (r) => r.wallets.approveAdjustment({ id: uuidv7() }, "x", testPoster)),
  ).toEqual({ ok: false, error: "not_found" });
});

it("the ledger stays balanced and the cache equals the sum of the lines after a mixed run", async () => {
  const a = await actorOf();
  const b = await actorOf();
  const w = await fundedWallet(t.pool, 50_000n);
  await setAdjustmentLimit(t.pool, "20000");
  const steps = [
    credit(w.customerId, 7_000n),
    credit(w.customerId, 9_000n, { direction: "debit", kind: "correction" }),
    credit(w.customerId, 30_000n),
    credit(w.customerId, 25_000n, { direction: "debit", kind: "correction" }),
  ];
  for (const s of steps)
    await asAdmin(a, (r) => r.wallets.createAdjustment(s, "mixed run", testPoster));
  await asAdmin(b, (r) =>
    r.wallets.approveAdjustment({ id: steps[2]!.requestId }, "ok", testPoster),
  );
  await asAdmin(b, (r) => r.wallets.rejectAdjustment({ id: steps[3]!.requestId }, "no"));
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 78_000n, entriesSum: 78_000n });
  const unbalanced = await t.pool.query(
    `select transaction_id from ledger_entries group by transaction_id
      having sum(case direction when 'debit' then amount_minor else -amount_minor end) <> 0`,
  );
  expect(unbalanced.rows).toEqual([]);
});

it("small adjustments that pass one by one but together exceed the limit: the one that crosses waits", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 10_000n);
  await setAdjustmentLimit(t.pool, "10000");
  const steps = [
    credit(w.customerId, 4_000n),
    credit(w.customerId, 4_000n, { direction: "debit", kind: "correction" }),
    credit(w.customerId, 4_000n),
  ];
  const out = [];
  for (const [i, s] of steps.entries()) {
    out.push(await asAdmin(a, (r) => r.wallets.createAdjustment(s, `part ${i}`, testPoster)));
  }
  expect(out.map((x) => (x.ok ? x.value.status : "refused"))).toEqual([
    "approved",
    "approved",
    "pending",
  ]);
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 10_000n, entriesSum: 10_000n });
  // the same admin cannot approve their own pending one; a second one can
  expect(
    await asAdmin(a, (r) =>
      r.wallets.approveAdjustment({ id: steps[2]!.requestId }, "me", testPoster),
    ),
  ).toEqual({ ok: false, error: "forbidden" });
  const other = await actorOf();
  expect(
    (
      await asAdmin(other, (r) =>
        r.wallets.approveAdjustment({ id: steps[2]!.requestId }, "ok", testPoster),
      )
    ).ok,
  ).toBe(true);
  // a replay of the crossing request is a replay, not a second posting
  expect(
    await asAdmin(a, (r) => r.wallets.createAdjustment(steps[2]!, "part 2", testPoster)),
  ).toMatchObject({ ok: true, replayed: true });
  expect(await walletOf(t.pool, w.customerId)).toEqual({ balance: 14_000n, entriesSum: 14_000n });
});

it("two concurrent requests cannot both pass under the limit", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "10000");
  const results = await Promise.all(
    [6_000n, 6_000n].map((n) =>
      asAdmin(a, (r) => r.wallets.createAdjustment(credit(w.customerId, n), "race", testPoster)),
    ),
  );
  expect(results.map((x) => (x.ok ? x.value.status : "refused")).sort()).toEqual([
    "approved",
    "pending",
  ]);
});

it("adjustments outside the window do not count; a bad clock is refused", async () => {
  const a = await actorOf();
  const w = await fundedWallet(t.pool, 0n);
  await setAdjustmentLimit(t.pool, "10000");
  await asAdmin(a, (r) =>
    r.wallets.createAdjustment(credit(w.customerId, 9_000n), "old", testPoster),
  );
  const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
  expect(
    await asAdmin(a, (r) =>
      r.wallets.createAdjustment(credit(w.customerId, 9_000n, { at: later }), "new", testPoster),
    ),
  ).toMatchObject({ ok: true, value: { status: "approved" } });
  expect(
    await asAdmin(a, (r) =>
      r.wallets.createAdjustment(credit(w.customerId, 1n, { at: "x" }), "bad", testPoster),
    ),
  ).toEqual({ ok: false, error: "validation" });
});
