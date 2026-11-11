import { adminRepos, type AdminActor } from "@tc/db";
import { insertRow, newAdmin } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { walletEntriesSum } from "../ledger/balance";
import { postTransaction } from "../ledger/post";
import { reverseTransaction } from "../ledger/reverse";
import { useLedgerDatabase } from "./ledger-fixtures";

// WP8-T3: the admin repositories of @tc/db with the REAL postTransaction of this package as the poster
// (packages/db tests use a stand-in). The ledger stays balanced, the cache equals the sum of the lines,
// and a correction is a reversing transaction (R5).
const L = useLedgerDatabase();
const actorOf = async (role: AdminActor["role"] = "finance"): Promise<AdminActor> => ({
  adminId: await newAdmin(L.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const asAdmin = <T>(actor: AdminActor, fn: (r: ReturnType<typeof adminRepos>) => Promise<T>) =>
  L.run((tx) => fn(adminRepos(tx, actor)), "admin_rw");

async function limit(value: string): Promise<void> {
  await L.pool.query(
    `insert into settings (id, key, market, scope, scope_id, value)
     values (gen_random_uuid(), 'wallet.adjustment_limit_minor', 'BD', 'market', null, $1::jsonb)
     on conflict (key, market, scope, scope_id) do update set value = excluded.value`,
    [JSON.stringify(value)],
  );
}

const unbalanced = async () =>
  (
    await L.pool.query(
      `select transaction_id from ledger_entries group by transaction_id
        having sum(case direction when 'debit' then amount_minor else -amount_minor end) <> 0`,
    )
  ).rows;

const credit = (customerId: string, amountMinor: bigint) => ({
  requestId: crypto.randomUUID(),
  at: new Date(),
  customerId,
  direction: "credit" as const,
  amountMinor,
  kind: "deposit" as const,
});

describe("adjustments through postTransaction", () => {
  it("posts at once up to the limit, waits above it, and a second admin approves; the ledger balances", async () => {
    const w = await L.newWallet();
    await L.fund(w, 10_000n);
    await limit("50000");
    const a = await actorOf();
    const small = credit(w.customerId, 20_000n);
    expect(
      await asAdmin(a, (r) => r.wallets.createAdjustment(small, "deposit slip 1", postTransaction)),
    ).toMatchObject({ ok: true, value: { status: "approved" } });
    const big = credit(w.customerId, 100_000n);
    expect(
      await asAdmin(a, (r) => r.wallets.createAdjustment(big, "deposit slip 2", postTransaction)),
    ).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(await L.cache(w.customerId)).toMatchObject({ balance: 30_000n });
    // the requester cannot approve; a second finance admin can
    expect(
      await asAdmin(a, (r) =>
        r.wallets.approveAdjustment({ id: big.requestId }, "me", postTransaction),
      ),
    ).toEqual({ ok: false, error: "forbidden" });
    const b = await actorOf();
    expect(
      await asAdmin(b, (r) =>
        r.wallets.approveAdjustment({ id: big.requestId }, "slip checked", postTransaction),
      ),
    ).toMatchObject({ ok: true, replayed: false, value: { status: "approved" } });
    expect(
      await asAdmin(b, (r) =>
        r.wallets.approveAdjustment({ id: big.requestId }, "slip checked", postTransaction),
      ),
    ).toMatchObject({ ok: true, replayed: true });
    expect(await L.cache(w.customerId)).toMatchObject({ balance: 130_000n });
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(130_000n);
    expect(await unbalanced()).toEqual([]);
    const header = await L.pool.query(
      "select kind, reference_type, idempotency_key, actor_type, memo from ledger_transactions where reference_id = $1",
      [big.requestId],
    );
    expect(header.rows).toEqual([
      {
        kind: "adjustment",
        reference_type: "wallet_adjustment",
        idempotency_key: `adjustment:${big.requestId}`,
        actor_type: "admin",
        memo: "deposit slip 2",
      },
    ]);
  });

  it("a debit the wallet cannot cover is refused by the ledger and leaves nothing behind", async () => {
    const w = await L.newWallet();
    await L.fund(w, 1_000n);
    await limit("50000");
    const a = await actorOf();
    const input = {
      ...credit(w.customerId, 5_000n),
      direction: "debit" as const,
      kind: "correction" as const,
    };
    expect(
      await asAdmin(a, (r) => r.wallets.createAdjustment(input, "too much", postTransaction)),
    ).toEqual({ ok: false, error: "conflict" });
    expect(
      (await L.pool.query("select 1 from wallet_adjustments where id = $1", [input.requestId]))
        .rows,
    ).toEqual([]);
    expect(await L.cache(w.customerId)).toMatchObject({ balance: 1_000n });
  });

  it("a correction of an approved adjustment is a reversing transaction, never an update", async () => {
    const w = await L.newWallet();
    await L.fund(w, 0n + 1_000n);
    await limit("50000");
    const a = await actorOf();
    const input = credit(w.customerId, 7_000n);
    const made = await asAdmin(a, (r) =>
      r.wallets.createAdjustment(input, "wrong customer", postTransaction),
    );
    const ledgerId = made.ok ? made.value.ledgerTransactionId : null;
    expect(ledgerId).not.toBeNull();
    const reversed = await L.run(
      (tx) =>
        reverseTransaction(tx, {
          transactionId: ledgerId!,
          actor: { type: "admin", id: a.adminId },
          memo: "posted to the wrong customer",
        }),
      "admin_rw",
    );
    expect(reversed.ok).toBe(true);
    expect(await L.cache(w.customerId)).toMatchObject({ balance: 1_000n });
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(1_000n);
    expect(await unbalanced()).toEqual([]);
  });
});

describe("manual refund through postTransaction", () => {
  it("debits the wallet once, credits refunds, and a second request for the payment is a replay", async () => {
    const w = await L.newWallet();
    const topup = await L.fund(w, 40_000n);
    const payment = await insertRow(L.pool, "payments", {
      customer_id: w.customerId,
      gateway: "eps",
      merchant_transaction_id: "tcmt-" + crypto.randomUUID(),
      idempotency_key: "pay-" + crypto.randomUUID(),
      amount_minor: 40_000n,
      currency: "BDT",
      status: "credited",
      ledger_transaction_id: topup,
    });
    const a = await actorOf();
    const input = { paymentId: payment, amountMinor: 15_000n };
    expect(
      await asAdmin(a, (r) =>
        r.payments.recordManualRefund(input, "EPS dashboard", postTransaction),
      ),
    ).toMatchObject({ ok: true, replayed: false });
    expect(
      await asAdmin(a, (r) =>
        r.payments.recordManualRefund(input, "EPS dashboard", postTransaction),
      ),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await asAdmin(a, (r) =>
        r.payments.recordManualRefund(
          { ...input, amountMinor: 16_000n },
          "EPS dashboard",
          postTransaction,
        ),
      ),
    ).toEqual({ ok: false, error: "conflict" });
    expect(await L.cache(w.customerId)).toMatchObject({ balance: 25_000n });
    expect(await L.run((tx) => walletEntriesSum(tx, w.customerId))).toBe(25_000n);
    expect(await unbalanced()).toEqual([]);
  });
});
