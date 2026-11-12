import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { newCustomer, newLedgerTransaction } from "./fixtures";
import { asRole, expectSqlError, insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-D3 (audit C.6, migration 0021): one EPS transaction id belongs to one payment, and a credited
// payment is final whatever the role. The column grant of web_rw is not narrowed because every one of its
// five columns is written by the EPS return route (credit) or by markRedirected/markFailed.

const t = useTempDatabase();

const payment = (customerId: string, over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "payments", {
    customer_id: customerId,
    gateway: "eps",
    merchant_transaction_id: "MTX-" + uuidv7(),
    idempotency_key: uuidv7(),
    amount_minor: 15_000,
    currency: "BDT",
    ...over,
  });

it("two payments cannot hold the same EPS transaction id; null is allowed many times", async () => {
  const c = await newCustomer(t.pool);
  await payment(c, { gateway_transaction_id: "EPS-TX-1" });
  await expectSqlError(payment(c, { gateway_transaction_id: "EPS-TX-1" }), "23505", {
    constraint: "payments_gateway_transaction_id_unique",
  });
  await payment(c);
  await payment(c);
});

it("web_rw cannot give a second payment the id of the first (the last word of gatewayIdUsedElsewhere)", async () => {
  const c = await newCustomer(t.pool);
  await payment(c, { gateway_transaction_id: "EPS-TX-2" });
  const other = await payment(c);
  await expectSqlError(
    asRole(t.pool, "web_rw", (cl) =>
      cl.query("update payments set gateway_transaction_id = 'EPS-TX-2' where id = $1", [other]),
    ),
    "23505",
    { constraint: "payments_gateway_transaction_id_unique" },
  );
});

async function credited(customerId: string): Promise<string> {
  const ledger = await newLedgerTransaction(t.pool, customerId);
  const id = await payment(customerId, { gateway_transaction_id: "EPS-" + uuidv7() });
  await t.pool.query(
    "update payments set status = 'credited', ledger_transaction_id = $2, verified_at = now() where id = $1",
    [id, ledger],
  );
  return id;
}

it("a credited payment is final for web_rw, worker_rw and admin_rw: no column that matters can change", async () => {
  const c = await newCustomer(t.pool);
  const id = await credited(c);
  const statements = [
    "update payments set status = 'review' where id = $1",
    "update payments set status = 'failed' where id = $1",
    "update payments set ledger_transaction_id = null where id = $1",
    "update payments set gateway_transaction_id = 'OTHER' where id = $1",
    "update payments set verified_at = now() + interval '1 day' where id = $1",
    `update payments set verify_payload = '{"x":1}'::jsonb where id = $1`,
  ];
  for (const role of ["web_rw", "worker_rw", "admin_rw"] as const) {
    for (const sql of statements) {
      await expectSqlError(
        asRole(t.pool, role, (cl) => cl.query(sql, [id])),
        "23001",
        { message: /credited payment is final/ },
      );
    }
  }
  const row = (await t.pool.query("select status from payments where id = $1", [id])).rows[0];
  expect(row.status).toBe("credited");
});

it("the open states still move as before: initiated to redirected to failed for web_rw", async () => {
  const c = await newCustomer(t.pool);
  const id = await payment(c);
  const status = await asRole(t.pool, "web_rw", async (cl) => {
    await cl.query(
      "update payments set status = 'redirected', gateway_transaction_id = 'EPS-' || $1::text where id = $2",
      [uuidv7(), id],
    );
    await cl.query("update payments set status = 'failed' where id = $1", [id]);
    return (await cl.query("select status from payments where id = $1", [id])).rows[0].status;
  });
  expect(status).toBe("failed");
});

it("web_rw still has exactly the five update columns, none of the amount, owner or id", async () => {
  const c = await newCustomer(t.pool);
  const id = await payment(c);
  for (const column of [
    "amount_minor = 1",
    "customer_id = gen_random_uuid()",
    "currency = 'USD'",
  ]) {
    await expectSqlError(
      asRole(t.pool, "web_rw", (cl) =>
        cl.query(`update payments set ${column} where id = $1`, [id]),
      ),
      "42501",
    );
  }
});
