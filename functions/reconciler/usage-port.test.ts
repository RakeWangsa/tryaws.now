import { describe, expect, it } from "vitest";
import { AwsError, type UsageSource } from "@tc/aws";
import type { LogEvent, UsageSample } from "@tc/core";
import type { PoolAccountRef } from "@tc/db";
import { fakeInventory } from "./fake-inventory";
import { withUsage } from "./usage-port";

// WPU-X4: the join of the real usage reader to the reconciler port. The source is injected; no AWS call.

const ACCOUNT: PoolAccountRef = {
  id: "0198f0c0-0000-7000-8000-0000000000a1",
  awsAccountId: "210987654321",
  externalId: "tc-ext-7f3a9c",
};
const BASE = { items: [], live: [] };
const SAMPLE: UsageSample = {
  awsName: "tc-instance-aaaaaaaaaaaaaaaa",
  metric: "snapshot_gb",
  period: "2026-11-13",
  quantityGb: "20",
};

function build(source: UsageSource, enabled = true, script = { [ACCOUNT.id]: BASE }) {
  const logs: LogEvent[] = [];
  const port = withUsage({
    base: fakeInventory(script),
    source,
    enabled: async () => enabled,
    log: (e) => logs.push(e),
  });
  return { port, logs };
}

describe("withUsage", () => {
  it("adds the usage of the source to a good base read and passes the account refs", async () => {
    const seen: unknown[] = [];
    const { port } = build({
      async read(a) {
        seen.push(a);
        return [SAMPLE];
      },
    });
    const r = await port.read(ACCOUNT);
    expect(r).toEqual({ ok: true, value: { ...BASE, usage: [SAMPLE] } });
    expect(seen).toEqual([{ awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" }]);
  });

  it("leaves usage out and calls nothing when no metered family is on", async () => {
    let called = 0;
    const { port } = build({ read: async () => (called++, []) }, false);
    expect(await port.read(ACCOUNT)).toEqual({ ok: true, value: BASE });
    expect(called).toBe(0);
  });

  it("passes on a failed base read and does not read usage", async () => {
    let called = 0;
    const { port } = build({ read: async () => (called++, []) }, true, {});
    expect(await port.read(ACCOUNT)).toEqual({ ok: false, reason: "unreachable" });
    expect(called).toBe(0);
  });

  it("fails the account when the usage read fails, and logs no account id (R16, R14)", async () => {
    const cases: [AwsError, string][] = [
      [new AwsError({ code: "forbidden", retryable: false }), "denied"],
      [new AwsError({ code: "rate_limited", retryable: true }), "throttled"],
      [
        new AwsError({ code: "internal", retryable: true, reason: "usage_pages_exceeded" }),
        "incomplete",
      ],
      [new AwsError({ code: "upstream_unavailable", retryable: true }), "unreachable"],
    ];
    for (const [error, reason] of cases) {
      const { port, logs } = build({
        read: async () => {
          throw error;
        },
      });
      expect(await port.read(ACCOUNT)).toEqual({ ok: false, reason });
      expect(JSON.stringify(logs)).not.toContain("210987654321");
      expect(logs[0]).toMatchObject({ event: "reconcile_usage_read_failed", reason });
    }
  });

  it("treats a non-AWS throw as unreachable", async () => {
    const { port } = build({
      read: async () => {
        throw new Error("boom 210987654321");
      },
    });
    expect(await port.read(ACCOUNT)).toEqual({ ok: false, reason: "unreachable" });
  });
});
