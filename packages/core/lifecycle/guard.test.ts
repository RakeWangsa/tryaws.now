import { describe, expect, it } from "vitest";
import {
  KEPT_CONFIG_FAMILIES,
  SNAPSHOT_FAMILIES,
  decideDestructive,
  type GuardFacts,
} from "./guard";

const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  subscriptionStatus: "retained",
  family: "linux_instance",
  hasFinalSnapshot: true,
  ...over,
});

describe("decideDestructive: destroy (R13)", () => {
  it("allows a retained subscription with a final snapshot", () => {
    expect(decideDestructive("destroy", facts())).toBe(true);
  });
  it("refuses every other subscription state", () => {
    for (const subscriptionStatus of ["active", "grace", "ended", null] as const) {
      expect(decideDestructive("destroy", facts({ subscriptionStatus }))).toBe(false);
    }
  });
  it("refuses a snapshot family with no final snapshot", () => {
    for (const family of SNAPSHOT_FAMILIES) {
      expect(decideDestructive("destroy", facts({ family, hasFinalSnapshot: false }))).toBe(false);
      expect(decideDestructive("destroy", facts({ family, hasFinalSnapshot: true }))).toBe(true);
    }
  });
  it("lets a family that keeps its settings in resources.config go without a snapshot", () => {
    for (const family of KEPT_CONFIG_FAMILIES) {
      expect(decideDestructive("destroy", facts({ family, hasFinalSnapshot: false }))).toBe(true);
    }
  });
  it("refuses a family the lists do not know (R16)", () => {
    expect(decideDestructive("destroy", facts({ family: "mystery", hasFinalSnapshot: true }))).toBe(
      false,
    );
  });
});

describe("decideDestructive: purge_snapshots", () => {
  it("runs only for an ended subscription", () => {
    expect(decideDestructive("purge_snapshots", facts({ subscriptionStatus: "ended" }))).toBe(true);
    for (const subscriptionStatus of ["active", "grace", "retained", null] as const) {
      expect(decideDestructive("purge_snapshots", facts({ subscriptionStatus }))).toBe(false);
    }
  });
});

describe("decideDestructive: other destructive kinds", () => {
  it("refuses a kind that this guard does not know, even with every fact in order", () => {
    expect(decideDestructive("delete_backup", facts())).toBe(false);
    expect(decideDestructive("reboot", facts())).toBe(false);
    expect(decideDestructive("nonsense", facts())).toBe(false);
  });
});

describe("the family lists", () => {
  it("do not overlap", () => {
    for (const f of SNAPSHOT_FAMILIES) expect(KEPT_CONFIG_FAMILIES).not.toContain(f);
  });
});
