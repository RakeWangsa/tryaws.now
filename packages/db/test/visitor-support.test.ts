import { beforeEach, expect, it } from "vitest";
import type { Tx } from "../client";
import { createVisitorSupportRequest } from "../repositories/system/visitor-support";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const asWeb = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "web_rw" });

const rows = async () =>
  (
    await t.pool.query(
      "select customer_id, name, email, category, related_resource_id, subject, message, status from support_requests order by subject",
    )
  ).rows;

const base = {
  email: "Visitor@Example.TEST",
  name: null,
  category: "billing" as const,
  subject: "A question",
  message: "How do I top up?",
};

beforeEach(async () => {
  await t.pool.query("delete from support_requests");
});

it("stores a visitor's request with the e-mail, no customer and the status open", async () => {
  const done = await asWeb((tx) => createVisitorSupportRequest(tx, { ...base, name: "Rahim" }));
  expect(done).toMatchObject({ ok: true, replayed: false });
  expect(await rows()).toEqual([
    {
      customer_id: null,
      name: "Rahim",
      email: "visitor@example.test",
      category: "billing",
      related_resource_id: null,
      subject: "A question",
      message: "How do I top up?",
      status: "open",
    },
  ]);
});

it("is idempotent: the same request again changes nothing, whatever the case of the address (R7)", async () => {
  const first = await asWeb((tx) => createVisitorSupportRequest(tx, base));
  const again = await asWeb((tx) =>
    createVisitorSupportRequest(tx, { ...base, email: "visitor@example.test" }),
  );
  expect(first.ok && again.ok && first.value.id === again.value.id).toBe(true);
  expect(again).toMatchObject({ ok: true, replayed: true });
  expect(await rows()).toHaveLength(1);
});

it("refuses a bad address, category, subject or message before any query", async () => {
  const bad = [
    { ...base, email: "no-at-sign" },
    { ...base, email: "a b@example.test" },
    { ...base, category: "root" as never },
    { ...base, subject: "" },
    { ...base, message: "" },
    { ...base, message: "x".repeat(5001) },
  ];
  for (const input of bad) {
    expect(await asWeb((tx) => createVisitorSupportRequest(tx, input))).toMatchObject({
      ok: false,
      error: "validation",
    });
  }
  expect(await rows()).toHaveLength(0);
});
