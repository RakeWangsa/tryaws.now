import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { lookupCustomerBySub } from "../repositories/identity";
import { useBoundTestDatabase } from "../testing/bind";
import { withTx } from "../tx";
import { newCustomer } from "./fixtures";

// Bound as web_rw: the grant of the web role on customers is part of the proof.
const t = useBoundTestDatabase("web_rw");

const subOf = async (id: string): Promise<string> =>
  (
    await t.pool.query<{ cognito_sub: string }>("select cognito_sub from customers where id = $1", [
      id,
    ])
  ).rows[0]!.cognito_sub;
const lookup = (sub: string) => withTx((tx) => lookupCustomerBySub(tx, sub));

it("finds the customer by cognito sub and returns exactly six fields", async () => {
  const id = await newCustomer(t.pool, { name: "Karim", phone: "+8801700000000" });
  const found = await lookup(await subOf(id));
  expect(found).toEqual({
    id,
    status: "active",
    sessionsValidAfter: null,
    kycStatus: "none",
    riskTier: "new",
    locale: "bn",
  });
  expect(Object.keys(found!).sort()).toEqual([
    "id",
    "kycStatus",
    "locale",
    "riskTier",
    "sessionsValidAfter",
    "status",
  ]);
});

it("returns null for an unknown sub", async () => {
  await newCustomer(t.pool);
  expect(await lookup("sub-does-not-exist")).toBeNull();
});

it("returns null, without a query, for an empty, non-string or oversized sub", async () => {
  const queried: string[] = [];
  const stub = new Proxy(
    {},
    {
      get: (_target, property) => {
        queried.push(String(property));
        throw new Error("the stub transaction was used");
      },
    },
  ) as unknown as Tx;
  for (const bad of ["", "x".repeat(129), 42, null, undefined, {}, ["a"]]) {
    expect(await lookupCustomerBySub(stub, bad as string)).toBeNull();
  }
  expect(queried).toEqual([]);
  // The edge: 128 characters is allowed and reaches the query (a miss here, since no such row).
  expect(await lookup("x".repeat(128))).toBeNull();
});

it("returns sessionsValidAfter as a Date when set and null when not", async () => {
  const unset = await newCustomer(t.pool);
  const set = await newCustomer(t.pool);
  await t.pool.query("update customers set sessions_valid_after = $2 where id = $1", [
    set,
    "2026-11-01T10:00:00.000Z",
  ]);
  expect((await lookup(await subOf(unset)))!.sessionsValidAfter).toBeNull();
  const after = (await lookup(await subOf(set)))!.sessionsValidAfter;
  expect(after).toBeInstanceOf(Date);
  expect(after!.toISOString()).toBe("2026-11-01T10:00:00.000Z");
});

it("returns a suspended customer with status suspended", async () => {
  const id = await newCustomer(t.pool, { status: "suspended" });
  expect(await lookup(await subOf(id))).toMatchObject({ id, status: "suspended" });
});

it("two customers: the sub of one never returns the other", async () => {
  const a = await newCustomer(t.pool, { kyc_status: "verified", locale: "en" });
  const b = await newCustomer(t.pool, { risk_tier: "trusted" });
  const ofA = await lookup(await subOf(a));
  const ofB = await lookup(await subOf(b));
  expect(ofA).toMatchObject({ id: a, kycStatus: "verified", locale: "en", riskTier: "new" });
  expect(ofB).toMatchObject({ id: b, kycStatus: "none", locale: "bn", riskTier: "trusted" });
  expect(ofA!.id).not.toBe(b);
  expect(ofB!.id).not.toBe(a);
  // The answer for a missing sub is the same null whoever else exists (nothing leaks).
  expect(await lookup(`${await subOf(a)}-missing`)).toBeNull();
});

it("a sub is matched exactly: case, whitespace and a LIKE wildcard do not match", async () => {
  const id = await newCustomer(t.pool);
  const sub = await subOf(id);
  expect(await lookup(sub)).toMatchObject({ id });
  for (const wrong of [
    sub.toUpperCase(),
    ` ${sub}`,
    `${sub} `,
    `${sub}\n`,
    "%",
    "_",
    "sub-%",
    sub.slice(0, -1) + "_",
    `${sub}%`,
  ]) {
    expect(await lookup(wrong), JSON.stringify(wrong)).toBeNull();
  }
});

it("the web_rw role can run the statement", async () => {
  const role = await withTx((tx) => tx.execute(sql`select current_user as u`));
  expect(role.rows[0]).toEqual({ u: "web_rw" });
  await expect(lookup("sub-anything")).resolves.toBeNull();
});
