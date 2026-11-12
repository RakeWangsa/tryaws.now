// WPU-B7 (M3) proof: customer B cannot reach customer A's server through the access-details function.
// Real PostgreSQL with the grants of worker_rw and the real wiring of deps.ts (buildAccessDetails, so the
// real loadTarget = loadReadTarget); only the transaction runner is wrapped to count the transactions.
// AWS is never reached: a foreign id ends at the tenant check, and the owner's control case ends at the
// family check, which also runs after the tenant check and before the limiter and Lightsail.
import { createManualClock } from "@tc/core";
import {
  insertRow,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAccessDetails } from "../deps";

const t = useTempDatabase();
const NOW = new Date("2026-11-13T05:00:00Z");
const ghost = "00000000-0000-4000-8000-000000000000";
const world = {} as { a: string; b: string; windowsA: string; linuxA: string };

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
});

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
