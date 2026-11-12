import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_KEYS,
  groupSnapshots,
  onboardingSteps,
  usageSummary,
  type OnboardingInput,
  type SnapshotInput,
  type UsageInput,
} from "./account-overview";

const NEW_CUSTOMER: OnboardingInput = {
  phoneVerified: false,
  kycVerified: false,
  toppedUp: false,
  sshKeys: 0,
  servers: 0,
  firewallReviewed: false,
  snapshots: 0,
};

describe("onboardingSteps", () => {
  it("lists the steps of a first launch in the order a customer meets them", () => {
    expect(ONBOARDING_STEP_KEYS).toEqual([
      "phone",
      "kyc",
      "topUp",
      "sshKey",
      "server",
      "firewall",
      "snapshot",
    ]);
    expect(onboardingSteps(NEW_CUSTOMER).steps.map((s) => s.key)).toEqual([
      ...ONBOARDING_STEP_KEYS,
    ]);
  });

  it("a brand-new customer starts at the phone and the later server steps are locked", () => {
    const view = onboardingSteps(NEW_CUSTOMER);
    expect(view.next).toBe("phone");
    expect(view.started).toBe(false);
    expect(view.complete).toBe(false);
    const locked = view.steps.filter((s) => s.locked).map((s) => s.key);
    expect(locked).toEqual(["firewall", "snapshot"]);
    expect(view.steps.every((s) => !s.done)).toBe(true);
  });

  it("the key step is never locked, because the create form needs a key", () => {
    const view = onboardingSteps({ ...NEW_CUSTOMER, sshKeys: 1 });
    expect(view.steps.find((s) => s.key === "sshKey")).toEqual({
      key: "sshKey",
      done: true,
      locked: false,
    });
  });

  it("the firewall and snapshot steps open when a server exists", () => {
    const view = onboardingSteps({
      ...NEW_CUSTOMER,
      phoneVerified: true,
      kycVerified: true,
      toppedUp: true,
      sshKeys: 1,
      servers: 1,
    });
    expect(view.steps.filter((s) => s.locked)).toEqual([]);
    expect(view.next).toBe("firewall");
    expect(view.started).toBe(true);
  });

  it("a locked step can never be done, even if the numbers say so", () => {
    const view = onboardingSteps({ ...NEW_CUSTOMER, firewallReviewed: true, snapshots: 2 });
    expect(view.steps.find((s) => s.key === "firewall")).toMatchObject({
      done: false,
      locked: true,
    });
    expect(view.steps.find((s) => s.key === "snapshot")).toMatchObject({
      done: false,
      locked: true,
    });
  });

  it("is complete with every step done and then has no next step", () => {
    const view = onboardingSteps({
      phoneVerified: true,
      kycVerified: true,
      toppedUp: true,
      sshKeys: 2,
      servers: 3,
      firewallReviewed: true,
      snapshots: 1,
    });
    expect(view.complete).toBe(true);
    expect(view.next).toBeNull();
  });

  it("negative or fractional counts count as none (fail closed)", () => {
    const view = onboardingSteps({
      ...NEW_CUSTOMER,
      servers: -1,
      sshKeys: 0.5,
      snapshots: Number.NaN,
    });
    expect(view.steps.find((s) => s.key === "server")?.done).toBe(false);
    expect(view.steps.find((s) => s.key === "sshKey")?.done).toBe(false);
  });
});

const NOW = new Date("2026-11-12T00:00:00.000Z");
const day = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);
const row = (over: Partial<UsageInput> = {}): UsageInput => ({
  family: "linux_instance",
  status: "active",
  amountMinor: 100_000n,
  periodEnd: day(10),
  autoRenew: true,
  ...over,
});

describe("usageSummary", () => {
  it("is empty and zero without subscriptions", () => {
    expect(usageSummary([])).toEqual({
      totalMinor: 0n,
      running: 0,
      unpriced: 0,
      autoRenewOff: 0,
      nextRenewal: null,
      families: [],
    });
  });

  it("adds bigint paisa per family and in total, never a float", () => {
    const view = usageSummary([
      row({ amountMinor: 123_456n }),
      row({ amountMinor: 1n }),
      row({ family: "disk", amountMinor: 50_000n }),
    ]);
    expect(view.totalMinor).toBe(173_457n);
    expect(view.running).toBe(3);
    expect(view.families).toEqual([
      { family: "disk", count: 1, totalMinor: 50_000n },
      { family: "linux_instance", count: 2, totalMinor: 123_457n },
    ]);
  });

  it("counts active and grace, and leaves retained and ended out", () => {
    const view = usageSummary([
      row(),
      row({ status: "grace" }),
      row({ status: "retained" }),
      row({ status: "ended" }),
    ]);
    expect(view.running).toBe(2);
    expect(view.totalMinor).toBe(200_000n);
  });

  it("a row without a readable price is counted as unpriced and adds nothing", () => {
    const view = usageSummary([row({ amountMinor: null }), row()]);
    expect(view.unpriced).toBe(1);
    expect(view.totalMinor).toBe(100_000n);
    expect(view.running).toBe(2);
  });

  it("names the earliest renewal and counts the resources whose auto renew is off", () => {
    const view = usageSummary([
      row({ periodEnd: day(20) }),
      row({ periodEnd: day(3), autoRenew: false }),
      row({ periodEnd: day(8) }),
    ]);
    expect(view.nextRenewal).toEqual(day(3));
    expect(view.autoRenewOff).toBe(1);
  });

  it("sorts families by name so the order never depends on the input", () => {
    const a = usageSummary([row({ family: "database" }), row({ family: "bucket" })]);
    const b = usageSummary([row({ family: "bucket" }), row({ family: "database" })]);
    expect(a.families.map((f) => f.family)).toEqual(["bucket", "database"]);
    expect(b).toEqual(a);
  });

  it("does not lose precision above 2^53 paisa", () => {
    const big = 9_007_199_254_740_993n;
    expect(usageSummary([row({ amountMinor: big }), row({ amountMinor: 1n })]).totalMinor).toBe(
      big + 1n,
    );
  });

  it("a negative amount is treated as unpriced (a price is never below zero)", () => {
    const view = usageSummary([row({ amountMinor: -5n })]);
    expect(view.unpriced).toBe(1);
    expect(view.totalMinor).toBe(0n);
  });
});

const snap = (over: Partial<SnapshotInput> & { id: string }): SnapshotInput => ({
  parentId: "s1",
  state: "active",
  createdAt: day(-1),
  final: false,
  ...over,
});

describe("groupSnapshots", () => {
  it("groups by parent server, newest first inside a group", () => {
    const groups = groupSnapshots([
      snap({ id: "a", parentId: "s1", createdAt: day(-5) }),
      snap({ id: "b", parentId: "s2", createdAt: day(-2) }),
      snap({ id: "c", parentId: "s1", createdAt: day(-1) }),
    ]);
    expect(groups.map((g) => [g.parentId, g.items.map((i) => i.id)])).toEqual([
      ["s1", ["c", "a"]],
      ["s2", ["b"]],
    ]);
  });

  it("orders the groups by their newest snapshot", () => {
    const groups = groupSnapshots([
      snap({ id: "a", parentId: "old", createdAt: day(-9) }),
      snap({ id: "b", parentId: "new", createdAt: day(-1) }),
    ]);
    expect(groups.map((g) => g.parentId)).toEqual(["new", "old"]);
  });

  it("counts the manual snapshots of a group and leaves the final one out of the count", () => {
    const groups = groupSnapshots([
      snap({ id: "a" }),
      snap({ id: "b" }),
      snap({ id: "f", final: true }),
      snap({ id: "x", state: "failed" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.manual).toBe(2);
    expect(groups[0]?.restorable.map((i) => i.id).sort()).toEqual(["a", "b", "f"]);
  });

  it("a snapshot without a parent goes into no group (nothing to restore from)", () => {
    expect(groupSnapshots([snap({ id: "a", parentId: null })])).toEqual([]);
  });

  it("is empty for no input", () => {
    expect(groupSnapshots([])).toEqual([]);
  });
});
