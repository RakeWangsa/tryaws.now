import type { AdminActor, AdminRole } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import { FLAG_ROLES, type PricingFlowDeps } from "./pricing-flow.ts";
import { makeTierLimitsFlow, type SaveTierLimitsRequest } from "./tier-limits-flow.ts";

// WPU-G10: the limits of a risk tier. The order of R9: authorize (ops and superadmin, the roles of the
// catalog area), validate, rate limit, execute in one transaction, audit (inside the repository, R10).
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const NOW = new Date("2026-11-12T06:00:00.000Z");
const TX = Symbol("tx") as never;
const actorOf = (role: AdminRole): AdminActor => ({ adminId: ADMIN_ID, role, ip: "203.0.113.7" });

const REQUEST: SaveTierLimitsRequest = {
  market: "BD",
  tier: "new",
  maxInstances: "20",
  maxBundleUsd: "24",
  windows: "",
  containers: "",
  maxStaticIps: "2",
  reason: "pilot customers need more",
};

function setup(role: AdminRole = "ops", over: Partial<PricingFlowDeps> = {}) {
  const order: string[] = [];
  const tierLimits = {
    read: vi.fn(),
    save: vi.fn(async (input: { market: string; tier: string; limits: unknown }) => {
      order.push("save");
      return { ok: true, replayed: false, value: input };
    }),
  };
  const deps = {
    repos: () => ({ tierLimits }) as never,
    authorize: vi.fn(async (roles: readonly AdminRole[]) => {
      order.push("authorize");
      if (!roles.includes(role)) throw new Error("no");
      return actorOf(role);
    }),
    limiter: vi.fn(async () => {
      order.push("limit");
      return true;
    }),
    run: vi.fn(async (_a: AdminActor, fn: (tx: never) => Promise<unknown>) => {
      order.push("run");
      return fn(TX);
    }),
    clock: { now: () => NOW },
    core: {} as never,
    stage: "staging",
    ...over,
  } as unknown as PricingFlowDeps;
  return { deps, tierLimits, order, flow: makeTierLimitsFlow(deps) };
}

describe("roles (R9 step 2, R10)", () => {
  it("are those of the catalog area", () => {
    expect([...FLAG_ROLES].sort()).toEqual(["ops", "superadmin"]);
  });
  it.each(["support", "finance"] as const)(
    "%s cannot save limits, and nothing else runs",
    async (role) => {
      const { flow, tierLimits, deps } = setup(role);
      expect(await flow.saveTierLimits(REQUEST)).toEqual({ ok: false, code: "denied", fields: [] });
      expect(tierLimits.save).not.toHaveBeenCalled();
      expect(deps.limiter).not.toHaveBeenCalled();
      expect(deps.run).not.toHaveBeenCalled();
    },
  );
  it("a wrong role from authorize, or an authorize that throws, is a refusal", async () => {
    const wrong = setup("ops", { authorize: async () => actorOf("finance") });
    expect((await wrong.flow.saveTierLimits(REQUEST)).ok).toBe(false);
    const thrown = setup("ops", {
      authorize: async () => {
        throw new Error("no session");
      },
    });
    expect((await thrown.flow.saveTierLimits(REQUEST)).ok).toBe(false);
    expect(thrown.deps.run).not.toHaveBeenCalled();
  });
  it.each(["ops", "superadmin"] as const)("%s can save", async (role) => {
    expect((await setup(role).flow.saveTierLimits(REQUEST)).ok).toBe(true);
  });
});

describe("saveTierLimits", () => {
  it("authorize, validate, rate limit, then the audited save, with the form read as numbers and switches", async () => {
    const { flow, order, tierLimits } = setup();
    const answer = await flow.saveTierLimits({ ...REQUEST, windows: "on" });
    expect(answer).toEqual({ ok: true, replayed: false, value: { market: "BD", tier: "new" } });
    expect(order).toEqual(["authorize", "limit", "run", "save"]);
    expect(tierLimits.save).toHaveBeenCalledWith(
      {
        market: "BD",
        tier: "new",
        limits: {
          maxInstances: 20,
          maxBundleUsd: "24",
          windows: true,
          containers: false,
          maxStaticIps: 2,
        },
      },
      "pilot customers need more",
    );
  });

  it("names the fields that are wrong and does nothing else", async () => {
    const { flow, deps, tierLimits } = setup();
    for (const [over, fields] of [
      [{ market: "bd" }, ["market"]],
      [{ tier: "vip" }, ["tier"]],
      [{ tier: "" }, ["tier"]],
      [{ maxInstances: "0" }, ["maxInstances"]],
      [{ maxInstances: "1.5" }, ["maxInstances"]],
      [{ maxInstances: "-2" }, ["maxInstances"]],
      [{ maxInstances: "100001" }, ["maxInstances"]],
      [{ maxInstances: "abc" }, ["maxInstances"]],
      [{ maxStaticIps: "-1" }, ["maxStaticIps"]],
      [{ maxBundleUsd: "0" }, ["maxBundleUsd"]],
      [{ maxBundleUsd: "1e3" }, ["maxBundleUsd"]],
      [{ maxBundleUsd: "-4" }, ["maxBundleUsd"]],
      [{ windows: "yes" }, ["windows"]],
      [{ containers: "true" }, ["containers"]],
      [{ reason: "  " }, ["reason"]],
      [{ maxInstances: 5 }, ["maxInstances"]],
    ] as const) {
      expect(await flow.saveTierLimits({ ...REQUEST, ...over }), JSON.stringify(over)).toEqual({
        ok: false,
        code: "invalid",
        fields,
      });
    }
    expect(deps.limiter).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(tierLimits.save).not.toHaveBeenCalled();
  });

  it("an over-limit admin, a refusal of the repository and a failing database are fixed codes", async () => {
    const limited = setup("ops", { limiter: async () => false });
    expect(await limited.flow.saveTierLimits(REQUEST)).toEqual({
      ok: false,
      code: "rate_limited",
      fields: [],
    });
    for (const [error, code] of [
      ["forbidden", "denied"],
      ["validation", "invalid"],
    ] as const) {
      const s = setup();
      s.tierLimits.save.mockResolvedValueOnce({ ok: false, error } as never);
      expect(await s.flow.saveTierLimits(REQUEST)).toMatchObject({ ok: false, code });
    }
    const down = setup();
    down.tierLimits.save.mockRejectedValueOnce(new Error("database down"));
    const answer = await down.flow.saveTierLimits(REQUEST);
    expect(answer).toEqual({ ok: false, code: "unavailable", fields: [] });
    expect(JSON.stringify(answer)).not.toContain("database down");
  });

  it("a replay is reported as a replay", async () => {
    const s = setup();
    s.tierLimits.save.mockResolvedValueOnce({
      ok: true,
      replayed: true,
      value: { market: "BD", tier: "new", limits: {} },
    } as never);
    expect(await s.flow.saveTierLimits(REQUEST)).toMatchObject({ ok: true, replayed: true });
  });
});
