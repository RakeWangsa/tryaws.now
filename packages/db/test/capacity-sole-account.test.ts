import { beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { capacityRepo } from "../repositories/capacity";
import type { CustomerRepos } from "../repositories/customer/index";
import { resetCapacity, seedPool } from "../testing/capacity";
import { withCustomerRepos } from "../testing/repos";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket, newCustomer } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-G1 (P1): the repository answer behind the single-account rule of decide().
const t = useTempDatabase();
const [P1, P2, P3] = [
  "00000000-0000-7000-8000-000000000001",
  "00000000-0000-7000-8000-000000000002",
  "00000000-0000-7000-8000-000000000003",
];
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("homes.assign with the sole active account", () => {
  const repos = <T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>) =>
    withCustomerRepos(t.db, customerId, fn);
  const REGION = "ap-southeast-1";

  it("takes the account of another tier when it is the only active one", async () => {
    await seedPool(t.pool, { id: P1, tier: "trusted", cells: [] });
    await seedPool(t.pool, { id: P3, tier: "new", status: "disabled", cells: [] });
    const fresh = await newCustomer(t.pool); // risk_tier new
    expect(await repos(fresh, (r) => r.homes.assign(REGION, P1))).toMatchObject({
      ok: true,
      replayed: false,
      value: { poolAccountId: P1 },
    });
    const trusted = await newCustomer(t.pool, { risk_tier: "trusted" });
    await resetCapacity(t.pool);
    await seedPool(t.pool, { id: P2, tier: "new", cells: [] });
    expect(await repos(trusted, (r) => r.homes.assign(REGION, P2))).toMatchObject({
      ok: true,
      value: { poolAccountId: P2 },
    });
  });

  it("still refuses the other tier with two active accounts (not_found, no home written)", async () => {
    await seedPool(t.pool, { id: P1, tier: "trusted", cells: [] });
    await seedPool(t.pool, { id: P2, tier: "trusted", cells: [] });
    const fresh = await newCustomer(t.pool);
    expect(await repos(fresh, (r) => r.homes.assign(REGION, P1))).toEqual({
      ok: false,
      error: "not_found",
    });
    const { rows } = await t.pool.query("select count(*)::int as n from customer_homes");
    expect(rows[0].n).toBe(0);
  });

  it("never takes a disabled account, even when it is the only one", async () => {
    await seedPool(t.pool, { id: P3, tier: "new", status: "disabled", cells: [] });
    const fresh = await newCustomer(t.pool);
    expect(await repos(fresh, (r) => r.homes.assign(REGION, P3))).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("soleActiveAccount", () => {
  it("is null when there is no pool account", async () => {
    for (const role of ["web_rw", "worker_rw"] as const) {
      expect(await as(role, (tx) => capacityRepo(tx).soleActiveAccount())).toBeNull();
    }
  });

  it("is the id of the one active account, whatever its tier, as web_rw and worker_rw", async () => {
    for (const tier of ["new", "trusted"]) {
      await resetCapacity(t.pool);
      await seedPool(t.pool, { id: P1, tier, cells: [] });
      for (const role of ["web_rw", "worker_rw"] as const) {
        expect(await as(role, (tx) => capacityRepo(tx).soleActiveAccount()), tier).toBe(P1);
      }
    }
  });

  it("ignores disabled accounts: one active next to a disabled one is still the sole one", async () => {
    await seedPool(t.pool, { id: P1, tier: "trusted", cells: [] });
    await seedPool(t.pool, { id: P3, tier: "new", status: "disabled", cells: [] });
    expect(await as("web_rw", (tx) => capacityRepo(tx).soleActiveAccount())).toBe(P1);
  });

  it("is null (fail closed) with two active accounts, and when the only account is disabled", async () => {
    await seedPool(t.pool, { id: P1, tier: "new", cells: [] });
    await seedPool(t.pool, { id: P2, tier: "trusted", cells: [] });
    expect(await as("web_rw", (tx) => capacityRepo(tx).soleActiveAccount())).toBeNull();
    await resetCapacity(t.pool);
    await seedPool(t.pool, { id: P3, tier: "new", status: "disabled", cells: [] });
    expect(await as("web_rw", (tx) => capacityRepo(tx).soleActiveAccount())).toBeNull();
  });
});
