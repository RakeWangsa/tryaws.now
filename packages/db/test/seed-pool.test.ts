import { beforeEach, describe, expect, it } from "vitest";
import { QUOTA_CODES } from "../schema/provisioning";
import {
  DEFAULT_LIMITS,
  LAUNCH_REGIONS,
  planPoolSeed,
  seedPoolAccount,
  type SeedPoolInput,
  type SeedQuery,
} from "../seed-pool";
import { resetCapacity } from "../testing/capacity";
import { useTempDatabase } from "./temp-db";

// WPU-G1 (P1, P2, P5): the idempotent registration of the single pool account. Placeholder ids only.
const t = useTempDatabase();
const ACCOUNT = "111111111111";
const input = (over: Partial<SeedPoolInput> = {}): SeedPoolInput => ({
  stage: "local",
  awsAccountId: ACCOUNT,
  externalId: "tc-ext-placeholder-1",
  name: "tc-pool-one",
  tier: "new",
  ...over,
});
// One connection, so that begin and commit belong together.
async function run<T>(fn: (query: SeedQuery) => Promise<T>): Promise<T> {
  const client = await t.pool.connect();
  try {
    return await fn((sql, params) => client.query(sql, params as unknown[]));
  } finally {
    client.release();
  }
}
const count = async (table: string): Promise<number> =>
  (await t.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

beforeEach(async () => {
  await resetCapacity(t.pool);
});

describe("planPoolSeed (pure)", () => {
  it("plans every quota code in every launch Region, and bucket and distribution once as global", () => {
    const plan = planPoolSeed(input());
    const regional = QUOTA_CODES.filter((c) => c !== "bucket" && c !== "distribution");
    expect(plan.cells).toHaveLength(LAUNCH_REGIONS.length * regional.length + 2);
    for (const region of LAUNCH_REGIONS)
      for (const code of regional)
        expect(plan.cells, `${region}/${code}`).toContainEqual({
          region,
          quotaCode: code,
          limit: DEFAULT_LIMITS[code],
        });
    expect(
      plan.cells
        .filter((c) => c.region === "global")
        .map((c) => c.quotaCode)
        .sort(),
    ).toEqual(["bucket", "distribution"]);
    // the certificate rows of us-east-1 also serve distributions (spec 10.2)
    expect(plan.cells).toContainEqual(
      expect.objectContaining({ region: "us-east-1", quotaCode: "certificate_active" }),
    );
    expect(plan.cells).toContainEqual(
      expect.objectContaining({ region: "us-east-1", quotaCode: "certificate_365d" }),
    );
  });

  it("covers exactly the quota codes of the schema", () => {
    expect(Object.keys(DEFAULT_LIMITS).sort()).toEqual([...QUOTA_CODES].sort());
  });

  it("takes limit overrides per quota code, whole numbers from 0 up, and refuses unknown codes", () => {
    const plan = planPoolSeed(input({ limits: { instance_vcpu: 40, static_ip: 0 } }));
    expect(plan.cells).toContainEqual({
      region: "us-east-1",
      quotaCode: "instance_vcpu",
      limit: 40,
    });
    expect(plan.cells).toContainEqual({ region: "ap-south-1", quotaCode: "static_ip", limit: 0 });
    for (const bad of [
      { nope: 1 },
      { instance_vcpu: -1 },
      { instance_vcpu: 1.5 },
      { disk_gb: "9" },
    ])
      expect(() => planPoolSeed(input({ limits: bad as never })), JSON.stringify(bad)).toThrow(
        /limit/i,
      );
  });

  it("validates the account fields (fixed texts, no echo of the value)", () => {
    for (const bad of [
      { awsAccountId: "12345" },
      { awsAccountId: "12345678901a" },
      { awsAccountId: "1111111111111" },
      { externalId: "" },
      { externalId: "has space" },
      { name: "Bad Name" },
      { name: "" },
      { tier: "gold" },
      { stage: "prod" },
      { roleArn: "not an arn" },
    ]) {
      const call = () => planPoolSeed(input(bad as Partial<SeedPoolInput>));
      expect(call, JSON.stringify(bad)).toThrow(/^seed-pool: /);
    }
  });

  it("refuses production unless it is confirmed, and every stage that is not on the list", () => {
    expect(() => planPoolSeed(input({ stage: "production" }))).toThrow(/confirm/i);
    expect(planPoolSeed(input({ stage: "production", confirmProduction: true })).account.name).toBe(
      "tc-pool-one",
    );
    expect(() => planPoolSeed(input({ stage: "Production" }))).toThrow(/stage/);
    expect(() => planPoolSeed(input({ stage: undefined as never }))).toThrow(/stage/);
  });

  it("defaults the role ARN to TcProvisioner of the account and keeps no secret anywhere", () => {
    const plan = planPoolSeed(input());
    expect(plan.account.roleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/TcProvisioner`);
    expect(JSON.stringify(plan)).not.toMatch(/secret|password|key/i);
  });
});

describe("seedPoolAccount (database)", () => {
  it("registers the account active with every cell at used 0", async () => {
    const out = await run((q) => seedPoolAccount(q, input()));
    expect(out).toMatchObject({ accountCreated: true, cellsCreated: 26, cellsExisting: 0 });
    const account = (await t.pool.query("select * from pool_accounts")).rows;
    expect(account).toHaveLength(1);
    expect(account[0]).toMatchObject({
      aws_account_id: ACCOUNT,
      name: "tc-pool-one",
      tier: "new",
      status: "active",
      external_id: "tc-ext-placeholder-1",
    });
    expect(await count("pool_capacity")).toBe(26);
    const { rows } = await t.pool.query(
      "select distinct used from pool_capacity where pool_account_id = $1",
      [out.accountId],
    );
    expect(rows).toEqual([{ used: 0 }]);
    const regions = (
      await t.pool.query("select distinct region from pool_capacity order by region")
    ).rows.map((r: { region: string }) => r.region);
    expect(regions).toEqual(["ap-south-1", "ap-southeast-1", "global", "us-east-1"]);
  });

  it("is idempotent: a second run changes nothing and reports the existing rows (R7)", async () => {
    const first = await run((q) => seedPoolAccount(q, input()));
    const again = await run((q) => seedPoolAccount(q, input()));
    expect(again).toMatchObject({ accountCreated: false, cellsCreated: 0, cellsExisting: 26 });
    expect(again.accountId).toBe(first.accountId);
    expect(await count("pool_accounts")).toBe(1);
    expect(await count("pool_capacity")).toBe(26);
  });

  it("never overwrites a limit or a used count that an operator or the inventory set", async () => {
    const first = await run((q) => seedPoolAccount(q, input()));
    await t.pool.query(
      `update pool_capacity set quota_limit = 99, used = 7
        where pool_account_id = $1 and region = 'us-east-1' and quota_code = 'instance_vcpu'`,
      [first.accountId],
    );
    await run((q) => seedPoolAccount(q, input({ limits: { instance_vcpu: 1000 } })));
    const { rows } = await t.pool.query(
      `select quota_limit, used from pool_capacity
        where pool_account_id = $1 and region = 'us-east-1' and quota_code = 'instance_vcpu'`,
      [first.accountId],
    );
    expect(rows).toEqual([{ quota_limit: 99, used: 7 }]);
  });

  it("fills in only the missing cells when some exist", async () => {
    const first = await run((q) => seedPoolAccount(q, input()));
    await t.pool.query(
      "delete from pool_capacity where pool_account_id = $1 and region = 'us-east-1'",
      [first.accountId],
    );
    const again = await run((q) => seedPoolAccount(q, input()));
    expect(again).toMatchObject({ accountCreated: false, cellsCreated: 8, cellsExisting: 18 });
    expect(await count("pool_capacity")).toBe(26);
  });

  it("fails closed when the account exists with another name, external id or tier, and writes nothing", async () => {
    await run((q) => seedPoolAccount(q, input()));
    for (const other of [
      { name: "tc-pool-two" },
      { externalId: "tc-ext-placeholder-2" },
      { tier: "trusted" },
    ]) {
      await expect(
        run((q) => seedPoolAccount(q, input(other))),
        JSON.stringify(other),
      ).rejects.toThrow(/^seed-pool: .*differs/);
    }
    expect(await count("pool_accounts")).toBe(1);
  });

  it("fails closed when the name belongs to another AWS account", async () => {
    await run((q) => seedPoolAccount(q, input()));
    await expect(
      run((q) => seedPoolAccount(q, input({ awsAccountId: "222222222222" }))),
    ).rejects.toThrow(/^seed-pool: .*name/);
    expect(await count("pool_accounts")).toBe(1);
  });

  it("rolls back as a whole when a statement fails midway", async () => {
    let calls = 0;
    await expect(
      run((q) =>
        seedPoolAccount((sql, params) => {
          calls += 1;
          if (/insert into pool_capacity/.test(sql)) throw new Error("boom");
          return q(sql, params);
        }, input()),
      ),
    ).rejects.toThrow();
    expect(calls).toBeGreaterThan(1);
    expect(await count("pool_accounts")).toBe(0);
    expect(await count("pool_capacity")).toBe(0);
  });

  it("the registered account is the single active one, so every tier is served (the rule of decide)", async () => {
    await run((q) => seedPoolAccount(q, input({ tier: "trusted" })));
    const { rows } = await t.pool.query(
      "select count(*)::int as n from pool_accounts where status = 'active'",
    );
    expect(rows[0].n).toBe(1);
  });
});
