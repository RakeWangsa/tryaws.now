import { AwsError } from "@tc/aws";
import { awsResourceName } from "@tc/core";
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  CUSTOMER_A,
  CUSTOMER_B,
  EXTERNAL_ID,
  GHOST,
  POOL_ACCOUNT,
  RESOURCE_A,
  RESOURCE_B,
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
