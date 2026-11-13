// WPU-M4: the credit of WPU-M3 goes through four eyes (the limit and the split window of the adjustments,
// 9.1) and closes the failed apply operation in the same transaction. Real database, roles web/worker/admin.
import { createHash } from "node:crypto";
import { adminRepos, type AdminActor } from "@tc/db";
import { auditRowsOf, insertRow, newAdmin, runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { postTransaction } from "../ledger/post";
import { reverseTransaction } from "../ledger/reverse";
import { isFinal } from "../operations/states";
import { transitionOperation } from "../operations/transition";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { renewNow } from "./renew-now";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
const AT = new Date("2026-11-12T00:00:00.000Z");
let kit: Kit;

const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const asWeb = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "web_rw" });
const actorOf = async (role: AdminActor["role"] = "finance"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const asAdmin = <T>(actor: AdminActor, fn: (r: ReturnType<typeof adminRepos>) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });

// The limit of the market up to which a credit posts at once (the one of the adjustments, 9.1).
const setLimit = (minor: bigint) =>
  t.pool.query(
    `insert into settings (id, key, market, scope, scope_id, value)
     values (gen_random_uuid(), 'wallet.adjustment_limit_minor', 'BD', 'market', null, $1::jsonb)
     on conflict (key, market, scope, scope_id) do update set value = excluded.value`,
    [JSON.stringify(minor.toString())],
  );

interface Case {
  customerId: string;
  resourceId: string;
  subscriptionId: string;
  operationId: string;
  chargedMinor: bigint;
  chargeId: string;
}

/** A paid container service whose renewal was charged and whose apply then ended in needs_attention. */
async function charged(state = "needs_attention"): Promise<Case> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  const sub = (
    await q("select id, period_end from subscriptions where resource_id = $1", [resourceId])
  )[0]!;
  const end = sub.period_end as Date;
  await q("update resources set state = 'active', family = 'container_service' where id = $1", [
    resourceId,
  ]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  kit.clock.set(new Date(end.getTime() - DAY));
  const before = await kit.balance(buyer.customerId);
  const renewed = await asWeb((tx) =>
    renewNow(tx, { customerId: buyer.customerId, resourceId, clock: kit.clock }),
  );
  expect(renewed.ok).toBe(true);
  const chargedMinor = before - (await kit.balance(buyer.customerId));
  const productId = crypto.randomUUID();
  const operationId = await insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "scale_container",
    state,
    idempotency_key: `lifecycle:plan-change:${String(sub.id)}:${end.toISOString()}`,
    payload: JSON.stringify({
      subscriptionId: String(sub.id),
      productId,
      periodEnd: end.toISOString(),
    }),
  });
  await q(`update resources set config = config || $2::jsonb where id = $1`, [
    resourceId,
    JSON.stringify({
      pendingPlan: { productId },
      pendingPlanFailed: { code: "conflict", productId, period: null },
    }),
  ]);
  const chargeId = String(
    (
      await q("select id from ledger_transactions where idempotency_key = $1", [
        `renew:${String(sub.id)}:${end.toISOString()}`,
      ])
    )[0]!.id,
  );
  return {
    customerId: buyer.customerId,
    resourceId,
    subscriptionId: String(sub.id),
    operationId,
    chargedMinor,
    chargeId,
  };
}

const reversalsOf = async (chargeId: string) =>
  q("select id from ledger_transactions where kind = 'reversal' and reference_id = $1", [chargeId]);
const unbalanced = async () =>
  q(
    `select transaction_id from ledger_entries group by transaction_id
      having sum(case direction when 'debit' then amount_minor else -amount_minor end) <> 0`,
  );

beforeAll(async () => {
  kit = await makeKit(t, {
    balanceMinor: 50_000_000n,
    vcpuLimit: 4000,
    ipLimit: 4000,
    keepFxFresh: true,
  });
});

describe("creditWalletForFailedChange: four eyes and the closed operation (WPU-M4)", () => {
  const finance = () => actorOf("finance");
  const create = (a: AdminActor, operationId: string, reason = "ops rejected the apply") =>
    asAdmin(a, (r) =>
      r.wallets.creditWalletForFailedChange({ at: AT, operationId }, reason, reverseTransaction),
    );
  const approve = (a: AdminActor, id: string, reason = "second pair of eyes") =>
    asAdmin(a, (r) =>
      r.wallets.approveAdjustment({ id, at: AT }, reason, postTransaction, reverseTransaction),
    );
  const opState = async (id: string) =>
    String((await q("select state from operations where id = $1", [id]))[0]!.state);
  const adjustmentOf = async (operationId: string) =>
    (
      await q("select * from wallet_adjustments where evidence_ref = $1", [
        `plan_credit:${operationId}`,
      ])
    )[0];
  const adjustmentIdOf = (made: { ok: boolean; value?: unknown }) =>
    made.ok ? (made.value as { adjustmentId: string }).adjustmentId : "";
  const told = (customerId: string) =>
    q(
      "select channel from notifications where customer_id = $1 and template = 'wallet_credited_plan_change'",
      [customerId],
    );

  it("above the limit it waits as pending: nothing posted, the operation untouched, a repeat is a replay", async () => {
    const c = await charged();
    await setLimit(c.chargedMinor - 1n);
    const a = await finance();
    const wallet = await kit.balance(c.customerId);
    const first = await create(a, c.operationId);
    expect(first).toMatchObject({ ok: true, replayed: false, value: { status: "pending" } });
    expect(await kit.balance(c.customerId)).toBe(wallet);
    expect(await reversalsOf(c.chargeId)).toHaveLength(0);
    expect(await opState(c.operationId)).toBe("needs_attention");
    const row = (await adjustmentOf(c.operationId))!;
    expect(row).toMatchObject({
      customer_id: c.customerId,
      direction: "credit",
      status: "pending",
      requested_by: a.adminId,
      approved_by: null,
      ledger_transaction_id: null,
    });
    expect(BigInt(row.amount_minor as string)).toBe(c.chargedMinor);
    // R7: the same admin, another admin, two at once: one pending row for the operation
    expect(await create(a, c.operationId)).toMatchObject({ ok: true, replayed: true });
    expect(await create(await actorOf("superadmin"), c.operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { status: "pending" },
    });
    await Promise.all([create(a, c.operationId), create(await finance(), c.operationId)]);
    expect(
      await q("select 1 from wallet_adjustments where evidence_ref = $1", [
        `plan_credit:${c.operationId}`,
      ]),
    ).toHaveLength(1);
    // the customer is not told before the money moved
    expect(await told(c.customerId)).toHaveLength(0);
  });

  it("a second admin approves: the wallet rises by exactly the charge, the operation is closed in the same step", async () => {
    const c = await charged();
    await setLimit(c.chargedMinor - 1n);
    const requester = await finance();
    const id = adjustmentIdOf(await create(requester, c.operationId));
    const wallet = await kit.balance(c.customerId);

    // the requester cannot approve their own credit
    expect(await approve(requester, id)).toEqual({ ok: false, error: "forbidden" });
    expect(await kit.balance(c.customerId)).toBe(wallet);
    expect(await opState(c.operationId)).toBe("needs_attention");

    const second = await actorOf("superadmin");
    const done = await approve(second, id);
    expect(done).toMatchObject({ ok: true, replayed: false, value: { status: "approved" } });
    expect(await kit.balance(c.customerId)).toBe(wallet + c.chargedMinor);
    expect(await reversalsOf(c.chargeId)).toHaveLength(1);
    expect(await unbalanced()).toEqual([]);
    expect(await opState(c.operationId)).toBe("failed");
    const row = (await adjustmentOf(c.operationId))!;
    expect(row).toMatchObject({ status: "approved", approved_by: second.adminId });
    expect(row.ledger_transaction_id).toBe((await reversalsOf(c.chargeId))[0]!.id);
    // the customer is told once; the pending plan is cleared through the audited admin operation
    expect(await told(c.customerId)).toHaveLength(2);
    const clear = await q(
      "select state, payload from operations where resource_id = $1 and kind = 'clear_plan_change_mark'",
      [c.resourceId],
    );
    expect(clear).toHaveLength(1);
    expect(clear[0]!.state).toBe("queued");
    expect(clear[0]!.payload).toMatchObject({ clearPendingPlan: true });
    // R10: the approval has its audit row
    expect(await auditRowsOf(t.pool, second.adminId)).toHaveLength(1);

    // the same approval again is a replay; another admin's approval of an approved credit is a conflict
    expect(await approve(second, id)).toMatchObject({ ok: true, replayed: true });
    expect(await approve(await actorOf("finance"), id)).toEqual({ ok: false, error: "conflict" });
    expect(await kit.balance(c.customerId)).toBe(wallet + c.chargedMinor);
    expect(await reversalsOf(c.chargeId)).toHaveLength(1);
  });

  it("at or below the limit it posts at once and closes the operation; a repeat is a replay", async () => {
    const c = await charged();
    await setLimit(c.chargedMinor);
    const wallet = await kit.balance(c.customerId);
    const done = await create(await finance(), c.operationId);
    expect(done).toMatchObject({ ok: true, replayed: false, value: { status: "approved" } });
    expect(await kit.balance(c.customerId)).toBe(wallet + c.chargedMinor);
    expect(await opState(c.operationId)).toBe("failed");
    expect(await adjustmentOf(c.operationId)).toMatchObject({
      status: "approved",
      approved_by: null,
    });
    expect(await create(await finance(), c.operationId)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await reversalsOf(c.chargeId)).toHaveLength(1);
  });

  it("a credit that posted at once counts in the window: a later one of the same wallet that crosses the limit waits", async () => {
    const a = await charged();
    const f = await finance();
    await setLimit(a.chargedMinor + 1n);
    expect(await create(f, a.operationId)).toMatchObject({ value: { status: "approved" } });
    const manual = await asAdmin(f, (r) =>
      r.wallets.createAdjustment(
        {
          requestId: crypto.randomUUID(),
          at: AT,
          customerId: a.customerId,
          direction: "credit",
          amountMinor: 2n,
          kind: "goodwill",
        },
        "goodwill",
        postTransaction,
      ),
    );
    expect(manual).toMatchObject({ ok: true, value: { status: "pending" } });
  });

  it("a closed operation can never run again: no claim, no retry, no sweep", async () => {
    const c = await charged();
    await setLimit(c.chargedMinor);
    await create(await finance(), c.operationId);
    expect(await opState(c.operationId)).toBe("failed");
    const ops = await actorOf("ops");
    const retry = await asAdmin(ops, (r) =>
      r.operations.retry({ operationId: c.operationId, at: AT }, "again"),
    );
    expect(retry).toEqual({ ok: false, error: "conflict" });
    const reject = await asAdmin(ops, (r) =>
      r.operations.reject({ operationId: c.operationId, at: AT }, "no"),
    );
    expect(reject).toMatchObject({ ok: true, replayed: true });
    // a worker cannot take it: queued -> running does not apply to a failed operation
    const moved = await runTransaction(
      t.db,
      (tx) =>
        transitionOperation(tx, "worker", {
          id: c.operationId,
          from: "queued",
          to: "running",
          nextRunAt: AT,
        }),
      { role: "worker_rw" },
    );
    expect(moved.applied).toBe(false);
    expect(isFinal("failed")).toBe(true);
    expect(await opState(c.operationId)).toBe("failed");
  });

  it("refuses an operation that was retried and ran or succeeded after the request was made", async () => {
    const c = await charged();
    await setLimit(c.chargedMinor - 1n);
    const id = adjustmentIdOf(await create(await finance(), c.operationId));
    const wallet = await kit.balance(c.customerId);
    const second = await actorOf("superadmin");
    for (const state of ["queued", "running", "waiting", "succeeded"]) {
      await q("update operations set state = $2 where id = $1", [c.operationId, state]);
      expect(await approve(second, id)).toEqual({ ok: false, error: "conflict" });
      expect(await kit.balance(c.customerId)).toBe(wallet);
      expect(await opState(c.operationId)).toBe(state);
    }
    expect(await reversalsOf(c.chargeId)).toHaveLength(0);
    expect(await adjustmentOf(c.operationId)).toMatchObject({ status: "pending" });
  });

  it("cross-tenant: a pending credit cannot be redirected to another wallet; a rejected one stays rejected", async () => {
    const a = await charged();
    const b = await charged();
    await setLimit(a.chargedMinor - 1n);
    const id = adjustmentIdOf(await create(await finance(), a.operationId));
    await q("update wallet_adjustments set customer_id = $2 where id = $1", [id, b.customerId]);
    const walletA = await kit.balance(a.customerId);
    const walletB = await kit.balance(b.customerId);
    expect(await approve(await actorOf("superadmin"), id)).toEqual({
      ok: false,
      error: "conflict",
    });
    expect(await kit.balance(a.customerId)).toBe(walletA);
    expect(await kit.balance(b.customerId)).toBe(walletB);
    await q("update wallet_adjustments set customer_id = $2 where id = $1", [id, a.customerId]);
    // a rejection leaves the operation as it was and the credit cannot be asked for again
    const rejected = await asAdmin(await actorOf("superadmin"), (r) =>
      r.wallets.rejectAdjustment({ id }, "not this one"),
    );
    expect(rejected).toMatchObject({ ok: true, value: { status: "rejected" } });
    expect(await opState(a.operationId)).toBe("needs_attention");
    expect(await create(await finance(), a.operationId)).toEqual({ ok: false, error: "conflict" });
  });

  it("approval needs the reverser (fail closed), and a manual adjustment cannot take the plan credit marker", async () => {
    const c = await charged();
    await setLimit(c.chargedMinor - 1n);
    const id = adjustmentIdOf(await create(await finance(), c.operationId));
    const none = await asAdmin(await actorOf("superadmin"), (r) =>
      r.wallets.approveAdjustment({ id, at: AT }, "r", postTransaction),
    );
    expect(none).toEqual({ ok: false, error: "validation" });
    expect(await reversalsOf(c.chargeId)).toHaveLength(0);
    const manual = await asAdmin(await finance(), (r) =>
      r.wallets.createAdjustment(
        {
          requestId: crypto.randomUUID(),
          at: AT,
          customerId: c.customerId,
          direction: "credit",
          amountMinor: 100n,
          kind: "correction",
          evidenceRef: `plan_credit:${c.operationId}`,
        },
        "sneaky",
        postTransaction,
      ),
    );
    expect(manual).toEqual({ ok: false, error: "validation" });
  });
});

// WPU-M5: the id and the evidence of a plan credit are one reserved namespace. A row that squats on the
// id of the credit of an operation (made by hand, or by an old build) is never replayed or approved as it.
describe("plan credit identity: a squatting adjustment is refused (WPU-M5)", () => {
  // The derivation of packages/db (planCreditId); repeated here so the test does not trust the code it checks.
  const derived = (operationId: string): string => {
    const h = createHash("sha256").update(`plan_credit:${operationId}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const finance = () => actorOf("finance");
  const create = (a: AdminActor, operationId: string) =>
    asAdmin(a, (r) =>
      r.wallets.creditWalletForFailedChange({ at: AT, operationId }, "ops", reverseTransaction),
    );
  const approve = (a: AdminActor, id: string) =>
    asAdmin(a, (r) =>
      r.wallets.approveAdjustment({ id, at: AT }, "second", postTransaction, reverseTransaction),
    );
  const reject = (a: AdminActor, id: string) =>
    asAdmin(a, (r) => r.wallets.rejectAdjustment({ id }, "no"));
  const opState = async (id: string) =>
    String((await q("select state from operations where id = $1", [id]))[0]!.state);
  /** The row a squatter leaves: the derived id, anything else about it. */
  const squat = async (
    id: string,
    over: {
      customerId: string;
      direction?: string;
      amountMinor?: bigint;
      kind?: string;
      evidenceRef?: string | null;
      status?: string;
      ledgerTransactionId?: string | null;
      requestedBy: string;
    },
  ) =>
    q(
      `insert into wallet_adjustments (id, customer_id, direction, amount_minor, kind, reason, evidence_ref, requested_by, status, ledger_transaction_id)
       values ($1, $2, $3, $4::bigint, $5, 'squat', $6, $7, $8, $9)`,
      [
        id,
        over.customerId,
        over.direction ?? "credit",
        (over.amountMinor ?? 100n).toString(),
        over.kind ?? "goodwill",
        over.evidenceRef ?? null,
        over.requestedBy,
        over.status ?? "pending",
        over.ledgerTransactionId ?? null,
      ],
    );
  const untouched = async (c: Case, wallet: bigint, other?: { id: string; wallet: bigint }) => {
    expect(await kit.balance(c.customerId)).toBe(wallet);
    if (other) expect(await kit.balance(other.id)).toBe(other.wallet);
    expect(await reversalsOf(c.chargeId)).toHaveLength(0);
    expect(await unbalanced()).toEqual([]);
    expect(await opState(c.operationId)).toBe("needs_attention");
  };

  it("the generic form cannot take the id of a plan credit: refused, nothing written, nothing posted", async () => {
    const c = await charged();
    const other = await charged();
    await setLimit(1_000_000_000n);
    const a = await finance();
    const wallet = await kit.balance(other.customerId);
    const made = await asAdmin(a, (r) =>
      r.wallets.createAdjustment(
        {
          requestId: derived(c.operationId),
          at: AT,
          customerId: other.customerId,
          direction: "credit",
          amountMinor: 100n,
          kind: "goodwill",
        },
        "squat",
        postTransaction,
      ),
    );
    expect(made).toEqual({ ok: false, error: "validation" });
    expect(
      await q("select 1 from wallet_adjustments where id = $1", [derived(c.operationId)]),
    ).toHaveLength(0);
    expect(await kit.balance(other.customerId)).toBe(wallet);
    // an ordinary request id still works
    const fine = await asAdmin(a, (r) =>
      r.wallets.createAdjustment(
        {
          requestId: crypto.randomUUID(),
          at: AT,
          customerId: other.customerId,
          direction: "credit",
          amountMinor: 100n,
          kind: "goodwill",
        },
        "fine",
        postTransaction,
      ),
    );
    expect(fine).toMatchObject({ ok: true, value: { status: "approved" } });
  });

  it("a row that squats on the id (another customer, no marker) is not replayed: conflict, no ledger rows", async () => {
    const c = await charged();
    const other = await charged();
    await setLimit(c.chargedMinor);
    const a = await finance();
    await squat(derived(c.operationId), { customerId: other.customerId, requestedBy: a.adminId });
    const wallet = await kit.balance(c.customerId);
    const walletOther = await kit.balance(other.customerId);
    expect(await create(a, c.operationId)).toEqual({ ok: false, error: "conflict" });
    expect(await create(await finance(), c.operationId)).toEqual({ ok: false, error: "conflict" });
    await untouched(c, wallet, { id: other.customerId, wallet: walletOther });
  });

  it("a row with the marker but the wrong customer, direction, amount or kind is refused, whatever its status", async () => {
    const wrong: Array<[string, (c: Case, o: Case) => Record<string, unknown>]> = [
      ["customer", (_c, o) => ({ customerId: o.customerId })],
      ["direction", () => ({ direction: "debit" })],
      ["amount", (c) => ({ amountMinor: c.chargedMinor + 1n })],
      ["kind", () => ({ kind: "goodwill" })],
    ];
    for (const status of ["pending", "approved"]) {
      for (const [name, over] of wrong) {
        const c = await charged();
        const o = await charged();
        await setLimit(c.chargedMinor);
        const a = await finance();
        await squat(derived(c.operationId), {
          customerId: c.customerId,
          amountMinor: c.chargedMinor,
          kind: "correction",
          evidenceRef: `plan_credit:${c.operationId}`,
          requestedBy: a.adminId,
          status,
          ledgerTransactionId: status === "approved" ? c.chargeId : null,
          ...over(c, o),
        } as Parameters<typeof squat>[1]);
        const wallet = await kit.balance(c.customerId);
        const walletOther = await kit.balance(o.customerId);
        expect(await create(await finance(), c.operationId), `${status} ${name}`).toEqual({
          ok: false,
          error: "conflict",
        });
        await untouched(c, wallet, { id: o.customerId, wallet: walletOther });
      }
    }
  });

  it("a row with the marker of ANOTHER operation on this id is refused", async () => {
    const c = await charged();
    const d = await charged();
    await setLimit(c.chargedMinor);
    const a = await finance();
    await squat(derived(c.operationId), {
      customerId: c.customerId,
      amountMinor: c.chargedMinor,
      kind: "correction",
      evidenceRef: `plan_credit:${d.operationId}`,
      requestedBy: a.adminId,
    });
    const wallet = await kit.balance(c.customerId);
    expect(await create(a, c.operationId)).toEqual({ ok: false, error: "conflict" });
    await untouched(c, wallet);
  });

  it("approving or rejecting a squatting row is refused: no posting, no reversal", async () => {
    const c = await charged();
    const o = await charged();
    await setLimit(1n);
    const a = await finance();
    const id = derived(c.operationId);
    // pending, ordinary evidence, on the reserved id
    await squat(id, {
      customerId: o.customerId,
      amountMinor: 5_000n,
      evidenceRef: "ticket-1",
      requestedBy: a.adminId,
    });
    const wallet = await kit.balance(c.customerId);
    const walletOther = await kit.balance(o.customerId);
    const second = await actorOf("superadmin");
    expect(await approve(second, id)).toEqual({ ok: false, error: "conflict" });
    expect(await reject(second, id)).toEqual({ ok: false, error: "conflict" });
    await untouched(c, wallet, { id: o.customerId, wallet: walletOther });
    expect(
      await q("select status, ledger_transaction_id from wallet_adjustments where id = $1", [id]),
    ).toEqual([{ status: "pending", ledger_transaction_id: null }]);
    // the marker but a kind that is not a correction
    await q(
      "update wallet_adjustments set evidence_ref = $2, customer_id = $3, kind = 'goodwill' where id = $1",
      [id, `plan_credit:${c.operationId}`, c.customerId],
    );
    expect(await approve(second, id)).toEqual({ ok: false, error: "conflict" });
    await untouched(c, wallet, { id: o.customerId, wallet: walletOther });
  });

  it("the normal path is unchanged: request, approval by a second admin, replay", async () => {
    const c = await charged();
    await setLimit(c.chargedMinor - 1n);
    const requester = await finance();
    const made = await create(requester, c.operationId);
    expect(made).toMatchObject({ ok: true, value: { status: "pending" } });
    const id = (made as unknown as { value: { adjustmentId: string } }).value.adjustmentId;
    expect(id).toBe(derived(c.operationId));
    expect(await create(requester, c.operationId)).toMatchObject({ ok: true, replayed: true });
    const wallet = await kit.balance(c.customerId);
    expect(await approve(await actorOf("superadmin"), id)).toMatchObject({
      ok: true,
      value: { status: "approved" },
    });
    expect(await kit.balance(c.customerId)).toBe(wallet + c.chargedMinor);
    expect(await create(requester, c.operationId)).toMatchObject({ ok: true, replayed: true });
    expect(await reversalsOf(c.chargeId)).toHaveLength(1);
  });
});
