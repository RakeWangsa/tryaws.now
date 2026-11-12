// WP5-T3 proof: customer A cannot read customer B's metrics. Real PostgreSQL with the grants of
// worker_rw, the real tenant check (loadReadTarget), the real reader and the invocation entry; only
// Lightsail is a fake source that holds a different series for each instance and records every call.
import { createManualClock, type LogEvent } from "@tc/core";
import type { LiveReadSource } from "@tc/aws";
import { loadReadTarget } from "@tc/db";
import {
  insertRow,
  newAdmin,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createReader } from "../handler";
import { createInvoke } from "../invoke";
import { NOW } from "./kit";

const t = useTempDatabase();

const world = {} as {
  a: string;
  b: string;
  resA: string;
  resB: string;
  admin: string;
  ghost: string;
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
  // Both customers live in the same pool account and Region, as in production.
  world.resA = await newResource(t.pool, world.a, placed);
  world.resB = await newResource(t.pool, world.b, placed);
  world.admin = await newAdmin(t.pool, "support");
  world.ghost = "00000000-0000-4000-8000-000000000000";
});

function build() {
  const seen: string[] = [];
  const logged: LogEvent[] = [];
  const source: LiveReadSource = {
    instanceState: async (target) => {
      seen.push(`state:${target.instanceName}`);
      return { state: "running" };
    },
    instanceMetrics: async (target) => {
      seen.push(`metrics:${target.instanceName}`);
      // The series carries the instance name, so any crossing shows in the answer.
      return [
        {
          metric: "cpu",
          unit: "percent",
          points: [{ at: NOW.toISOString(), value: target.instanceName.length }],
        },
      ];
    },
    transferUsed: async (target) => {
      seen.push(`transfer:${target.instanceName}`);
      return { bytes: 1, days: 30 };
    },
  };
  const reader = createReader({
    loadTarget: (caller, id) =>
      runTransaction(t.db, (tx) => loadReadTarget(tx, caller, id), { role: "worker_rw" }),
    source,
    clock: createManualClock(NOW),
    log: (e) => logged.push(e),
  });
  return { reader, invoke: createInvoke(reader), seen, logged };
}

describe("WP5-T3: customer A cannot read customer B's metrics", () => {
  it("each customer reads its own metrics, state and transfer", async () => {
    const { reader, seen } = build();
    expect((await reader.metrics(world.resA, { customerId: world.a }, "1h")).ok).toBe(true);
    expect((await reader.describe(world.resB, { customerId: world.b })).ok).toBe(true);
    expect(seen).toHaveLength(3);
  });

  it("A asking for B's resource gets the answer for a missing id, in all three reads, and AWS is not asked", async () => {
    const { reader, invoke, seen } = build();
    const A = { customerId: world.a };
    for (const range of ["1h", "1d", "1w"] as const) {
      const foreign = await reader.metrics(world.resB, A, range);
      const missing = await reader.metrics(world.ghost, A, range);
      expect(foreign).toEqual({ ok: false, error: "not_found" });
      expect(foreign).toEqual(missing);
    }
    expect(await reader.describe(world.resB, A)).toEqual(await reader.describe(world.ghost, A));
    const viaEvent = await invoke(
      {
        action: "metrics",
        resourceId: world.resB,
        caller: A,
        range: "1h",
      },
      "web",
    );
    expect(viaEvent).toEqual({ ok: false, error: "not_found" });
    expect(seen).toEqual([]);
  });

  it("the other way round is closed too, and a caller id that is not a customer's gets nothing", async () => {
    const { reader, seen } = build();
    expect(await reader.metrics(world.resA, { customerId: world.b }, "1h")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await reader.metrics(world.resA, { customerId: world.ghost }, "1h")).toEqual({
      ok: false,
      error: "not_found",
    });
    // A customer id passed as an admin id is not an admin.
    expect(await reader.metrics(world.resA, { adminId: world.b }, "1h")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(seen).toEqual([]);
  });

  it("an active admin reads any resource; a disabled admin reads nothing", async () => {
    const { reader } = build();
    expect((await reader.metrics(world.resB, { adminId: world.admin }, "1h")).ok).toBe(true);
    await t.pool.query("update admin_users set status = 'disabled' where id = $1", [world.admin]);
    expect(await reader.metrics(world.resB, { adminId: world.admin }, "1h")).toEqual({
      ok: false,
      error: "not_found",
    });
    await t.pool.query("update admin_users set status = 'active' where id = $1", [world.admin]);
  });

  it("writes nothing to the database and logs no id, account or ARN", async () => {
    const before = (await t.pool.query("select count(*)::int as n from resources")).rows[0].n;
    const { reader, logged } = build();
    await reader.metrics(world.resA, { customerId: world.a }, "1h");
    await reader.metrics(world.resB, { customerId: world.a }, "1h");
    const after = (await t.pool.query("select count(*)::int as n from resources")).rows[0].n;
    expect(after).toBe(before);
    const text = JSON.stringify(logged);
    for (const secret of [world.a, world.b, world.resA, world.resB, "210987654321", "arn:"]) {
      expect(text).not.toContain(secret);
    }
  });
});
