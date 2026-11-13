import { AwsError } from "@tc/aws";
import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  CUSTOMER_A,
  CUSTOMER_B,
  DB_A,
  DB_B,
  EXTERNAL_ID,
  GHOST,
  LB_A,
  LB_B,
  POOL_ACCOUNT,
  RESOURCE_A,
  RESOURCE_B,
  SERVER_1,
  SERVER_2,
  fakeSource,
  setup,
  target,
} from "./test/kit";

const A = { customerId: CUSTOMER_A };
const B = { customerId: CUSTOMER_B };

function noLeak(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(POOL_ACCOUNT);
  expect(text).not.toContain(EXTERNAL_ID);
  expect(text).not.toMatch(/arn:/);
  expect(text).not.toContain("tc-instance-");
}

describe("describe", () => {
  it("gives the owner the live state and the transfer used", async () => {
    const { reader, calls } = setup();
    const got = await reader.describe(RESOURCE_A, A);
    expect(got).toEqual({
      ok: true,
      value: {
        resourceId: RESOURCE_A,
        state: "running",
        transfer: { bytes: 1234, days: 30 },
      },
    });
    expect(calls.map((c) => c.op)).toEqual(["state", "transfer"]);
    // The AWS name is generated from the id (R11), never taken from a request.
    expect(calls[0]!.target.instanceName).toBe(awsResourceName("instance", RESOURCE_A));
    noLeak(got);
  });

  it("answers another customer exactly as it answers a missing id, and calls nothing (R8)", async () => {
    const { reader, calls } = setup();
    const foreign = await reader.describe(RESOURCE_A, B);
    const missing = await reader.describe(GHOST, B);
    expect(foreign).toEqual({ ok: false, error: "not_found" });
    expect(foreign).toEqual(missing);
    expect(calls).toEqual([]);
  });

  it("does not call AWS for a resource that is not live in the database", async () => {
    const { reader, calls } = setup(
      {},
      { [RESOURCE_A]: { owner: CUSTOMER_A, target: target(RESOURCE_A, "destroyed") } },
    );
    expect(await reader.describe(RESOURCE_A, A)).toEqual({
      ok: true,
      value: { resourceId: RESOURCE_A, state: "destroyed", transfer: null },
    });
    expect(calls).toEqual([]);
  });

  it("refuses a family the reader cannot read yet (R16)", async () => {
    const { reader, calls } = setup(
      {},
      { [RESOURCE_A]: { owner: CUSTOMER_A, target: target(RESOURCE_A, "active", "bucket") } },
    );
    expect(await reader.describe(RESOURCE_A, A)).toEqual({ ok: false, error: "validation" });
    expect(calls).toEqual([]);
  });
});

describe("metrics", () => {
  it("gives the owner the series of the asked range", async () => {
    const { reader, calls } = setup();
    const got = await reader.metrics(RESOURCE_A, A, "1d");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.range).toBe("1d");
      expect(got.value.series[0]!.metric).toBe("cpu");
    }
    expect(calls.map((c) => c.op)).toEqual(["metrics"]);
    noLeak(got);
  });

  it("customer A cannot read customer B's metrics: the answer is the answer for a missing id", async () => {
    const { reader, calls } = setup();
    for (const range of ["1h", "1d", "1w"] as const) {
      const foreign = await reader.metrics(RESOURCE_B, A, range);
      const missing = await reader.metrics(GHOST, A, range);
      expect(foreign).toEqual({ ok: false, error: "not_found" });
      expect(foreign).toEqual(missing);
    }
    expect(calls).toEqual([]);
  });

  it("answers not_found, not validation, for a bad range on a resource of another customer", async () => {
    const { reader } = setup();
    expect(await reader.metrics(RESOURCE_B, A, "1y" as never)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await reader.metrics(RESOURCE_A, A, "1y" as never)).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await reader.metrics(RESOURCE_A, A, undefined as never)).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await reader.metrics(RESOURCE_A, A, "__proto__" as never)).toEqual({
      ok: false,
      error: "validation",
    });
  });
});

describe("caller", () => {
  it("refuses a caller with both identities, neither, or a non-string id, before any lookup (R9, R16)", async () => {
    const { reader, loads } = setup();
    const bad: unknown[] = [
      { customerId: CUSTOMER_A, adminId: ADMIN },
      {},
      null,
      undefined,
      "x",
      { customerId: 5 },
      { adminId: "" },
    ];
    for (const caller of bad) {
      expect(await reader.describe(RESOURCE_A, caller as never)).toEqual({
        ok: false,
        error: "unauthenticated",
      });
      expect(await reader.metrics(RESOURCE_A, caller as never, "1h")).toEqual({
        ok: false,
        error: "unauthenticated",
      });
    }
    expect(loads).toEqual([]);
  });

  it("lets an active admin read any resource and refuses an unknown admin like a missing resource", async () => {
    const { reader } = setup();
    expect((await reader.describe(RESOURCE_B, { adminId: ADMIN })).ok).toBe(true);
    expect(await reader.describe(RESOURCE_B, { adminId: GHOST })).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("failures", () => {
  it("maps an AwsError to a platform code and never shows AWS text (R3, R14, R16)", async () => {
    const cases: [AwsError, string][] = [
      [new AwsError({ code: "rate_limited", retryable: true }), "rate_limited"],
      [new AwsError({ code: "upstream_unavailable", retryable: true }), "upstream_unavailable"],
      [new AwsError({ code: "forbidden", retryable: true }), "upstream_unavailable"],
      [new AwsError({ code: "unauthenticated", retryable: true }), "upstream_unavailable"],
      [new AwsError({ code: "validation", retryable: false }), "internal"],
      [new AwsError({ code: "not_found", retryable: true }), "not_found"],
    ];
    for (const [error, expected] of cases) {
      const { source } = fakeSource({
        instanceMetrics: async () => {
          throw error;
        },
      });
      const { reader, logged } = setup({ source });
      const got = await reader.metrics(RESOURCE_A, A, "1h");
      expect(got).toEqual({ ok: false, error: expected });
      noLeak([got, logged]);
    }
  });

  it("fails closed on an error of any other kind, with no text of it", async () => {
    const { source } = fakeSource({
      instanceState: async () => {
        throw new Error(`boom arn:aws:iam::${POOL_ACCOUNT}:role/TcReader ${EXTERNAL_ID}`);
      },
    });
    const { reader, logged } = setup({ source });
    const got = await reader.describe(RESOURCE_A, A);
    expect(got).toEqual({ ok: false, error: "internal" });
    noLeak([got, logged]);
  });

  it("fails closed when the lookup itself throws", async () => {
    const { reader, calls } = setup({
      loadTarget: async () => {
        throw new Error("db down");
      },
    });
    expect(await reader.describe(RESOURCE_A, A)).toEqual({ ok: false, error: "internal" });
    expect(calls).toEqual([]);
  });
});

describe("rate limit and audit", () => {
  it("limits one caller, not the others, and calls AWS no more once the limit is hit", async () => {
    const { reader, calls, clock } = setup({ rateLimit: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await reader.metrics(RESOURCE_A, A, "1h")).ok).toBe(true);
    expect(await reader.metrics(RESOURCE_A, A, "1h")).toEqual({ ok: false, error: "rate_limited" });
    expect(calls).toHaveLength(3);
    // Another customer has its own window.
    expect((await reader.metrics(RESOURCE_B, B, "1h")).ok).toBe(true);
    // The window moves on.
    clock.advance(61);
    expect((await reader.metrics(RESOURCE_A, A, "1h")).ok).toBe(true);
  });

  it("logs the action, the caller kind and the outcome, and nothing else of the caller (R14)", async () => {
    const { reader, logged } = setup();
    await reader.metrics(RESOURCE_A, A, "1h");
    await reader.describe(RESOURCE_B, A);
    expect(logged).toEqual([
      { event: "reader_read", action: "metrics", callerKind: "customer", outcome: "ok" },
      { event: "reader_read", action: "describe", callerKind: "customer", outcome: "not_found" },
    ]);
    expect(JSON.stringify(logged)).not.toContain(CUSTOMER_A);
  });
});

describe("targetHealth (WPU-Y8)", () => {
  it("gives the owner the health of the recorded servers, by platform id, with counts", async () => {
    const { reader, calls, logged } = setup();
    const got = await reader.targetHealth(LB_A, A);
    expect(got).toEqual({
      ok: true,
      value: {
        resourceId: LB_A,
        live: true,
        checkedAt: "2026-11-11T10:00:00.000Z",
        targets: [
          { targetResourceId: SERVER_1, health: "healthy", reason: null },
          { targetResourceId: SERVER_2, health: "healthy", reason: null },
        ],
        counts: { healthy: 2, unhealthy: 0, initial: 0, unused: 0, draining: 0, unavailable: 0 },
        unresolved: 1,
      },
    });
    expect(calls.map((c) => c.op)).toEqual(["health"]);
    expect((calls[0]!.target as unknown as { loadBalancerName: string }).loadBalancerName).toBe(
      awsResourceName("lb", LB_A),
    );
    expect(logged).toEqual([
      { event: "reader_read", action: "target_health", callerKind: "customer", outcome: "ok" },
    ]);
    expect(JSON.stringify([got, logged])).not.toMatch(/tc-(lb|instance)-|arn:|210987654321/);
  });

  it("passes only the recorded servers' names to the source", async () => {
    let known: ReadonlyMap<string, string> | undefined;
    const { source } = fakeSource({
      loadBalancerTargetHealth: async (_t, k) => {
        known = k;
        return { targets: [], unresolved: 0 };
      },
    });
    const { reader } = setup({ source });
    await reader.targetHealth(LB_A, A);
    expect([...known!.entries()].sort()).toEqual(
      [
        [awsResourceName("instance", SERVER_1), SERVER_1],
        [awsResourceName("instance", SERVER_2), SERVER_2],
      ].sort(),
    );
  });

  it("answers another customer as a missing id and a resource of another family as validation", async () => {
    const { reader, calls } = setup();
    expect(await reader.targetHealth(LB_B, A)).toEqual(await reader.targetHealth(GHOST, A));
    expect(await reader.targetHealth(LB_B, A)).toEqual({ ok: false, error: "not_found" });
    expect(await reader.targetHealth(DB_A, A)).toEqual({ ok: false, error: "validation" });
    expect(await reader.targetHealth(RESOURCE_A, A)).toEqual({ ok: false, error: "validation" });
    expect(calls).toEqual([]);
  });

  it("does not ask AWS for a load balancer that is not live", async () => {
    const { reader, calls } = setup(
      {},
      { [LB_A]: { owner: CUSTOMER_A, target: target(LB_A, "creating", "load_balancer") } },
    );
    const got = await reader.targetHealth(LB_A, A);
    expect(got.ok && got.value.live).toBe(false);
    expect(got.ok && got.value.targets).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("fails closed: unreadable record, too many targets, AWS errors", async () => {
    const a = setup({ loadRecordedTargets: async () => null });
    expect(await a.reader.targetHealth(LB_A, A)).toEqual({ ok: false, error: "internal" });
    const many = fakeSource({
      loadBalancerTargetHealth: async () => ({
        targets: Array.from({ length: 21 }, (_, i) => ({
          targetResourceId: String(i),
          health: "healthy" as const,
          reason: null,
        })),
        unresolved: 0,
      }),
    });
    const b = setup({ source: many.source });
    expect(await b.reader.targetHealth(LB_A, A)).toEqual({ ok: false, error: "internal" });
    const err = fakeSource({
      loadBalancerTargetHealth: async () => {
        throw new AwsError({ code: "forbidden", retryable: false });
      },
    });
    const c = setup({ source: err.source });
    expect(await c.reader.targetHealth(LB_A, A)).toEqual({
      ok: false,
      error: "upstream_unavailable",
    });
  });

  it("has no caller: unauthenticated; rate limited per caller", async () => {
    const { reader } = setup({ rateLimit: { max: 1, windowMs: 60_000 } });
    expect(await reader.targetHealth(LB_A, {} as never)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect((await reader.targetHealth(LB_A, A)).ok).toBe(true);
    expect(await reader.targetHealth(LB_A, A)).toEqual({ ok: false, error: "rate_limited" });
  });
});

describe("databaseMetrics (WPU-Y8)", () => {
  it("gives the owner the series for a range with the generated database name", async () => {
    const { reader, calls, logged } = setup();
    const got = await reader.databaseMetrics(DB_A, A, "1h");
    expect(got.ok && got.value.series[0]!.statistic).toBe("average");
    expect(got.ok && got.value.range).toBe("1h");
    expect((calls[0]!.target as unknown as { databaseName: string }).databaseName).toBe(
      awsResourceName("database", DB_A),
    );
    expect(logged[0]).toMatchObject({ action: "database_metrics", outcome: "ok" });
    expect(JSON.stringify([got, logged])).not.toMatch(/tc-database-|arn:|210987654321/);
  });

  it("validates range and family, hides foreign resources", async () => {
    const { reader, calls } = setup();
    expect(await reader.databaseMetrics(DB_A, A, "2y" as never)).toEqual({
      ok: false,
      error: "validation",
    });
    expect(await reader.databaseMetrics(LB_A, A, "1h")).toEqual({ ok: false, error: "validation" });
    expect(await reader.databaseMetrics(DB_B, A, "1h")).toEqual(
      await reader.databaseMetrics(GHOST, A, "1h"),
    );
    expect(await reader.databaseMetrics(DB_B, A, "1h")).toEqual({ ok: false, error: "not_found" });
    expect(calls).toEqual([]);
  });

  it("maps an AWS failure to a platform code and returns no partial series", async () => {
    const err = fakeSource({
      databaseMetrics: async () => {
        throw new AwsError({ code: "not_found", retryable: false });
      },
    });
    const { reader } = setup({ source: err.source });
    expect(await reader.databaseMetrics(DB_A, A, "1d")).toEqual({ ok: false, error: "not_found" });
  });
});
