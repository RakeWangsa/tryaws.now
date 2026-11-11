import { beforeEach, expect, it } from "vitest";
import type { Tx } from "../client";
import { joinVisitorWaitlist } from "../repositories/system/visitor-waitlist";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const asWeb = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });

const rows = async () =>
  (
    await t.pool.query(
      "select customer_id, email, product_family, region, reason, notified_at from waitlist_entries order by email, product_family",
    )
  ).rows;

beforeEach(async () => {
  await t.pool.query("delete from waitlist_entries");
});

it("stores a visitor's interest with the e-mail, no customer, and the reason flag_off", async () => {
  const done = await asWeb((tx) =>
    joinVisitorWaitlist(tx, { email: "Visitor@Example.TEST", productFamily: "database" }),
  );
  expect(done).toMatchObject({ ok: true, replayed: false });
  expect(await rows()).toEqual([
    {
      customer_id: null,
      email: "visitor@example.test",
      product_family: "database",
      region: "ap-southeast-1",
      reason: "flag_off",
      notified_at: null,
    },
  ]);
});

it("is idempotent: the same address and family again changes nothing, whatever the case (R7)", async () => {
  const first = await asWeb((tx) =>
    joinVisitorWaitlist(tx, { email: "a@example.test", productFamily: "bucket" }),
  );
  const again = await asWeb((tx) =>
    joinVisitorWaitlist(tx, { email: "A@EXAMPLE.test", productFamily: "bucket" }),
  );
  expect(first.ok && again.ok && first.value.id === again.value.id).toBe(true);
  expect(again).toMatchObject({ ok: true, replayed: true });
  const other = await asWeb((tx) =>
    joinVisitorWaitlist(tx, { email: "a@example.test", productFamily: "cdn" }),
  );
  expect(other).toMatchObject({ ok: true, replayed: false });
  expect(await rows()).toHaveLength(2);
});

it("refuses a bad address or family before any query", async () => {
  const bad = [
    { email: "", productFamily: "database" },
    { email: "no-at-sign", productFamily: "database" },
    { email: "a@b@c.test", productFamily: "database" },
    { email: "a b@example.test", productFamily: "database" },
    { email: "a@example.test\r\nBcc: x@example.test", productFamily: "database" },
    { email: "a".repeat(250) + "@example.test", productFamily: "database" },
    { email: "a@example.test", productFamily: "Database" },
    { email: "a@example.test", productFamily: "" },
    { email: "a@example.test", productFamily: "x'; drop table waitlist_entries; --" },
  ];
  for (const input of bad) {
    expect(await asWeb((tx) => joinVisitorWaitlist(tx, input))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(await rows()).toEqual([]);
});
