// WPU-B7 (M3) proof: customer B cannot reach customer A's server through the access-details function.
// Real PostgreSQL with the grants of worker_rw and the real wiring of deps.ts (buildAccessDetails, so the
// real loadTarget = loadReadTarget); only the transaction runner is wrapped to count the transactions.
// AWS is never reached: a foreign id ends at the tenant check, and the owner's control case ends at the
// family check, which also runs after the tenant check and before the limiter and Lightsail.
//
// Security review 2 (R8): the same proof for the other three actions, databasePassword, bucketKeyCreate
// and bucketKeyList. For each: B asks for A's resource and gets the same answer as for a missing id, in
// one transaction, no rate-limit or claim row is written for B, and the AWS functions of @tc/aws are
// never called (counted below; the real functions are still the ones that would run).
import { createManualClock } from "@tc/core";
import {
  insertRow,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAccessDetails } from "../deps";

// Counts every call into the Lightsail adapters of @tc/aws and lets the real function run.
const aws = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@tc/aws", async () => {
  const actual = await vi.importActual<typeof import("@tc/aws")>("@tc/aws");
  const counted =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      aws.calls.push(name);
      return fn(...args);
    };
  return {
    ...actual,
    fetchWindowsPassword: counted("windows_password", actual.fetchWindowsPassword),
    fetchDatabasePassword: counted("database_password", actual.fetchDatabasePassword),
    createBucketAccessKey: counted("bucket_key_create", actual.createBucketAccessKey),
    listBucketAccessKeys: counted("bucket_key_list", actual.listBucketAccessKeys),
  };
});
beforeEach(() => {
  aws.calls.length = 0;
});

const t = useTempDatabase();
const NOW = new Date("2026-11-13T05:00:00Z");
const ghost = "00000000-0000-4000-8000-000000000000";
const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000a1";
const world = {} as {
  a: string;
  b: string;
  windowsA: string;
  linuxA: string;
  databaseA: string;
  bucketA: string;
};

beforeAll(async () => {
  const pool = await insertRow(t.pool, "pool_accounts", {
    aws_account_id: "210987654321",
    name: "tc-pool-" + uniqueSuffix(),
    tier: "dev",
    role_arn: "arn:aws:iam::210987654321:role/TcProvisioner",
    external_id: "ext-" + uniqueSuffix(),
    status: "active",
  });
  world.a = await newCustomer(t.pool);
  world.b = await newCustomer(t.pool);
  const placed = { pool_account_id: pool, region: "ap-southeast-1", state: "active" };
  world.windowsA = await newResource(t.pool, world.a, { ...placed, family: "windows_instance" });
  world.linuxA = await newResource(t.pool, world.a, placed);
  world.databaseA = await newResource(t.pool, world.a, { ...placed, family: "database" });
  world.bucketA = await newResource(t.pool, world.a, { ...placed, family: "bucket" });
});

// Rows that the rate limiter or the request claim wrote for a customer (scope keys hold the id).
async function limiterRowsOf(customerId: string): Promise<number> {
  const found = await t.pool.query(
    "select count(*)::int as n from rate_limits where scope_key like $1",
    [`%${customerId}%`],
  );
  return Number(found.rows[0].n);
}

function build() {
  let transactions = 0;
  const logs: unknown[] = [];
  const built = buildAccessDetails({
    clock: createManualClock(NOW),
    runTx: (fn) => {
      transactions += 1;
      return runTransaction(t.db, fn, { role: "worker_rw" });
    },
    log: (e) => logs.push(e),
  });
  return { ...built, count: () => transactions, logs };
}

describe("WPU-B7 M3: loadTarget of the access-details function, customer B against customer A", () => {
  it("answers B asking for A's server exactly as a missing id, in one transaction (the tenant read)", async () => {
    const { access, count } = build();
    const foreign = await access.windowsPassword(world.windowsA, { customerId: world.b });
    expect(count()).toBe(1);
    const missing = await access.windowsPassword(ghost, { customerId: world.b });
    expect(count()).toBe(2);
    expect(foreign).toEqual({ ok: false, error: "not_found" });
    expect(missing).toEqual(foreign);
  });

  it("does the same through the invocation entry", async () => {
    const { handler, count } = build();
    const viaEvent = await handler(
      {
        action: "windows_password",
        resourceId: world.windowsA,
        caller: { customerId: world.b },
      },
      "web",
    );
    expect(viaEvent).toEqual({ ok: false, error: "not_found" });
    expect(count()).toBe(1);
  });

  it("control: the owner passes the tenant read (a family refusal, not not_found) and no limiter runs", async () => {
    const { access, count } = build();
    const own = await access.windowsPassword(world.linuxA, { customerId: world.a });
    expect(own).toEqual({ ok: false, error: "validation" });
    expect(count()).toBe(1);
  });

  it("logs fixed words only", async () => {
    const { access, logs } = build();
    await access.windowsPassword(world.windowsA, { customerId: world.b });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(world.windowsA);
    expect(text).not.toContain(world.b);
  });
});

// Security review 2, R8: the other three actions. `ask` is one call of the action for a resource id.
type Ask = (
  access: ReturnType<typeof build>["access"],
  resourceId: string,
  customerId: string,
) => Promise<unknown>;
const ACTIONS: readonly (readonly [string, Ask, () => string])[] = [
  [
    "databasePassword",
    (access, id, customerId) => access.databasePassword(id, { customerId }),
    () => world.databaseA,
  ],
  [
    "bucketKeyCreate",
    (access, id, customerId) => access.bucketKeyCreate(id, REQUEST_ID, { customerId }),
    () => world.bucketA,
  ],
  [
    "bucketKeyList",
    (access, id, customerId) => access.bucketKeyList(id, { customerId }),
    () => world.bucketA,
  ],
];

describe.each(ACTIONS)("R8: %s, customer B against customer A", (_name, ask, resourceOfA) => {
  it("answers B asking for A's resource exactly as a missing id, in one transaction (the tenant read)", async () => {
    const { access, count } = build();
    const foreign = await ask(access, resourceOfA(), world.b);
    expect(count()).toBe(1);
    const missing = await ask(access, ghost, world.b);
    expect(count()).toBe(2);
    expect(foreign).toEqual({ ok: false, error: "not_found" });
    expect(missing).toEqual(foreign);
  });

  it("never reaches AWS and writes no limiter, claim or audit row for B", async () => {
    const { access } = build();
    await ask(access, resourceOfA(), world.b);
    await ask(access, ghost, world.b);
    expect(aws.calls).toEqual([]);
    expect(await limiterRowsOf(world.b)).toBe(0);
    const audits = await t.pool.query(
      "select count(*)::int as n from audit_log where actor_id = $1",
      [world.b],
    );
    expect(Number(audits.rows[0].n)).toBe(0);
  });

  it("control: the owner passes the tenant read and ends at the family check, with no AWS call and no limiter", async () => {
    const { access, count } = build();
    // A's Linux server is the wrong family for all three actions: validation, not not_found.
    expect(await ask(access, world.linuxA, world.a)).toEqual({ ok: false, error: "validation" });
    expect(count()).toBe(1);
    expect(aws.calls).toEqual([]);
    expect(await limiterRowsOf(world.a)).toBe(0);
  });

  it("logs fixed words only", async () => {
    const { access, logs } = build();
    await ask(access, resourceOfA(), world.b);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(resourceOfA());
    expect(text).not.toContain(world.b);
  });
});

describe("R8: the same three actions through the invocation entry", () => {
  it("answer B asking for A's resource as not_found, in one transaction each", async () => {
    const events = [
      { action: "database_password", resourceId: world.databaseA },
      { action: "bucket_key_create", resourceId: world.bucketA, requestId: REQUEST_ID },
      { action: "bucket_key_list", resourceId: world.bucketA },
    ];
    for (const event of events) {
      const { handler, count } = build();
      const out = await handler({ ...event, caller: { customerId: world.b } }, "web");
      expect(out, event.action).toEqual({ ok: false, error: "not_found" });
      expect(count(), event.action).toBe(1);
    }
    expect(aws.calls).toEqual([]);
  });
});
