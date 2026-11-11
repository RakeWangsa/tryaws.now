import { v7 as uuidv7 } from "uuid";
import { beforeEach, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { resetCapacity, seedPool } from "../testing/capacity";
import { withCustomerRepos } from "../testing/repos";
import { ensureMarket, newCustomer } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const REGION = "ap-southeast-1";
const [P1, P2] = ["00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000002"];
const as = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
  withCustomerRepos(t.db, customerId, fn);
const homes = async () =>
  (await t.pool.query("select count(*)::int as n from customer_homes")).rows[0].n as number;

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

it("get is null until a home is assigned, then the own row", async () => {
  await seedPool(t.pool, { id: P1 });
  const a = await newCustomer(t.pool);
  expect(await as(a, (r) => r.homes.get(REGION))).toBeNull();
  const made = await as(a, (r) => r.homes.assign(REGION, P1));
  expect(made).toMatchObject({
    ok: true,
    replayed: false,
    value: { region: REGION, poolAccountId: P1 },
  });
  expect(await as(a, (r) => r.homes.get(REGION))).toEqual(made.ok ? made.value : null);
  expect(made.ok && made.value.createdAt).toBeInstanceOf(Date);
  expect(await as(a, (r) => r.homes.get("ap-south-1"))).toBeNull();
  expect(await as(a, (r) => r.homes.get("Dhaka"))).toBeNull();
});
it("assign again with the same account is a replay, with another account a conflict", async () => {
  await seedPool(t.pool, { id: P1 });
  await seedPool(t.pool, { id: P2 });
  const a = await newCustomer(t.pool);
  await as(a, (r) => r.homes.assign(REGION, P1));
  expect(await as(a, (r) => r.homes.assign(REGION, P1))).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(await as(a, (r) => r.homes.assign(REGION, P2))).toEqual({ ok: false, error: "conflict" });
  expect(await homes()).toBe(1);
});
it("assign refuses an account of the other tier with not_found, and takes one of the customer's own tier", async () => {
  await seedPool(t.pool, { id: P1, tier: "trusted" });
  await seedPool(t.pool, { id: P2, tier: "new" });
  const a = await newCustomer(t.pool); // risk_tier defaults to new
  expect(await as(a, (r) => r.homes.assign(REGION, P1))).toEqual({ ok: false, error: "not_found" });
  expect(await homes()).toBe(0);
  expect(await as(a, (r) => r.homes.assign(REGION, P2))).toMatchObject({
    ok: true,
    replayed: false,
    value: { poolAccountId: P2 },
  });
  const trusted = await newCustomer(t.pool, { risk_tier: "trusted" });
  expect(await as(trusted, (r) => r.homes.assign(REGION, P1))).toMatchObject({
    ok: true,
    value: { poolAccountId: P1 },
  });
  expect(await as(trusted, (r) => r.homes.assign("ap-south-1", P2))).toEqual({
    ok: false,
    error: "not_found",
  });
});
it("assign answers not_found for an account that is missing, not active or not a UUID, and validation for a bad Region", async () => {
  await seedPool(t.pool, { id: P1, status: "disabled" });
  const a = await newCustomer(t.pool);
  for (const account of [P1, uuidv7(), "abc"])
    expect(await as(a, (r) => r.homes.assign(REGION, account))).toEqual({
      ok: false,
      error: "not_found",
    });
  expect(await as(a, (r) => r.homes.assign("Dhaka", P1))).toEqual({
    ok: false,
    error: "validation",
  });
  expect(await homes()).toBe(0);
});
it("gives one home when the same customer is assigned two accounts at the same moment", async () => {
  await seedPool(t.pool, { id: P1 });
  await seedPool(t.pool, { id: P2 });
  const a = await newCustomer(t.pool);
  const results = await Promise.all([
    as(a, (r) => r.homes.assign(REGION, P1)),
    as(a, (r) => r.homes.assign(REGION, P2)),
  ]);
  expect(results.map((r) => (r.ok ? "created" : r.error)).sort()).toEqual(["conflict", "created"]);
  expect(await homes()).toBe(1);
});
