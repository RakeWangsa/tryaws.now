import { UNPAID_SETTING_KEY } from "@tc/core";
import { ADMIN_SETTING_KEYS, type AdminActor, type AdminRepos, type AdminRole } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  UNPAID_RULE_OFF_ROLES,
  UNPAID_RULE_ON_ROLES,
  UNPAID_RULE_READ_ROLES,
  makeUnpaidRuleAction,
  type UnpaidRuleRequest,
} from "./unpaid-rule-flow.ts";

// WPU-Z4: the switch of the unpaid-usage job in the order of R9 (authenticate and authorize, validate with
// the zod schema, rate limit, execute and audit in one transaction), with fakes. The roles depend on the
// direction: on is superadmin only, off is ops or superadmin (the safe direction, R16).
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "superadmin",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-13T08:00:00.000Z");

interface Over {
  allow?: boolean;
  role?: AdminRole;
  limit?: boolean;
  boom?: boolean;
  answer?: unknown;
}

function rig(over: Over = {}) {
  const steps: string[] = [];
  const calls: unknown[][] = [];
  const asked: (readonly AdminRole[])[] = [];
  const repos = {
    settings: {
      setBoolean: async (...args: unknown[]) => {
        steps.push("execute");
        calls.push(args);
        return (
          over.answer ?? {
            ok: true,
            replayed: false,
            value: { key: UNPAID_SETTING_KEY, market: "BD", enabled: args[1] },
          }
        );
      },
    },
  } as unknown as AdminRepos;
  const action = makeUnpaidRuleAction({
    authorize: async (roles) => {
      steps.push("authorize");
      asked.push(roles);
      if (over.allow === false) throw new Error("no session");
      return { ...ACTOR, role: over.role ?? ACTOR.role };
    },
    limiter: async (actor, now) => {
      steps.push("limit");
      expect(actor.adminId).toBe(ACTOR.adminId);
      expect(now).toBe(NOW);
      return over.limit !== false;
    },
    run: async <T>(_actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) => {
      if (over.boom) throw new Error("database down: secret detail");
      const out = await fn(repos);
      steps.push("committed");
      return out;
    },
    clock: { now: () => NOW },
  });
  return { steps, calls, asked, action };
}

const on = (o: Partial<UnpaidRuleRequest> = {}): UnpaidRuleRequest => ({
  market: "BD",
  state: "on",
  confirm: "on",
  reason: "  pilot customers  ",
  ...o,
});
const off = (o: Partial<UnpaidRuleRequest> = {}): UnpaidRuleRequest => ({
  market: "BD",
  state: "off",
  confirm: "",
  reason: "too many suspensions",
  ...o,
});

describe("the roles of the unpaid-usage rule", () => {
  it("every admin reads; on is superadmin only; off is ops or superadmin", () => {
    expect([...UNPAID_RULE_READ_ROLES].sort()).toEqual(["finance", "ops", "superadmin", "support"]);
    expect(UNPAID_RULE_ON_ROLES).toEqual(["superadmin"]);
    expect([...UNPAID_RULE_OFF_ROLES].sort()).toEqual(["ops", "superadmin"]);
  });

  it("the key the admin switches is the key the job reads, and the repository allows it", () => {
    expect(UNPAID_SETTING_KEY).toBe("lifecycle_unpaid_enabled");
    expect(ADMIN_SETTING_KEYS).toContain(UNPAID_SETTING_KEY);
  });
});

describe("switching the unpaid-usage rule in the order of R9", () => {
  it("turning on authorizes with superadmin, validates, limits, executes with the trimmed reason", async () => {
    const r = rig();
    expect(await r.action(on())).toEqual({
      ok: true,
      replayed: false,
      market: "BD",
      enabled: true,
    });
    expect(r.steps).toEqual(["authorize", "limit", "execute", "committed"]);
    expect(r.asked).toEqual([["superadmin"]]);
    expect(r.calls).toEqual([[{ key: UNPAID_SETTING_KEY, market: "BD" }, true, "pilot customers"]]);
  });

  it("turning off asks for ops or superadmin and needs no confirm box", async () => {
    const r = rig({ role: "ops" });
    expect(await r.action(off())).toEqual({
      ok: true,
      replayed: false,
      market: "BD",
      enabled: false,
    });
    expect(r.asked).toEqual([["ops", "superadmin"]]);
    expect(r.calls).toEqual([
      [{ key: UNPAID_SETTING_KEY, market: "BD" }, false, "too many suspensions"],
    ]);
  });

  it("a state that is not exactly off asks for the roles of turning on (R16)", async () => {
    for (const state of ["on", "OFF", "true", "", undefined, 0]) {
      const r = rig();
      await r.action(on({ state }));
      expect(r.asked, String(state)).toEqual([["superadmin"]]);
    }
  });

  it("refuses a caller without the role before anything else", async () => {
    for (const request of [on(), off()]) {
      const r = rig({ allow: false });
      expect(await r.action(request)).toEqual({ ok: false, code: "denied" });
      expect(r.steps).toEqual(["authorize"]);
    }
  });

  it("refuses a guard answer with a role that was not asked for (a second look)", async () => {
    const r = rig({ role: "ops" });
    expect(await r.action(on())).toEqual({ ok: false, code: "denied" });
    expect(r.steps).toEqual(["authorize"]);
    for (const role of ["finance", "support"] as const) {
      const other = rig({ role });
      expect(await other.action(off())).toEqual({ ok: false, code: "denied" });
      expect(other.steps).toEqual(["authorize"]);
    }
  });

  it("validates with the zod schema before the limiter and the database", async () => {
    const bad = [
      on({ confirm: "" }),
      on({ confirm: undefined }),
      on({ confirm: "yes" }),
      on({ market: "bd" }),
      on({ market: "XYZ" }),
      on({ reason: "" }),
      on({ reason: "   " }),
      on({ reason: "x".repeat(501) }),
      off({ reason: undefined }),
      on({ state: "maybe" }),
    ];
    for (const request of bad) {
      const r = rig();
      expect(await r.action(request), JSON.stringify(request)).toEqual({
        ok: false,
        code: "invalid",
      });
      expect(r.steps).toEqual(["authorize"]);
    }
  });

  it("the form cannot name the admin, the key or the value: extra fields change nothing", async () => {
    const r = rig();
    await r.action({
      ...on(),
      adminId: "x",
      key: "tier_limits",
      value: "false",
      setBy: "x",
    } as never);
    expect(r.calls).toEqual([[{ key: UNPAID_SETTING_KEY, market: "BD" }, true, "pilot customers"]]);
  });

  it("over the limit nothing runs", async () => {
    const r = rig({ limit: false });
    expect(await r.action(on())).toEqual({ ok: false, code: "rate_limited" });
    expect(r.steps).toEqual(["authorize", "limit"]);
  });

  it("a repository refusal and a database error give fixed codes, never the text of an error", async () => {
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["validation", "invalid"],
      ["not_found", "not_found"],
      ["conflict", "conflict"],
    ] as const) {
      const r = rig({ answer: { ok: false, error } });
      expect(await r.action(on())).toEqual({ ok: false, code });
    }
    const down = await rig({ boom: true }).action(on());
    expect(down).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(down)).not.toContain("secret");
    // A limiter that fails is a refusal too (R16): nothing runs.
    let ran = false;
    const action = makeUnpaidRuleAction({
      authorize: async () => ACTOR,
      limiter: async () => {
        throw new Error("rate table down");
      },
      run: async () => {
        ran = true;
        throw new Error("not reached");
      },
      clock: { now: () => NOW },
    });
    expect(await action(on())).toEqual({ ok: false, code: "unavailable" });
    expect(ran).toBe(false);
  });

  it("a replay is reported as a replay", async () => {
    const r = rig({
      answer: {
        ok: true,
        replayed: true,
        value: { key: UNPAID_SETTING_KEY, market: "BD", enabled: true },
      },
    });
    expect(await r.action(on())).toMatchObject({ ok: true, replayed: true });
  });
});
