// WPU-M3: the audited admin action creditWalletForFailedChange, against the temp database as admin_rw
// with the REAL reverseTransaction of this package as the reverser (packages/db tests use a stand-in).
// The credit is the existing reversal of the renewal charge: the same lines reversed, once.
import { adminRepos, type AdminActor } from "@tc/db";
import { auditRowsOf, insertRow, newAdmin, runTransaction, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { reverseTransaction } from "../ledger/reverse";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { renewNow } from "./renew-now";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
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

interface Case {
  customerId: string;
  resourceId: string;
  subscriptionId: string;
  operationId: string;
  chargedMinor: bigint;
  chargeId: string;
}

/** A paid container service whose renewal was charged and whose apply then ended in `state`. */
async function charged(state = "needs_attention", kind = "scale_container"): Promise<Case> {
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
  const operationId = await insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind,
    state,
    idempotency_key: `lifecycle:plan-change:${String(sub.id)}:${end.toISOString()}`,
    payload: JSON.stringify({
      subscriptionId: String(sub.id),
      productId: crypto.randomUUID(),
      periodEnd: end.toISOString(),
    }),
  });
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
  kit = await makeKit(t, { balanceMinor: 50_000_000n, vcpuLimit: 4000, ipLimit: 4000 });
});

describe("creditWalletForFailedChange", () => {
  it("reverses the whole renewal charge into the wallet, the same lines reversed, once", async () => {
    const c = await charged();
    const finance = await actorOf();
    const wallet = await kit.balance(c.customerId);
    const lines = await q(
      "select account_id, direction, amount_minor::text as a from ledger_entries where transaction_id = $1 order by account_id, direction",
      [c.chargeId],
    );

    const done = await asAdmin(finance, (r) =>
      r.wallets.creditWalletForFailedChange(
        { operationId: c.operationId },
        "apply rejected by ops, capacity not delivered",
        reverseTransaction,
      ),
    );

    expect(done).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        customerId: c.customerId,
        amountMinor: c.chargedMinor,
        chargeTransactionId: c.chargeId,
      },
    });
    // the wallet rose by exactly the charge; the ledger is balanced (the deferred trigger held at commit)
    expect(await kit.balance(c.customerId)).toBe(wallet + c.chargedMinor);
    expect(await unbalanced()).toEqual([]);
    const reversals = await reversalsOf(c.chargeId);
    expect(reversals).toHaveLength(1);
    // every line of the original, VAT, fee and margin accounts included, with the other direction
    const back = await q(
      "select account_id, direction, amount_minor::text as a from ledger_entries where transaction_id = $1 order by account_id, direction",
      [reversals[0]!.id],
    );
    expect(back.map((l) => [l.account_id, l.a])).toEqual(lines.map((l) => [l.account_id, l.a]));
    expect(back.map((l) => l.direction)).toEqual(
      lines.map((l) => (l.direction === "debit" ? "credit" : "debit")),
    );
    expect(back.length).toBeGreaterThan(2);

    // R10: actor, reason, IP and target in the audit row
    const audit = await auditRowsOf(t.pool, finance.adminId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "admin",
      action: "wallet.credit_failed_change",
      target_type: "operation",
      target_id: c.operationId,
      ip: "203.0.113.9",
      metadata: { reason: "apply rejected by ops, capacity not delivered" },
    });

    // the customer is told, in bn and en, by email and in the panel; ids and amounts, no free text (R14)
    const notes = await q(
      "select channel, template, payload from notifications where customer_id = $1 and template = 'wallet_credited_plan_change' order by channel",
      [c.customerId],
    );
    expect(notes.map((n) => n.channel)).toEqual(["email", "in_app"]);
    expect(notes[0]!.payload).toEqual({
      transactionId: reversals[0]!.id,
      creditMinor: c.chargedMinor.toString(),
      balanceMinor: (wallet + c.chargedMinor).toString(),
    });
  });

  it("a repeat is a replay: no second credit, by the same admin, another admin or another operation", async () => {
    const c = await charged();
    const first = await actorOf();
    const other = await actorOf("superadmin");
    const run = (a: AdminActor, op: string) =>
      asAdmin(a, (r) =>
        r.wallets.creditWalletForFailedChange({ operationId: op }, "again", reverseTransaction),
      );
    expect(await run(first, c.operationId)).toMatchObject({ ok: true, replayed: false });
    const after = await kit.balance(c.customerId);
    expect(await run(first, c.operationId)).toMatchObject({ ok: true, replayed: true });
    expect(await run(other, c.operationId)).toMatchObject({ ok: true, replayed: true });
    expect(await kit.balance(c.customerId)).toBe(after);
    expect(await reversalsOf(c.chargeId)).toHaveLength(1);
    // two overlapping runs credit once
    const d = await charged("failed");
    const both = await Promise.all([run(first, d.operationId), run(other, d.operationId)]);
    expect(both.every((x) => x.ok)).toBe(true);
    expect(both.filter((x) => x.ok && !x.replayed)).toHaveLength(1);
    expect(await reversalsOf(d.chargeId)).toHaveLength(1);
    // a replay does not tell the customer twice
    const notes = await q(
      "select 1 from notifications where customer_id = $1 and template = 'wallet_credited_plan_change'",
      [c.customerId],
    );
    expect(notes).toHaveLength(2);
  });

  it("is for finance and superadmin only, and refuses without a reason (R9, R10)", async () => {
    const c = await charged();
    const before = await kit.balance(c.customerId);
    for (const role of ["support", "ops"] as const) {
      const denied = await asAdmin(await actorOf(role), (r) =>
        r.wallets.creditWalletForFailedChange(
          { operationId: c.operationId },
          "x",
          reverseTransaction,
        ),
      );
      expect(denied).toEqual({ ok: false, error: "forbidden" });
    }
    const finance = await actorOf();
    for (const reason of ["", "   ", "x".repeat(501)]) {
      expect(
        await asAdmin(finance, (r) =>
          r.wallets.creditWalletForFailedChange(
            { operationId: c.operationId },
            reason,
            reverseTransaction,
          ),
        ),
      ).toEqual({ ok: false, error: "validation" });
    }
    // a disabled admin is refused whatever the role claim says
    const gone = await actorOf();
    await q("update admin_users set status = 'disabled' where id = $1", [gone.adminId]);
    expect(
      await asAdmin(gone, (r) =>
        r.wallets.creditWalletForFailedChange(
          { operationId: c.operationId },
          "r",
          reverseTransaction,
        ),
      ),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await kit.balance(c.customerId)).toBe(before);
    expect(await reversalsOf(c.chargeId)).toHaveLength(0);
    expect(await auditRowsOf(t.pool, finance.adminId)).toHaveLength(0);
  });

  it("cross-tenant: an operation credits only the wallet that paid its own charge", async () => {
    const a = await charged();
    const b = await charged();
    const finance = await actorOf();
    const balanceA = await kit.balance(a.customerId);
    expect(
      await asAdmin(finance, (r) =>
        r.wallets.creditWalletForFailedChange(
          { operationId: b.operationId },
          "b only",
          reverseTransaction,
        ),
      ),
    ).toMatchObject({ ok: true, value: { customerId: b.customerId } });
    expect(await kit.balance(a.customerId)).toBe(balanceA);
    expect(await reversalsOf(a.chargeId)).toHaveLength(0);

    // a charge of the subscription of C that was paid from the wallet of ANOTHER customer is refused
    const c = await charged();
    const d = await charged();
    await q("update subscriptions set customer_id = $2 where id = $1", [
      c.subscriptionId,
      d.customerId,
    ]);
    await q("update resources set customer_id = $2 where id = $1", [c.resourceId, d.customerId]);
    const before = await kit.balance(c.customerId);
    const beforeD = await kit.balance(d.customerId);
    expect(
      await asAdmin(finance, (r) =>
        r.wallets.creditWalletForFailedChange(
          { operationId: c.operationId },
          "mismatch",
          reverseTransaction,
        ),
      ),
    ).toEqual({ ok: false, error: "conflict" });
    expect(await kit.balance(c.customerId)).toBe(before);
    expect(await kit.balance(d.customerId)).toBe(beforeD);
    expect(await reversalsOf(c.chargeId)).toHaveLength(0);
  });

  it("refuses what is not a failed apply with a charge to give back (R16), and writes nothing", async () => {
    const finance = await actorOf();
    const call = (operationId: unknown) =>
      asAdmin(finance, (r) =>
        r.wallets.creditWalletForFailedChange(
          { operationId: operationId as string },
          "r",
          reverseTransaction,
        ),
      );
    const done = await charged("succeeded");
    const running = await charged("running");
    const wrongKind = await charged("needs_attention", "stop");
    // an apply for a period that was never charged: the charge it names does not exist
    const unpaid = await charged();
    await q("update operations set payload = $2::jsonb where id = $1", [
      unpaid.operationId,
      JSON.stringify({ periodEnd: "2031-01-01T00:00:00.000Z" }),
    ]);
    // an old payload without a period end
    const old = await charged();
    await q("update operations set payload = '{}'::jsonb where id = $1", [old.operationId]);

    expect(await call(done.operationId)).toEqual({ ok: false, error: "conflict" });
    expect(await call(running.operationId)).toEqual({ ok: false, error: "conflict" });
    expect(await call(wrongKind.operationId)).toEqual({ ok: false, error: "conflict" });
    expect(await call(unpaid.operationId)).toEqual({ ok: false, error: "not_found" });
    expect(await call(old.operationId)).toEqual({ ok: false, error: "conflict" });
    expect(await call(crypto.randomUUID())).toEqual({ ok: false, error: "not_found" });
    expect(await call("not-a-uuid")).toEqual({ ok: false, error: "validation" });
    expect(await call(undefined)).toEqual({ ok: false, error: "validation" });
    for (const x of [done, running, wrongKind, unpaid, old]) {
      expect(await reversalsOf(x.chargeId)).toHaveLength(0);
    }
    expect(await auditRowsOf(t.pool, finance.adminId)).toHaveLength(0);
    // no reverser given: fail closed
    expect(
      await asAdmin(finance, (r) =>
        r.wallets.creditWalletForFailedChange(
          { operationId: done.operationId },
          "r",
          undefined as never,
        ),
      ),
    ).toEqual({ ok: false, error: "validation" });
  });

  it("does not credit a charge that an order reversal or another reversal already gave back", async () => {
    const c = await charged();
    // someone reversed the charge first (finance by hand, through the same function)
    await runTransaction(
      t.db,
      async (tx) =>
        reverseTransaction(tx, {
          transactionId: c.chargeId,
          actor: { type: "admin", id: await newAdmin(t.pool) },
          memo: "by hand",
        }),
      { role: "admin_rw" },
    );
    const after = await kit.balance(c.customerId);
    expect(
      await asAdmin(await actorOf(), (r) =>
        r.wallets.creditWalletForFailedChange(
          { operationId: c.operationId },
          "r",
          reverseTransaction,
        ),
      ),
    ).toMatchObject({ ok: true, replayed: true });
    expect(await kit.balance(c.customerId)).toBe(after);
    expect(await reversalsOf(c.chargeId)).toHaveLength(1);
  });
});
