import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { loadReadTarget } from "../operations/reader";
import { runTransaction } from "../tx";
import { insertRow } from "./sql";
import { newAdmin, newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });

const ghost = "00000000-0000-4000-8000-000000000000";
let customerA = "";
let customerB = "";
let resourceA = "";
let unplacedA = "";
let adminActive = "";
let adminDisabled = "";
const AWS_ACCOUNT = "123456789012";

beforeAll(async () => {
  const poolId = await insertRow(t.pool, "pool_accounts", {
    aws_account_id: AWS_ACCOUNT,
    name: "tc-pool-" + uniqueSuffix(),
    tier: "dev",
    role_arn: `arn:aws:iam::${AWS_ACCOUNT}:role/TcProvisioner`,
    external_id: "ext-" + uniqueSuffix(),
    status: "active",
  });
  customerA = await newCustomer(t.pool);
  customerB = await newCustomer(t.pool);
  resourceA = await newResource(t.pool, customerA, {
    pool_account_id: poolId,
    region: "ap-southeast-1",
    aws_name:
      "tc-instance-" +
      uniqueSuffix()
        .replace(/[^a-f0-9]/g, "a")
        .padEnd(16, "a")
        .slice(0, 16),
  });
  unplacedA = await newResource(t.pool, customerA);
  adminActive = await newAdmin(t.pool, "support");
  adminDisabled = await newAdmin(t.pool, "support");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [adminDisabled]);
});

describe("loadReadTarget", () => {
  it("gives the owner the placed resource, with the pool account the reader needs", async () => {
    const got = await worker((tx) => loadReadTarget(tx, { customerId: customerA }, resourceA));
    expect(got).not.toBeNull();
    expect(got!.resource.id).toBe(resourceA);
    expect(got!.account.awsAccountId).toBe(AWS_ACCOUNT);
    expect(got!.account.externalId).toMatch(/^ext-/);
    expect(got!.region).toBe("ap-southeast-1");
  });

  it("answers another customer exactly as it answers a missing id (R8)", async () => {
    const foreign = await worker((tx) => loadReadTarget(tx, { customerId: customerB }, resourceA));
    const missing = await worker((tx) => loadReadTarget(tx, { customerId: customerB }, ghost));
    expect(foreign).toBeNull();
    expect(missing).toBeNull();
  });

  it("returns null for an id that is not a UUID and for a caller id that is not a UUID", async () => {
    expect(await worker((tx) => loadReadTarget(tx, { customerId: customerA }, "nope"))).toBeNull();
    expect(await worker((tx) => loadReadTarget(tx, { customerId: "nope" }, resourceA))).toBeNull();
  });

  it("returns null for a resource that is not placed in a pool account", async () => {
    expect(
      await worker((tx) => loadReadTarget(tx, { customerId: customerA }, unplacedA)),
    ).toBeNull();
  });

  it("lets an active admin read any placed resource and refuses a disabled or unknown admin", async () => {
    const ok = await worker((tx) => loadReadTarget(tx, { adminId: adminActive }, resourceA));
    expect(ok?.resource.id).toBe(resourceA);
    expect(
      await worker((tx) => loadReadTarget(tx, { adminId: adminDisabled }, resourceA)),
    ).toBeNull();
    expect(await worker((tx) => loadReadTarget(tx, { adminId: ghost }, resourceA))).toBeNull();
  });

  it("refuses a caller that holds both or neither identity (R16)", async () => {
    const both = { customerId: customerA, adminId: adminActive } as never;
    expect(await worker((tx) => loadReadTarget(tx, both, resourceA))).toBeNull();
    expect(await worker((tx) => loadReadTarget(tx, {} as never, resourceA))).toBeNull();
  });
});
