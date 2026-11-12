import { describe, expect, it, vi } from "vitest";
import { unconfiguredInventory } from "./inventory";
import { makeNightlyHandler } from "./handler";
import { ReconcileIncompleteError, type ReconcileResult } from "./reconcile";

const ok: ReconcileResult = {
  dayKey: "2026-11-12",
  accounts: 1,
  orphans: 0,
  missing: 0,
  newFindings: 0,
  replayedFindings: 0,
  unreachable: [],
  capacityCorrected: 0,
  capacitySkipped: 0,
  capacityOverLimit: 0,
  capacityFailed: 0,
  usageWritten: 0,
  usageSkipped: 0,
  usageFailed: 0,
  staleOperations: 0,
  incomplete: false,
};

describe("the nightly handler", () => {
  it("runs the comparison and the ledger check and returns the comparison", async () => {
    const ledger = vi.fn(async () => undefined);
    const run = makeNightlyHandler({ reconcile: async () => ok, ledger });
    await expect(run()).resolves.toBe(ok);
    expect(ledger).toHaveBeenCalledTimes(1);
  });

  it("findings alone do not fail the job: they are data for the admin", async () => {
    const found = { ...ok, orphans: 2, missing: 1, newFindings: 3 };
    const run = makeNightlyHandler({ reconcile: async () => found, ledger: async () => undefined });
    await expect(run()).resolves.toBe(found);
  });

  it("an incomplete run fails, after the ledger check has run", async () => {
    const ledger = vi.fn(async () => undefined);
    const incomplete = {
      ...ok,
      incomplete: true,
      unreachable: [{ poolAccountId: "p", reason: "unreachable" as const }],
    };
    const run = makeNightlyHandler({ reconcile: async () => incomplete, ledger });
    await expect(run()).rejects.toBeInstanceOf(ReconcileIncompleteError);
    expect(ledger).toHaveBeenCalledTimes(1);
  });

  it("a ledger mismatch fails the job and does not stop the comparison", async () => {
    const reconcile = vi.fn(async () => ok);
    const run = makeNightlyHandler({
      reconcile,
      ledger: async () => {
        throw new Error("ledger check: 1 finding");
      },
    });
    await expect(run()).rejects.toThrow("ledger check: 1 finding");
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("the first failure is the one that is thrown", async () => {
    const run = makeNightlyHandler({
      reconcile: async () => {
        throw new Error("first");
      },
      ledger: async () => {
        throw new Error("second");
      },
    });
    await expect(run()).rejects.toThrow("first");
  });
});

describe("the default inventory", () => {
  it("reports every account as not read until the STS inventory exists (fail closed)", async () => {
    await expect(
      unconfiguredInventory.read({ id: "p", awsAccountId: "123456789012", externalId: "x" }),
    ).resolves.toEqual({ ok: false, reason: "unconfigured" });
  });
});
