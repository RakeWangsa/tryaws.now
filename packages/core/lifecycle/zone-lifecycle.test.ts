import { describe, expect, it } from "vitest";
import { APPROVAL_UNTIL, requiresApproval } from "../operations/kinds";
import { DNS_ZONE_STATES, DNS_ZONE_TERM_DAYS, zoneStatusWord } from "../dns/zone";
import { DEFAULT_LIFECYCLE_CONFIG } from "./config";
import { decideSubscription, type DecisionView } from "./decide";
import {
  KEPT_CONFIG_FAMILIES,
  SNAPSHOT_FAMILIES,
  decideDestructive,
  type GuardFacts,
} from "./guard";

// WPU-B2 (audit 2, item 25): what the lifecycle does with a DNS zone, which is the one family that is
// neither a pool resource nor a server: a hosted zone in tc-dns, a 30 day term (not the 30 day term of the
// pool families by accident: DNS_ZONE_TERM_DAYS), no snapshot, and a name that is held until the zone is
// removed. Pure tests of the decision table and the guard; the database scenario of the engine is
// scenario.db.test.ts (it needs PostgreSQL).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date("2026-12-10T00:00:00.000Z");
const END = new Date(START.getTime() + DNS_ZONE_TERM_DAYS * DAY);
const cfg = DEFAULT_LIFECYCLE_CONFIG;
const at = (ms: number): Date => new Date(END.getTime() + ms);

const zone = (over: Partial<DecisionView> = {}): DecisionView => ({
  status: "active",
  periodEnd: END,
  autoRenew: false,
  resourceState: "active",
  destroyedAt: null,
  ...over,
});

const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  subscriptionStatus: "retained",
  family: "dns_zone",
  hasFinalSnapshot: false,
  isFinalBackup: false,
  ...over,
});

describe("the term of a zone", () => {
  it("is 30 days, and the first reminder comes 7 days before the end, not before", () => {
    expect(DNS_ZONE_TERM_DAYS).toBe(30);
    expect(decideSubscription(zone(), new Date(START.getTime() + 22 * DAY), cfg)).toEqual({
      type: "none",
    });
    expect(decideSubscription(zone(), new Date(START.getTime() + 23 * DAY), cfg)).toEqual({
      type: "remind",
      day: 7,
    });
  });

  it("at the end of the term it renews only when the customer turned auto-renew on", () => {
    expect(decideSubscription(zone({ autoRenew: true }), at(0), cfg)).toEqual({
      type: "period_end",
      tryRenew: true,
    });
    expect(decideSubscription(zone({ autoRenew: false }), at(0), cfg)).toEqual({
      type: "period_end",
      tryRenew: false,
    });
  });

  it("a zone that is still being created, that failed or was removed never expires by the clock", () => {
    for (const resourceState of ["creating", "failed", "destroyed", "destroying"]) {
      expect(decideSubscription(zone({ resourceState }), at(5 * DAY), cfg), resourceState).toEqual({
        type: "none",
      });
    }
  });
});

describe("the road of an unpaid zone: grace, retained, removed, ended", () => {
  it("follows the table of section 11 with the 48 hours and 14 days of the config", () => {
    // Auto-renew off: wait during the grace, retain when it is over.
    expect(decideSubscription(zone({ status: "grace" }), at(47 * HOUR), cfg)).toEqual({
      type: "none",
    });
    expect(decideSubscription(zone({ status: "grace" }), at(48 * HOUR), cfg)).toEqual({
      type: "retain",
    });
    // Retained and not yet removed: the retention operations are (re)queued, never twice by the table.
    expect(decideSubscription(zone({ status: "retained" }), at(49 * HOUR), cfg)).toEqual({
      type: "ensure_retention_operations",
    });
    // Removed at some instant: the subscription ends after the retention days, to the millisecond.
    const destroyedAt = at(50 * HOUR);
    const removed = zone({ status: "retained", resourceState: "destroyed", destroyedAt });
    const endsAt = destroyedAt.getTime() + cfg.retentionDays * DAY;
    expect(decideSubscription(removed, new Date(endsAt - 1), cfg)).toEqual({ type: "none" });
    expect(decideSubscription(removed, new Date(endsAt), cfg)).toEqual({ type: "end" });
    expect(decideSubscription(zone({ status: "ended" }), new Date(endsAt + DAY), cfg)).toEqual({
      type: "none",
    });
  });

  it("a removed zone with no removal instant waits instead of ending (R16)", () => {
    expect(
      decideSubscription(
        zone({ status: "retained", resourceState: "destroyed", destroyedAt: null }),
        at(100 * DAY),
        cfg,
      ),
    ).toEqual({ type: "none" });
  });
});

describe("a zone has no snapshot", () => {
  it("is on the list of families that keep their settings, not on the list that need a final snapshot", () => {
    expect(SNAPSHOT_FAMILIES).not.toContain("dns_zone");
    expect(KEPT_CONFIG_FAMILIES).toContain("dns_zone");
  });

  it("destroy needs a retained subscription and no snapshot; every other state refuses (R13)", () => {
    for (const hasFinalSnapshot of [false, true]) {
      expect(decideDestructive("destroy", facts({ hasFinalSnapshot }))).toBe(true);
    }
    for (const subscriptionStatus of ["active", "grace", "ended", null] as const) {
      expect(
        decideDestructive("destroy", facts({ subscriptionStatus })),
        String(subscriptionStatus),
      ).toBe(false);
    }
  });

  it("purge_snapshots stays for an ended subscription, and delete_backup is never a zone action", () => {
    expect(decideDestructive("purge_snapshots", facts({ subscriptionStatus: "ended" }))).toBe(true);
    expect(decideDestructive("purge_snapshots", facts({ subscriptionStatus: "retained" }))).toBe(
      false,
    );
    expect(decideDestructive("delete_backup", facts())).toBe(false);
  });

  it("the actions of the domain (renew, name servers) are not destructive kinds the guard would allow", () => {
    for (const kind of [
      "renew_domain",
      "set_name_servers",
      "resend_verification",
      "change_dns_record",
    ]) {
      expect(decideDestructive(kind, facts({ family: "domain" })), kind).toBe(false);
      expect(decideDestructive(kind, facts()), kind).toBe(false);
    }
  });
});

describe("the removal of a zone waits for an admin until 2026-12-01 (R13)", () => {
  it("destroy of a zone needs approval before the end date and not after it", () => {
    const until = new Date(APPROVAL_UNTIL);
    expect(requiresApproval("destroy", new Date("2026-12-01T17:59:59.999Z"), until)).toBe(true);
    expect(requiresApproval("destroy", new Date("2026-12-01T18:00:00.000Z"), until)).toBe(false);
    // The record editor is not destructive: it never waits for approval.
    expect(requiresApproval("change_dns_record", new Date("2026-11-15T00:00:00Z"), until)).toBe(
      false,
    );
  });
});

describe("what the screen says about a zone along the road", () => {
  it("a zone is pending while it is created, removing while the destroy runs, removed when it is gone", () => {
    expect(zoneStatusWord({ resourceState: "creating", rowStatus: "delegated" })).toBe("pending");
    expect(zoneStatusWord({ resourceState: "active", rowStatus: "pending_delegation" })).toBe(
      "pending_delegation",
    );
    expect(zoneStatusWord({ resourceState: "active", rowStatus: "delegated" })).toBe("delegated");
    expect(
      zoneStatusWord({ resourceState: "active", rowStatus: "delegated", destroying: true }),
    ).toBe("removing");
    expect(zoneStatusWord({ resourceState: "destroyed", rowStatus: "delegated" })).toBe("removed");
    expect(zoneStatusWord({ resourceState: "failed", rowStatus: "pending" })).toBe("failed");
  });

  it("every status word the screen can show is a word of the closed list that the table also checks", () => {
    for (const resourceState of [
      "creating",
      "active",
      "suspended",
      "stopped",
      "destroyed",
      "failed",
    ]) {
      for (const rowStatus of [...DNS_ZONE_STATES, "unknown_word", null]) {
        expect(DNS_ZONE_STATES).toContain(zoneStatusWord({ resourceState, rowStatus }));
      }
    }
  });
});
