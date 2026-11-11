import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { customerRepos, type CustomerRepos } from "../repositories/customer/index";
import type { NewOtpChallenge, OtpClaim } from "../repositories/customer/otp";
import { withCustomerRepos } from "../testing/repos";
import { runTransaction } from "../tx";
import { useTempDatabase } from "./temp-db";
import { insertRow } from "./sql";
import { newCustomer } from "./fixtures";

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
const NOW = new Date("2026-11-11T10:00:00.000Z");
const atMs = (ms: number) => new Date(NOW.getTime() + ms);
const HASH = "v1." + "a".repeat(64);
const PHONE = "+8801712345678";
const challenge = (over: Partial<NewOtpChallenge> = {}): NewOtpChallenge => ({
  id: uuidv7(),
  phone: PHONE,
  codeHash: HASH,
  expiresAt: atMs(300_000),
  now: NOW,
  ...over,
});
const claimAt = (ms: number, over: Partial<OtpClaim> = {}): OtpClaim => ({
  now: atMs(ms),
  latestExpiry: atMs(ms + 360_000),
  maxAttempts: 5,
  ...over,
});
const consumedAt = async (id: string) =>
  (await t.pool.query("select consumed_at from otp_challenges where id = $1", [id])).rows[0]
    .consumed_at;
const openRow = (customerId: string, id = uuidv7()) =>
  insertRow(t.pool, "otp_challenges", {
    id,
    customer_id: customerId,
    phone: PHONE,
    code_hash: HASH,
    expires_at: atMs(300_000),
  });

it("issue creates an open challenge and stores exactly what it was given", async () => {
  const c = await newCustomer(t.pool);
  const input = challenge();
  expect(await as(c, (x) => x.otp.issue(input))).toEqual({
    ok: true,
    replayed: false,
    value: {
      id: input.id,
      phone: PHONE,
      attempts: 0,
      expiresAt: atMs(300_000),
      consumedAt: null,
      createdAt: expect.any(Date),
    },
  });
  expect(
    (
      await t.pool.query("select customer_id, code_hash from otp_challenges where id = $1", [
        input.id,
      ])
    ).rows,
  ).toEqual([{ customer_id: c, code_hash: HASH }]);
});

it("the same id again is a replay; another number, an id of another customer or a non-UUID is refused", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const input = challenge();
  const first = await as(a, (x) => x.otp.issue(input));
  expect(await as(a, (x) => x.otp.issue({ ...input, now: atMs(5_000) }))).toEqual({
    ok: true,
    replayed: true,
    value: first.ok ? first.value : null,
  });
  expect(await as(a, (x) => x.otp.issue({ ...input, phone: "+8801812345678" }))).toEqual({
    ok: false,
    error: "conflict",
  });
  expect(await as(b, (x) => x.otp.issue(input))).toEqual({ ok: false, error: "conflict" });
  expect(await as(a, (x) => x.otp.issue({ ...input, id: "abc" }))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(
    (await t.pool.query("select customer_id from otp_challenges where id = $1", [input.id])).rows,
  ).toEqual([{ customer_id: a }]);
});

it("issue refuses a code hash that is not v1 plus 64 hex and a phone that is not +880 and ten digits, and stores nothing", async () => {
  const c = await newCustomer(t.pool);
  for (const over of [
    { codeHash: "123456" },
    { codeHash: "v1." + "A".repeat(64) },
    { phone: "01712345678" },
    { phone: "+8801712" },
  ]) {
    expect(await as(c, (x) => x.otp.issue(challenge(over)))).toEqual({
      ok: false,
      error: "validation",
    });
  }
  expect(
    (
      await t.pool.query("select count(*)::int as n from otp_challenges where customer_id = $1", [
        c,
      ])
    ).rows[0].n,
  ).toBe(0);
});

it("a send whose transaction began first but commits last does not close the newer challenge", async () => {
  const c = await newCustomer(t.pool);
  const first = uuidv7();
  const second = uuidv7();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let began!: () => void;
  const hasBegun = new Promise<void>((r) => (began = r));
  const late = runTransaction(
    t.db,
    async (tx) => {
      began();
      await gate; // now() of this transaction is already fixed, and it is older than the other send
      return customerRepos(tx, c).otp.issue(challenge({ id: first }));
    },
    { role: "web_rw" },
  );
  await hasBegun;
  await new Promise((r) => setTimeout(r, 50));
  await as(c, (x) => x.otp.issue(challenge({ id: second, now: atMs(1_000) })));
  release();
  await late;
  expect(await consumedAt(second)).toBeNull();
  expect((await as(c, (x) => x.otp.latest()))?.id).toBe(second);
  expect((await as(c, (x) => x.otp.claimAttempt(claimAt(2_000)))).ok).toBe(true);
});

it("issue closes the other open challenges of this customer at now, not those of another customer; a replay closes nothing", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const old = challenge();
  const foreign = challenge();
  await as(a, (x) => x.otp.issue(old));
  await as(b, (x) => x.otp.issue(foreign));
  const fresh = challenge({ now: atMs(10_000) });
  await as(a, (x) => x.otp.issue(fresh));
  await as(a, (x) => x.otp.issue({ ...old, now: atMs(20_000) })); // a replay
  expect(await consumedAt(old.id)).toEqual(atMs(10_000));
  expect(await consumedAt(foreign.id)).toBeNull();
  expect(await consumedAt(fresh.id)).toBeNull();
});

it("claimAttempt counts each call, stops at the fifth, hands out the stored hash, and only ever uses the newest challenge", async () => {
  const c = await newCustomer(t.pool);
  const older = await openRow(c);
  const newer = await openRow(c);
  const seen = [];
  for (let i = 0; i < 7; i++) {
    const r = await as(c, (x) => x.otp.claimAttempt(claimAt(1_000)));
    seen.push(
      r.ok
        ? [
            r.value.id === newer ? "newer" : "older",
            r.value.attempts,
            r.value.codeHash,
            r.value.phone,
          ]
        : r.error,
    );
  }
  const hit = (n: number) => ["newer", n, HASH, PHONE];
  expect(seen).toEqual([hit(1), hit(2), hit(3), hit(4), hit(5), "not_found", "not_found"]);
  expect(
    (await t.pool.query("select attempts from otp_challenges where id = $1", [older])).rows[0]
      .attempts,
  ).toBe(0);
});

it.each([
  ["one millisecond before the expiry", 299_999, true],
  ["at the expiry", 300_000, false],
  ["a verifier clock 60 s behind the issuer", -60_000, true],
  ["a verifier clock 60.001 s behind the issuer", -60_001, false],
])("claimAttempt, %s", async (_, ms, claimed) => {
  const c = await newCustomer(t.pool);
  await openRow(c);
  expect((await as(c, (x) => x.otp.claimAttempt(claimAt(ms)))).ok).toBe(claimed);
});

it("a closed challenge and a challenge of another customer cannot be claimed; eight claims at once give attempts 1 to 5", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const id = await openRow(a);
  expect(await as(b, (x) => x.otp.claimAttempt(claimAt(1_000)))).toEqual({
    ok: false,
    error: "not_found",
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => as(a, (x) => x.otp.claimAttempt(claimAt(1_000)))),
  );
  expect(results.flatMap((r) => (r.ok ? [r.value.attempts] : [])).sort()).toEqual([1, 2, 3, 4, 5]);
  expect(
    (await t.pool.query("select attempts from otp_challenges where id = $1", [id])).rows[0]
      .attempts,
  ).toBe(5);
  const c = await newCustomer(t.pool);
  const open = await openRow(c);
  await as(c, (x) => x.otp.close(open, NOW));
  expect(await as(c, (x) => x.otp.claimAttempt(claimAt(1_000)))).toEqual({
    ok: false,
    error: "not_found",
  });
});

it("close closes an open challenge once; another customer's id and a non-UUID are not found", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const id = await openRow(a);
  expect(await as(b, (x) => x.otp.close(id, NOW))).toEqual({ ok: false, error: "not_found" });
  expect(await consumedAt(id)).toBeNull();
  expect(await as(a, (x) => x.otp.close(id, atMs(5_000)))).toEqual({
    ok: true,
    replayed: false,
    value: { id },
  });
  expect(await as(a, (x) => x.otp.close(id, atMs(9_000)))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await as(a, (x) => x.otp.close("abc", NOW))).toEqual({ ok: false, error: "not_found" });
  expect(await consumedAt(id)).toEqual(atMs(5_000));
});

it("claimAttempt refuses a maxAttempts outside 1 to 100 with a TypeError and counts nothing", async () => {
  const c = await newCustomer(t.pool);
  const id = await openRow(c);
  for (const maxAttempts of [0, 101, 1.5, Number.NaN]) {
    await expect(as(c, (x) => x.otp.claimAttempt(claimAt(1_000, { maxAttempts })))).rejects.toThrow(
      TypeError,
    );
  }
  expect(
    (await t.pool.query("select attempts from otp_challenges where id = $1", [id])).rows[0]
      .attempts,
  ).toBe(0);
});

it("latest is the newest challenge of this customer, open or not, and null when there is none", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  await openRow(a);
  const second = await openRow(a);
  await as(a, (x) => x.otp.close(second, NOW));
  expect(await as(a, (x) => x.otp.latest())).toMatchObject({ id: second, consumedAt: NOW });
  expect(Object.keys((await as(a, (x) => x.otp.latest()))!).sort()).toEqual([
    "attempts",
    "consumedAt",
    "createdAt",
    "expiresAt",
    "id",
    "phone",
  ]);
  expect(await as(b, (x) => x.otp.latest())).toBeNull();
});
