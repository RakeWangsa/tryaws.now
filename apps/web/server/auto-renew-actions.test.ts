import type { CustomerSession } from "@tc/auth";
import { FEATURE_FLAGS, autoRenewAtPurchase } from "@tc/core";
import type { ResourceSummary, SubscriptionRow } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  AUTO_RENEW_LIMIT,
  SWITCH_FAMILIES,
  setResourceAutoRenewCore,
  type SwitchFamily,
} from "./auto-renew-actions.ts";
import { autoRenewViewOf } from "./auto-renew-view.ts";
import type { FamilyActionDeps, FamilyRepos } from "./family-actions.ts";

// WPU-Z14: the auto-renew switch of the detail page of every family that has no switch of its own. The
// ports are fakes: the order of the calls is R9, an unknown or foreign id is one answer that writes nothing
// (R8), and the store is opened for the session's customer only.

const NOW = new Date("2026-11-14T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "0190aaaa-0000-7000-8000-0000000000c1";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(NOW.getTime() - 60_000),
});

const row = (family: string, over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: ID,
  family,
  productId: null,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "main" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

const subscription = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: "0190aaaa-0000-7000-8000-0000000000c2",
  resourceId: ID,
  termDays: 30,
  priceSnapshot: {},
  periodStart: NOW,
  periodEnd: new Date(NOW.getTime() + 30 * 86_400_000),
  autoRenew: true,
  status: "active",
  ...over,
});

function world(
  over: {
    rows?: ResourceSummary[];
    sub?: SubscriptionRow | null;
    flag?: boolean;
    allowed?: boolean;
    auditOk?: boolean;
    session?: CustomerSession | null;
  } = {},
) {
  const calls: string[] = [];
  const rows = over.rows ?? [row("database")];
  const sub = over.sub === undefined ? subscription() : over.sub;
  const repos: FamilyRepos = {
    flagOn: async () => {
      calls.push("flag");
      return over.flag !== false;
    },
    resources: {
      get: async (id: string) => {
        calls.push("own");
        return rows.find((r) => r.id === id) ?? null;
      },
    } as never,
    subscriptions: {
      get: async (id: string) => (sub !== null && sub.resourceId === id ? sub : null),
      setAutoRenew: async (id: string, on: boolean) => {
        calls.push(`autoRenew:${id}:${on}`);
        return sub !== null && sub.resourceId === id
          ? { ok: true, replayed: false, value: { ...sub, autoRenew: on } }
          : { ok: false, error: "not_found" };
      },
    } as never,
    operations: {} as never,
    audit: {
      record: async (input: { action: string; targetId: string }) => {
        calls.push(`audit:${input.action}:${input.targetId}`);
        return over.auditOk === false ? { ok: false, error: "validation" } : { ok: true };
      },
    } as never,
    rateLimits: {
      consume: async (limits: readonly { action: string }[]) => {
        calls.push(`rate:${limits.map((l) => l.action).join(",")}`);
        return { allowed: over.allowed !== false } as never;
      },
    } as never,
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return over.session === undefined ? session() : over.session;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      // R8: the store is only ever opened for the customer of the session.
      expect(customerId).toBe(CUSTOMER);
      calls.push(`store:${customerId}`);
      return fn(repos);
    },
  };
  return { deps, calls };
}

const wrote = (calls: string[]): boolean =>
  calls.some((c) => c.startsWith("autoRenew") || c.startsWith("audit"));

describe("setResourceAutoRenewCore (WPU-Z14)", () => {
  it.each(SWITCH_FAMILIES.map((family) => [family]))(
    "%s: authenticates, checks the flag and the ownership, rate limits, switches and audits, in that order (R9)",
    async (family) => {
      const off = world({ rows: [row(family)] });
      expect(
        await setResourceAutoRenewCore(off.deps, family, { resourceId: ID, autoRenew: "off" }),
      ).toEqual({ ok: true, done: "autoRenewOff" });
      expect(off.calls).toEqual([
        "authenticate",
        `store:${CUSTOMER}`,
        "flag",
        "own",
        "rate:subscription.auto_renew",
        `autoRenew:${ID}:false`,
        `audit:subscription.auto_renew_off:${ID}`,
      ]);
      const on = world({ rows: [row(family)], sub: subscription({ autoRenew: false }) });
      expect(
        await setResourceAutoRenewCore(on.deps, family, { resourceId: ID, autoRenew: "on" }),
      ).toEqual({ ok: true, done: "autoRenewOn" });
      expect(on.calls.slice(-2)).toEqual([
        `autoRenew:${ID}:true`,
        `audit:subscription.auto_renew_on:${ID}`,
      ]);
    },
  );

  it.each(SWITCH_FAMILIES.map((family) => [family]))(
    "R8: another customer's %s, or none, is not_found, and nothing is written, audited or counted",
    async (family) => {
      // The tenant-scoped repository does not return another customer's row: it reads like a missing one.
      const w = world({ rows: [] });
      expect(
        await setResourceAutoRenewCore(w.deps, family, {
          resourceId: ID,
          autoRenew: "off",
          customerId: OTHER,
        }),
      ).toEqual({ ok: false, error: "not_found" });
      expect(wrote(w.calls)).toBe(false);
      expect(w.calls.some((c) => c.startsWith("rate"))).toBe(false);
    },
  );

  it("a row of another family is not_found: a database id does not switch through the CDN action", async () => {
    const w = world({ rows: [row("database")] });
    expect(
      await setResourceAutoRenewCore(w.deps, "cdn", { resourceId: ID, autoRenew: "off" }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(wrote(w.calls)).toBe(false);
    for (const family of ["linux_instance", "domain", "static_ip", "backup"]) {
      const other = world({ rows: [row(family)] });
      expect(
        await setResourceAutoRenewCore(other.deps, "disk", { resourceId: ID, autoRenew: "off" }),
        family,
      ).toEqual({ ok: false, error: "not_found" });
      expect(wrote(other.calls), family).toBe(false);
    }
  });

  it("refuses without a session, and opens nothing", async () => {
    const w = world({ session: null });
    expect(
      await setResourceAutoRenewCore(w.deps, "database", { resourceId: ID, autoRenew: "off" }),
    ).toEqual({ ok: false, error: "unauthenticated" });
    expect(w.calls).toEqual(["authenticate"]);
  });

  it("validates with zod before the store: a bad id, a missing or unknown value", async () => {
    for (const raw of [
      { resourceId: "not-a-uuid", autoRenew: "off" },
      { resourceId: ID },
      { resourceId: ID, autoRenew: "maybe" },
      { resourceId: ID, autoRenew: true },
      null,
      "resourceId",
    ]) {
      const w = world();
      const answer = await setResourceAutoRenewCore(w.deps, "database", raw);
      expect(answer.ok, JSON.stringify(raw)).toBe(false);
      if (!answer.ok) expect(answer.error).toBe("validation");
      expect(w.calls).toEqual(["authenticate"]);
    }
  });

  it("the flag of the family off is flag_off (R12), the rate limit refused is rate_limited; nothing is written", async () => {
    const off = world({ flag: false });
    expect(
      await setResourceAutoRenewCore(off.deps, "database", { resourceId: ID, autoRenew: "off" }),
    ).toEqual({ ok: false, error: "flag_off" });
    expect(wrote(off.calls)).toBe(false);
    const limited = world({ allowed: false });
    expect(
      await setResourceAutoRenewCore(limited.deps, "database", { resourceId: ID, autoRenew: "on" }),
    ).toEqual({ ok: false, error: "rate_limited" });
    expect(wrote(limited.calls)).toBe(false);
    expect(AUTO_RENEW_LIMIT).toEqual([
      { action: "subscription.auto_renew", limit: 30, windowSeconds: 3600 },
    ]);
  });

  it("turning it on needs a subscription that is active or in grace (R16); turning it off is always allowed", async () => {
    for (const status of ["retained", "ended"] as const) {
      const w = world({ sub: subscription({ status, autoRenew: false }) });
      expect(
        await setResourceAutoRenewCore(w.deps, "database", { resourceId: ID, autoRenew: "on" }),
        status,
      ).toEqual({ ok: false, error: "not_allowed" });
      expect(wrote(w.calls), status).toBe(false);
      const off = world({ sub: subscription({ status }) });
      expect(
        await setResourceAutoRenewCore(off.deps, "database", { resourceId: ID, autoRenew: "off" }),
        status,
      ).toEqual({ ok: true, done: "autoRenewOff" });
    }
    const grace = world({ sub: subscription({ status: "grace", autoRenew: false }) });
    expect(
      await setResourceAutoRenewCore(grace.deps, "database", { resourceId: ID, autoRenew: "on" }),
    ).toEqual({ ok: true, done: "autoRenewOn" });
    const none = world({ sub: null });
    expect(
      await setResourceAutoRenewCore(none.deps, "database", { resourceId: ID, autoRenew: "on" }),
    ).toEqual({ ok: false, error: "not_found" });
    const noneOff = world({ sub: null });
    expect(
      await setResourceAutoRenewCore(noneOff.deps, "database", {
        resourceId: ID,
        autoRenew: "off",
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(noneOff.calls.some((c) => c.startsWith("audit"))).toBe(false);
  });

  it("a refused audit entry fails the action (R9, R16): the answer is unavailable", async () => {
    const w = world({ auditOk: false });
    expect(
      await setResourceAutoRenewCore(w.deps, "database", { resourceId: ID, autoRenew: "off" }),
    ).toEqual({ ok: false, error: "unavailable" });
  });
});

// WPU-Z14 pin: the order review promises every family bought with auto-renew on that it can be turned off
// on the page of the service. Each such family has exactly one switch: the Billing tab of a Linux server
// (extras-actions.test.ts), the domain page (domain-actions.test.ts) or setResourceAutoRenewCore. A family
// added to autoRenewAtPurchase without a switch fails here.
describe("WPU-Z14: every family bought with auto-renew on has a switch that turns it off", () => {
  const OWN_SWITCH = ["linux_instance", "domain"];

  it("the families bought with auto-renew on are exactly those with a switch", () => {
    const on = FEATURE_FLAGS.filter((family) => autoRenewAtPurchase(family));
    expect([...on].sort()).toEqual([...OWN_SWITCH, ...SWITCH_FAMILIES].sort());
    for (const family of SWITCH_FAMILIES) expect(OWN_SWITCH).not.toContain(family);
  });

  it.each(
    FEATURE_FLAGS.filter((f) => autoRenewAtPurchase(f) && !OWN_SWITCH.includes(f)).map((f) => [f]),
  )("%s: the switch of its page turns it off", async (family) => {
    const w = world({ rows: [row(family)] });
    expect(
      await setResourceAutoRenewCore(w.deps, family as SwitchFamily, {
        resourceId: ID,
        autoRenew: "off",
      }),
    ).toEqual({ ok: true, done: "autoRenewOff" });
    expect(w.calls).toContain(`autoRenew:${ID}:false`);
  });
});

describe("autoRenewViewOf (WPU-Z14)", () => {
  it("shows the state of the own subscription; turning on is offered while active or in grace", () => {
    expect(autoRenewViewOf("database", row("database"), subscription())).toEqual({
      resourceId: ID,
      autoRenew: true,
      canTurnOn: true,
    });
    expect(
      autoRenewViewOf("database", row("database"), subscription({ status: "grace" }))?.canTurnOn,
    ).toBe(true);
    expect(
      autoRenewViewOf(
        "database",
        row("database"),
        subscription({ status: "retained", autoRenew: false }),
      ),
    ).toEqual({ resourceId: ID, autoRenew: false, canTurnOn: false });
  });

  it("no switch: no row, a row of another family, no subscription, another row's subscription, ended, destroyed", () => {
    expect(autoRenewViewOf("database", null, subscription())).toBeNull();
    expect(autoRenewViewOf("database", row("cdn"), subscription())).toBeNull();
    expect(autoRenewViewOf("database", row("database"), null)).toBeNull();
    expect(
      autoRenewViewOf(
        "database",
        row("database"),
        subscription({ resourceId: "0190aaaa-0000-7000-8000-0000000000c9" }),
      ),
    ).toBeNull();
    expect(
      autoRenewViewOf("database", row("database"), subscription({ status: "ended" })),
    ).toBeNull();
    expect(
      autoRenewViewOf("database", row("database", { state: "destroyed" }), subscription()),
    ).toBeNull();
  });
});
