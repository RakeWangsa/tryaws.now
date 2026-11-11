import type { Tx } from "@tc/db";
import { newCustomer, runTransaction, useTempDatabase, type DatabaseRole } from "@tc/db/testing";
import { expect, it } from "vitest";
import { notify } from "../queue/notify";
import { createPgStore } from "../queue/store";
import { SAMPLES } from "./samples";

// Needs the local PostgreSQL (pnpm db:up). These tests run the real insert and the real store as
// the roles of migration 0006, so the column grants are exercised: web_rw and admin_rw cannot read
// dedupe_key, which is why notify names no conflict target.
const t = useTempDatabase();
const as =
  (role: DatabaseRole) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runTransaction(t.db, fn, { role });
const rows = async (customerId: string) =>
  (
    await t.pool.query(
      "select channel, template, status, attempts, payload, dedupe_key from notifications where customer_id = $1 order by template, channel",
      [customerId],
    )
  ).rows;

it.each(["web_rw", "admin_rw", "worker_rw"] as const)(
  "as %s: one pending row per channel, and a replay inserts nothing and does not abort the transaction",
  async (role) => {
    const customerId = await newCustomer(t.pool);
    const input = {
      customerId,
      template: "kyc_approved" as const,
      data: SAMPLES.kyc_approved.data,
      dedupeKey: crypto.randomUUID(), // the unique key is global: one key per role
    };
    await as(role)((tx) => notify(tx, input));
    // the replay, and a later statement in the same transaction
    await as(role)(async (tx) => {
      await notify(tx, input);
      await notify(tx, { ...input, template: "kyc_received", data: SAMPLES.kyc_received.data });
    });
    const got = await rows(customerId);
    expect(got.map((r) => `${r.template}/${r.channel}/${r.status}/${r.attempts}`)).toEqual([
      "kyc_approved/email/pending/0",
      "kyc_approved/in_app/pending/0",
      "kyc_approved/sms/pending/0",
      "kyc_received/email/pending/0",
      "kyc_received/in_app/pending/0",
    ]);
    expect(new Set(got.map((r) => r.dedupe_key)).size).toBe(got.length);
  },
);

it("a refused input writes nothing", async () => {
  const customerId = await newCustomer(t.pool);
  await expect(
    as("web_rw")((tx) =>
      notify(tx, { customerId, template: "welcome", data: { password: "x" }, dedupeKey: "k" }),
    ),
  ).rejects.toThrow();
  expect(await rows(customerId)).toHaveLength(0);
});

it("no payload row holds an OTP, a password or a token", async () => {
  const customerId = await newCustomer(t.pool);
  for (const [template, sample] of Object.entries(SAMPLES)) {
    await as("web_rw")((tx) =>
      notify(tx, { customerId, template: template as never, data: sample.data, dedupeKey: "k" }),
    );
  }
  const all = JSON.stringify((await rows(customerId)).map((r) => r.payload));
  expect(all).not.toMatch(/password|otp|token|secret/i);
});

it("the store, as worker_rw: due rows, the claim is a compare-and-set, sent and failed only from pending", async () => {
  const customerId = await newCustomer(t.pool);
  await as("web_rw")((tx) =>
    notify(tx, { customerId, template: "welcome", data: {}, dedupeKey: "w" }),
  );
  const store = createPgStore(as("worker_rw"));
  const now = new Date(Date.now() + 1000);
  const due = (await store.due(now, 1000)).filter((r) => r.customerId === customerId);
  expect(due.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
  const email = due.find((r) => r.channel === "email")!;
  // two claims for the same number: exactly one wins
  const claims = await Promise.all([store.claim(email.id, 0), store.claim(email.id, 0)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  // attempt 2 is not due for a minute after creation
  expect((await store.due(now, 1000)).some((r) => r.id === email.id)).toBe(false);
  await store.markSent(email.id, now);
  await store.markFailed(email.id); // no effect on a sent row
  const { rows: got } = await t.pool.query(
    "select status, attempts, sent_at from notifications where id = $1",
    [email.id],
  );
  expect(got[0]).toMatchObject({ status: "sent", attempts: 1 });
  expect(got[0].sent_at).not.toBeNull();
});

it("the store reads the recipient with the locale and the numerals of the market", async () => {
  const customerId = await newCustomer(t.pool);
  const store = createPgStore(as("worker_rw"));
  expect(await store.recipient(customerId)).toMatchObject({
    locale: expect.stringMatching(/^(bn|en)$/),
    numerals: expect.stringMatching(/^(beng|latn)$/),
  });
  expect(await store.recipient("0193f7c2-5b8a-7c3e-9a1b-000000000000")).toBeNull();
});
