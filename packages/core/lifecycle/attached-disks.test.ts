import { describe, expect, it } from "vitest";
import { attachedServerOf, diskRenewalHeld, finalSnapshotStarted } from "./attached-disks";
import { decideDestructive, withServerOf, type GuardFacts } from "./guard";

// WPU-Y4 fix round 2: the pure parts. The guard refuses the destroy of a disk retained with its server unless that
// server is still retained (a revived server keeps its disks, R13, R16); a disk is not renewed while its server is
// in grace or retained.

const S = "0190aaaa-0000-7000-8000-0000000000a1";
const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  subscriptionStatus: "retained",
  family: "disk",
  hasFinalSnapshot: true,
  isFinalBackup: false,
  ...over,
});

describe("the guard of a disk destroyed with its server", () => {
  it("passes only while the server is retained", () => {
    expect(decideDestructive("destroy", facts({ withServerStatus: "retained" }))).toBe(true);
    for (const withServerStatus of ["active", "grace", "ended", null]) {
      expect(decideDestructive("destroy", facts({ withServerStatus }))).toBe(false);
    }
  });
  it("without a server named, the rule is the one of WP5 (retained and a final snapshot)", () => {
    expect(decideDestructive("destroy", facts())).toBe(true);
    expect(decideDestructive("destroy", facts({ subscriptionStatus: "active" }))).toBe(false);
  });
  it("reads the server from the payload first, then from the disk's mark; a value that is not an id is null", () => {
    expect(withServerOf({ withServer: S }, {})).toBe(S);
    expect(withServerOf({}, { retainedWithServer: { serverId: S, from: "active" } })).toBe(S);
    expect(withServerOf({ subscriptionId: "x" }, { attachedInstanceId: S })).toBeUndefined();
    expect(withServerOf({ withServer: "tc-instance-1" }, {})).toBeNull();
    expect(withServerOf({}, { retainedWithServer: "x" })).toBeNull();
    expect(withServerOf(null, null)).toBeUndefined();
  });
});

describe("the renewal hold of a disk whose server is in grace or retained", () => {
  it("holds for grace and retained only", () => {
    expect(diskRenewalHeld("grace")).toBe(true);
    expect(diskRenewalHeld("retained")).toBe(true);
    for (const s of ["active", "ended", null]) expect(diskRenewalHeld(s)).toBe(false);
  });
  it("reads the attached server id from the disk config, a UUID only", () => {
    expect(attachedServerOf({ attachedInstanceId: S })).toBe(S);
    expect(attachedServerOf({ attachedInstanceId: "tc-instance-1" })).toBeNull();
    expect(attachedServerOf({})).toBeNull();
  });
});

// WPU-X1: a final snapshot that started is never ended by a release (it would leave an AWS snapshot that is billed
// and cannot be deleted); it finishes as an ordinary backup. Only one that never started is ended.
describe("a final snapshot that started", () => {
  const op = (over: Partial<{ state: string; step: string | null; attempts: number }> = {}) => ({
    kind: "final_snapshot" as const,
    state: "queued",
    step: null,
    attempts: 0,
    ...over,
  });
  it("is one that runs, has a step or was attempted", () => {
    expect(finalSnapshotStarted(op({ state: "running", attempts: 1 }))).toBe(true);
    expect(finalSnapshotStarted(op({ state: "running" }))).toBe(true);
    expect(finalSnapshotStarted(op({ state: "waiting", step: "wait_snapshot", attempts: 1 }))).toBe(
      true,
    );
    expect(finalSnapshotStarted(op({ state: "queued", attempts: 2 }))).toBe(true);
    expect(finalSnapshotStarted(op({ state: "needs_attention", step: "wait_snapshot" }))).toBe(
      true,
    );
  });
  it("is not one that is queued, blocked or waits for an approval and never ran", () => {
    expect(finalSnapshotStarted(op())).toBe(false);
    expect(finalSnapshotStarted(op({ state: "needs_approval" }))).toBe(false);
    expect(finalSnapshotStarted(op({ state: "needs_attention" }))).toBe(false);
    // Fix round 1: moved to `waiting` by the claim's block rule (another operation of the resource ran first):
    // no step, no attempt, nothing was sent to AWS.
    expect(finalSnapshotStarted(op({ state: "waiting" }))).toBe(false);
  });
  it("is never a destroy (the destroy has its own rule)", () => {
    expect(finalSnapshotStarted({ ...op({ state: "running" }), kind: "destroy" })).toBe(false);
  });
});
