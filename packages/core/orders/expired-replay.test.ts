import { randomUUID } from "node:crypto";
import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { snapshotRows, makeKit, PLAN_TOTAL, type Kit } from "../test/orders-kit";
import { compensateFailedCreate } from "./compensate";
import { makeOrders } from "./place";
import { runTransaction } from "@tc/db/testing";

// Hardening (money review 2): a retry of a charged order after the draft expired must answer the
// order that exists, not "expired", so a customer never pays twice for a purchase that went through.
const t = useTempDatabase();
const newKey = () => "k" + randomUUID().replaceAll("-", "");
const place = (kit: Kit, token: string, key = newKey()) =>
  makeOrders(kit.deps).placeOrder(kit.session, { token, idempotencyKey: key });
const EXPIRED = 31 * 60;

describe("placeOrder: a signed draft that expired", () => {
  it("answers the existing order of that draft and charges nothing more", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const { token } = await kit.draft();
    const first = await place(kit, token);
    expect(first.ok).toBe(true);
    const after = await snapshotRows(t);
    kit.clock.advance(EXPIRED);
    expect(await place(kit, token)).toEqual(first);
    expect(await snapshotRows(t)).toEqual(after);
    expect(await kit.balance()).toBe(start - PLAN_TOTAL);
  });

  it("is still expired for a draft that never became an order, and writes no order", async () => {
    const kit = await makeKit(t);
    const start = await kit.balance();
    const { token } = await kit.draft();
    kit.clock.advance(EXPIRED);
    expect(await place(kit, token)).toMatchObject({
      ok: false,
      error: "validation",
      fields: { token: "expired" },
    });
    expect(await kit.balance()).toBe(start);
    expect(
      (
        await t.pool.query("select count(*)::int as n from orders where customer_id = $1", [
          kit.customerId,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });
  });

  it("is a conflict, not ok, for an order that was reversed", async () => {
    const kit = await makeKit(t);
    const { token } = await kit.draft();
    const first = await place(kit, token);
    if (!first.ok) throw new Error("the order was not placed");
    const resource = await t.pool.query("select id from resources where customer_id = $1", [
      kit.customerId,
    ]);
    await runTransaction(
      t.db,
      (tx) =>
        compensateFailedCreate(tx, kit.deps, {
          resourceId: (resource.rows[0] as { id: string }).id,
          customerId: kit.customerId,
          code: "step_failed",
        }),
      { role: "worker_rw" },
    );
    kit.clock.advance(EXPIRED);
    expect(await place(kit, token)).toMatchObject({ ok: false, error: "conflict" });
  });

  it("does not show another customer's order: a token of someone else stays expired", async () => {
    const kit = await makeKit(t);
    const other = await kit.newBuyer();
    const { token } = await kit.draft();
    expect(await place(kit, token)).toMatchObject({ ok: true });
    kit.clock.advance(EXPIRED);
    const asOther = await makeOrders(kit.deps).placeOrder(other.session, {
      token,
      idempotencyKey: newKey(),
    });
    expect(asOther).toMatchObject({ ok: false, error: "validation", fields: { token: "expired" } });
  });
});
