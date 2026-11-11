import { describe, expect, it } from "vitest";
import { inputs, transactionIdOf, useLedgerDatabase } from "../test/ledger-fixtures";
import { walletEntriesSum } from "./balance";
import { postTransaction } from "./post";
import { reverseTransaction } from "./reverse";
import type { Actor } from "./types";

const L = useLedgerDatabase();
const system: Actor = { type: "system" };
const reverse = (transactionId: string, actor: Actor = system, memo?: string, orderId?: string) =>
  L.run((tx) =>
    reverseTransaction(tx, {
      transactionId,
      actor,
      ...(memo === undefined ? {} : { memo }),
      ...(orderId === undefined ? {} : { orderId }),
    }),
  );

describe("a correction is a new transaction (R5)", () => {
  it("reverses the purchase of section 8: the wallet gets 74295 back and the lines are the inverse", async () => {
    const w = await L.newWallet();
    await L.fund(w, 150000n);
    const bought = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.purchase(w.customerId))),
    );
    const back = transactionIdOf(await reverse(bought, system, "provisioning failed"));
    expect(back).not.toBe(bought);
    expect(await L.cache(w.customerId)).toEqual({ balance: 150000n, version: 3 });
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(150000n);
    const header = await L.pool.query(
      "select kind, reference_type, reference_id, idempotency_key, actor_type, actor_id, memo from ledger_transactions where id = $1",
      [back],
    );
    expect(header.rows[0]).toEqual({
      kind: "reversal",
      reference_type: "ledger_transaction",
      reference_id: bought,
      idempotency_key: `reversal:${bought}`,
      actor_type: "system",
      actor_id: null,
      memo: "provisioning failed",
    });
    const lines = await L.pool.query(
      `select a.type, e.direction, e.amount_minor::text as amount from ledger_entries e
         join ledger_accounts a on a.id = e.account_id where e.transaction_id = $1 order by e.id`,
      [back],
    );
    expect(lines.rows).toEqual([
      { type: "customer_wallet", direction: "credit", amount: "74295" },
      { type: "revenue_aws_base", direction: "debit", amount: "63500" },
      { type: "vat_korea_payable", direction: "debit", amount: "6350" },
      { type: "vat_bd_payable", direction: "debit", amount: "3175" },
      { type: "processing_fee_income", direction: "debit", amount: "1270" },
    ]);
    // nothing was updated or deleted: the original lines are still there
    expect(
      (
        await L.pool.query(
          "select count(*)::int as n from ledger_entries where transaction_id = $1",
          [bought],
        )
      ).rows[0],
    ).toEqual({
      n: 5,
    });
  });

  it("refunds once: a second request, also from another actor, gets the first reversal", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const bought = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 400n))),
    );
    const first = transactionIdOf(await reverse(bought));
    const before = await L.counts();
    expect(transactionIdOf(await reverse(bought))).toBe(first);
    expect(
      transactionIdOf(
        await reverse(bought, { type: "admin", id: crypto.randomUUID() }, "second look"),
      ),
    ).toBe(first);
    expect(await L.counts()).toEqual(before);
    expect((await L.cache(w.customerId)).balance).toBe(1000n);
  });

  it("with an order id the key is the key of spec 9.1, order-reversal:<order id>, and the reference is still the original transaction", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const bought = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 400n))),
    );
    const orderId = crypto.randomUUID();
    const back = transactionIdOf(await reverse(bought, system, "provisioning failed", orderId));
    const header = await L.pool.query(
      "select kind, reference_type, reference_id, idempotency_key from ledger_transactions where id = $1",
      [back],
    );
    expect(header.rows[0]).toEqual({
      kind: "reversal",
      reference_type: "ledger_transaction",
      reference_id: bought,
      idempotency_key: `order-reversal:${orderId}`,
    });
    expect(transactionIdOf(await reverse(bought, system, "provisioning failed", orderId))).toBe(
      back,
    ); // the same order again
    expect((await L.cache(w.customerId)).balance).toBe(1000n);
  });

  it("a transaction reversed under one key family is not reversed again under the other, in either order", async () => {
    const w = await L.newWallet();
    await L.fund(w, 2000n);
    const first = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 400n))),
    );
    const second = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 300n))),
    );
    const byOrder = transactionIdOf(await reverse(first, system, "failed", crypto.randomUUID()));
    const before = await L.counts();
    expect(
      transactionIdOf(await reverse(first, { type: "admin", id: crypto.randomUUID() }, "by hand")),
    ).toBe(byOrder);
    const byAdmin = transactionIdOf(
      await reverse(second, { type: "admin", id: crypto.randomUUID() }, "by hand"),
    );
    const afterAdmin = await L.counts();
    expect(transactionIdOf(await reverse(second, system, "failed", crypto.randomUUID()))).toBe(
      byAdmin,
    );
    expect(await L.counts()).toEqual(afterAdmin);
    expect(afterAdmin.transactions).toBe(before.transactions + 1);
    expect((await L.cache(w.customerId)).balance).toBe(2000n);
  });

  it("two requests at once reverse once", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const bought = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 400n))),
    );
    const first = L.holdOpen((tx) =>
      reverseTransaction(tx, { transactionId: bought, actor: system }),
    );
    await first.reached;
    const second = reverse(bought);
    await L.waitForLockWaiter();
    first.release();
    const [a, b] = await Promise.all([first.result, second]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect((await L.cache(w.customerId)).balance).toBe(1000n);
  }, 20_000);
});

describe("what a reversal refuses", () => {
  it("the top-up of money that was spent: insufficient_balance, nothing written (owner decision 16 is open)", async () => {
    const w = await L.newWallet();
    const topup = await L.fund(w, 1000n);
    await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 600n)));
    const before = { counts: await L.counts(), cache: await L.cache(w.customerId) };
    expect(await reverse(topup)).toEqual({
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: 600n },
    });
    expect({ counts: await L.counts(), cache: await L.cache(w.customerId) }).toEqual(before);
  });
  it("a reversal", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const bought = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 400n))),
    );
    const back = transactionIdOf(await reverse(bought));
    expect(await reverse(back)).toMatchObject({
      ok: false,
      error: "validation",
      fields: { transactionId: expect.any(String) },
    });
  });
  it("an unknown transaction, a malformed id and a customer as the actor", async () => {
    expect(await reverse(crypto.randomUUID())).toEqual({ ok: false, error: "not_found" });
    expect(await reverse("42")).toMatchObject({ ok: false, error: "validation" });
    const w = await L.newWallet();
    await L.fund(w, 1000n);
    const bought = transactionIdOf(
      await L.run((tx) => postTransaction(tx, inputs.spend(w.customerId, 400n))),
    );
    expect(await reverse(bought, { type: "customer", id: w.customerId })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    // an admin gives the reason (R10); the system may leave it out
    expect(await reverse(bought, { type: "admin", id: crypto.randomUUID() })).toMatchObject({
      ok: false,
      error: "validation",
      fields: { memo: expect.any(String) },
    });
    expect(await reverse(bought, system, undefined, "not-a-uuid")).toMatchObject({
      ok: false,
      error: "validation",
      fields: { orderId: expect.any(String) },
    });
  });
});
