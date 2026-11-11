import { beforeEach, describe, expect, it } from "vitest";
import { capacityRepo } from "../repositories/capacity";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import type { PoolAccountInput } from "../repositories/admin/capacity";
import { readUsed, resetCapacity, seedPool } from "../testing/capacity";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin, newPoolAccount } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const REGION = "ap-southeast-1";
const actor = async (): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, "ops"),
  role: "ops",
  ip: "203.0.113.9",
  userAgent: "test",
});
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const count = async (table: string) =>
  (await t.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;
const N1: PoolAccountInput = {
  awsAccountId: "123456789012",
  name: "tc-pool-n1",
  tier: "new",
  roleArn: "arn:aws:iam::123456789012:role/TcProvisioner",
  externalId: "ext-n1",
  limits: [
    { region: REGION, quotaCode: "instance_vcpu", limit: 20 },
    { region: REGION, quotaCode: "static_ip", limit: 5 },
    { region: "global", quotaCode: "bucket", limit: 20 },
  ],
};

beforeEach(async () => {
  await ensureMarket(t.pool);
  await resetCapacity(t.pool);
});

describe("capacity.addPoolAccount", () => {
  it("adds the account and its limits, and writes one audit row without the AWS account", async () => {
    const a = await actor();
    expect(
      await asAdmin(a, (r) => r.capacity.addPoolAccount(N1, "first launch pool")),
    ).toMatchObject({
      ok: true,
      replayed: false,
      value: { name: "tc-pool-n1", tier: "new", status: "active" },
    });
    expect(
      (
        await t.pool.query(
          "select region, quota_code, quota_limit, used from pool_capacity order by region, quota_code",
        )
      ).rows,
    ).toEqual([
      { region: "ap-southeast-1", quota_code: "instance_vcpu", quota_limit: 20, used: 0 },
      { region: "ap-southeast-1", quota_code: "static_ip", quota_limit: 5, used: 0 },
      { region: "global", quota_code: "bucket", quota_limit: 20, used: 0 },
    ]);
    const audit = await auditRowsOf(t.pool, a.adminId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "pool_account.add",
      target_type: "pool_account",
      ip: "203.0.113.9",
      user_agent: "test",
    });
    expect(audit[0]!.metadata.reason).toBe("first launch pool");
    expect(JSON.stringify(audit[0]!.metadata)).not.toMatch(/123456789012|ext-n1|TcProvisioner/);
  });
  it("answers a replay for the same name, and conflict for an AWS account that has another name", async () => {
    const a = await actor();
    await asAdmin(a, (r) => r.capacity.addPoolAccount(N1, "first"));
    expect(await asAdmin(a, (r) => r.capacity.addPoolAccount(N1, "again"))).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect([await count("pool_accounts"), await count("pool_capacity")]).toEqual([1, 3]);
    expect(
      await asAdmin(a, (r) =>
        r.capacity.addPoolAccount({ ...N1, name: "tc-pool-n2" }, "wrong name"),
      ),
    ).toEqual({ ok: false, error: "conflict" });
    expect(await count("pool_accounts")).toBe(1);
    expect(await auditRowsOf(t.pool, a.adminId)).toHaveLength(2);
  });
  it.each<[string, Partial<PoolAccountInput>]>([
    ["a name outside tc-pool-", { name: "n1" }],
    ["an unknown tier", { tier: "gold" as never }],
    ["an unknown status", { status: "paused" as never }],
    ["an AWS account id of 11 digits", { awsAccountId: "12345678901" }],
    ["a role of another account", { roleArn: "arn:aws:iam::999999999999:role/TcProvisioner" }],
    ["a negative limit", { limits: [{ region: REGION, quotaCode: "static_ip", limit: -1 }] }],
    ["a fractional limit", { limits: [{ region: REGION, quotaCode: "static_ip", limit: 1.5 }] }],
    ["a bucket row on a Region", { limits: [{ region: REGION, quotaCode: "bucket", limit: 20 }] }],
    [
      "a static IP row on global",
      { limits: [{ region: "global", quotaCode: "static_ip", limit: 5 }] },
    ],
    [
      "the same cell twice",
      {
        limits: [
          { region: REGION, quotaCode: "static_ip", limit: 5 },
          { region: REGION, quotaCode: "static_ip", limit: 6 },
        ],
      },
    ],
  ])("refuses %s and writes nothing", async (_, over) => {
    const a = await actor();
    expect(await asAdmin(a, (r) => r.capacity.addPoolAccount({ ...N1, ...over }, "x"))).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await asAdmin(a, (r) => r.capacity.addPoolAccount(N1, "  "))).toEqual({
      ok: false,
      error: "validation",
    });
    expect([
      await count("pool_accounts"),
      await count("pool_capacity"),
      (await auditRowsOf(t.pool, a.adminId)).length,
    ]).toEqual([0, 0, 0]);
  });
  it("gives one account, one replay and one set of limits when the same call arrives twice at the same moment", async () => {
    const [a1, a2] = [await actor(), await actor()];
    const both = await Promise.all(
      [a1, a2].map((a) => asAdmin(a, (r) => r.capacity.addPoolAccount(N1, "launch pool"))),
    );
    expect(both.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    expect([await count("pool_accounts"), await count("pool_capacity")]).toEqual([1, 3]);
  });
  it("answers conflict, and changes nothing, for the same name with another tier, status or limit", async () => {
    const a = await actor();
    await asAdmin(a, (r) => r.capacity.addPoolAccount(N1, "first"));
    for (const over of [
      { tier: "trusted" },
      { status: "disabled" },
      { limits: [{ region: REGION, quotaCode: "static_ip", limit: 1 }] },
    ] as Partial<PoolAccountInput>[]) {
      expect(
        await asAdmin(a, (r) => r.capacity.addPoolAccount({ ...N1, ...over }, "again")),
      ).toEqual({ ok: false, error: "conflict" });
    }
    expect((await t.pool.query("select tier, status from pool_accounts")).rows).toEqual([
      { tier: "new", status: "active" },
    ]);
    expect(
      (await t.pool.query("select quota_limit from pool_capacity where quota_code = 'static_ip'"))
        .rows,
    ).toEqual([{ quota_limit: 5 }]);
    expect(await auditRowsOf(t.pool, a.adminId)).toHaveLength(1);
  });
  it("refuses a role other than TcProvisioner", async () => {
    const a = await actor();
    expect(
      await asAdmin(a, (r) =>
        r.capacity.addPoolAccount({ ...N1, roleArn: "arn:aws:iam::123456789012:role/Other" }, "x"),
      ),
    ).toEqual({ ok: false, error: "validation" });
    expect(await count("pool_accounts")).toBe(0);
  });
});

describe("capacity.setLimit", () => {
  it("creates a missing row, changes a limit and keeps used, and flags a limit below used", async () => {
    const a = await actor();
    const pool = await seedPool(t.pool, {
      cells: [{ region: REGION, quotaCode: "static_ip", limit: 5, used: 4 }],
    });
    const set = (limit: number, quotaCode: "static_ip" | "disk_gb" = "static_ip") =>
      asAdmin(a, (r) =>
        r.capacity.setLimit(
          { poolAccountId: pool.poolAccountId, region: REGION, quotaCode, limit },
          "quota raised by AWS",
        ),
      );
    expect(await set(10)).toMatchObject({
      ok: true,
      replayed: false,
      value: { limit: 10, used: 4, overCommitted: false },
    });
    expect(await set(3)).toMatchObject({
      ok: true,
      value: { limit: 3, used: 4, overCommitted: true },
    });
    expect(await set(3)).toMatchObject({ ok: true, replayed: true });
    expect(await set(40, "disk_gb")).toMatchObject({
      ok: true,
      replayed: false,
      value: { limit: 40, used: 0 },
    });
    expect(await readUsed(t.pool, pool.poolAccountId)).toEqual({
      [`${REGION}/disk_gb`]: 0,
      [`${REGION}/static_ip`]: 4,
    });
    expect((await auditRowsOf(t.pool, a.adminId)).map((x) => x.metadata)).toEqual([
      { reason: "quota raised by AWS", before: { limit: 5 }, after: { limit: 10 } },
      { reason: "quota raised by AWS", before: { limit: 10 }, after: { limit: 3 } },
      { reason: "quota raised by AWS", before: { limit: 3 }, after: { limit: 3 } },
      { reason: "quota raised by AWS", before: null, after: { limit: 40 } },
    ]);
  });
  it("answers not_found for an unknown account and validation for a bad cell, with no audit row", async () => {
    const a = await actor();
    const pool = await newPoolAccount(t.pool);
    const set = (over: Record<string, unknown>) =>
      asAdmin(a, (r) =>
        r.capacity.setLimit(
          {
            poolAccountId: pool,
            region: REGION,
            quotaCode: "static_ip",
            limit: 5,
            ...over,
          } as never,
          "x",
        ),
      );
    expect(await set({ poolAccountId: "00000000-0000-7000-8000-0000000000ff" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await set({ quotaCode: "bucket" })).toEqual({ ok: false, error: "validation" });
    expect(await set({ limit: -1 })).toEqual({ ok: false, error: "validation" });
    expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
  });
});

describe("capacity.setReserve and list", () => {
  it("stores the reserve where the purchase reads it, and shows it in the list", async () => {
    const a = await actor();
    const pool = await seedPool(t.pool, {
      cells: [{ region: REGION, quotaCode: "instance_vcpu", limit: 20, used: 3 }],
    });
    expect(
      await asAdmin(a, (r) =>
        r.capacity.setReserve(
          { market: "BD", quotaCode: "instance_vcpu", reserve: 2 },
          "keep two vCPUs",
        ),
      ),
    ).toMatchObject({ ok: true, replayed: false });
    expect(
      await asAdmin(a, (r) =>
        r.capacity.setReserve({ market: "BD", quotaCode: "instance_vcpu", reserve: 2 }, "again"),
      ),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await runTransaction(t.db, (tx) => capacityRepo(tx).readReserves("BD"), {
        role: "web_rw",
      }),
    ).toEqual(new Map([["instance_vcpu", 2]]));
    expect(await asAdmin(a, (r) => r.capacity.list("BD"))).toEqual([
      {
        poolAccountId: pool.poolAccountId,
        poolName: expect.stringMatching(/^tc-pool-/),
        tier: "new",
        status: "active",
        region: REGION,
        quotaCode: "instance_vcpu",
        limit: 20,
        used: 3,
        reserve: 2,
        checkedAt: null,
      },
    ]);
    expect((await auditRowsOf(t.pool, a.adminId)).map((x) => x.metadata)).toEqual([
      { reason: "keep two vCPUs", before: null, after: { reserve: 2 } },
      { reason: "again", before: { reserve: 2 }, after: { reserve: 2 } },
    ]);
  });
  it("refuses an unknown market and a bad value", async () => {
    const a = await actor();
    expect(
      await asAdmin(a, (r) =>
        r.capacity.setReserve({ market: "XX", quotaCode: "static_ip", reserve: 1 }, "x"),
      ),
    ).toEqual({ ok: false, error: "not_found" });
    for (const reserve of [-1, 1.5, 2_000_000]) {
      expect(
        await asAdmin(a, (r) =>
          r.capacity.setReserve({ market: "BD", quotaCode: "static_ip", reserve }, "x"),
        ),
      ).toEqual({ ok: false, error: "validation" });
    }
    expect(
      (await t.pool.query("select count(*)::int as n from settings where key like 'capacity.%'"))
        .rows[0].n,
    ).toBe(0);
  });
});
