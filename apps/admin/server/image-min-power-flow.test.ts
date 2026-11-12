import type { AdminActor, AdminRole } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import { makePricingFlow, type PricingFlowDeps } from "./pricing-flow.ts";

// WPU-G10: the admin's minimum plan power for one image (replaces what AWS reported). Ops and superadmin,
// as the other switches of the catalog; the order of R9; the audited write is in the repository.
const NOW = new Date("2026-11-12T06:00:00.000Z");
const TX = Symbol("tx") as never;
const actorOf = (role: AdminRole): AdminActor => ({
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role,
  ip: "203.0.113.7",
});
const REQUEST = {
  blueprintId: "wordpress",
  market: "BD",
  minPower: "1000",
  reason: "WordPress needs 1 GB here",
};

function setup(role: AdminRole = "ops", over: Partial<PricingFlowDeps> = {}) {
  const order: string[] = [];
  const blueprints = {
    list: vi.fn(),
    setEnabled: vi.fn(),
    setMinPower: vi.fn(async (input: { blueprintId: string; minPower: number | null }) => {
      order.push("save");
      return { ok: true, replayed: false, value: { market: "BD", ...input } };
    }),
  };
  const deps = {
    repos: () => ({ blueprints }) as never,
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
  return { deps, blueprints, order, flow: makePricingFlow(deps) };
}

describe("setImageMinPower", () => {
  it("authorizes first, then validates, rate limits and saves; the text is read as a whole number", async () => {
    const { flow, order, blueprints } = setup();
    expect(await flow.setImageMinPower(REQUEST)).toEqual({
      ok: true,
      replayed: false,
      value: { blueprintId: "wordpress", minPower: 1000 },
    });
    expect(order).toEqual(["authorize", "limit", "run", "save"]);
    expect(blueprints.setMinPower).toHaveBeenCalledWith(
      { market: "BD", blueprintId: "wordpress", minPower: 1000 },
      "WordPress needs 1 GB here",
    );
  });

  it("an empty value removes the override; 0 is a real minimum", async () => {
    const { flow, blueprints } = setup();
    await flow.setImageMinPower({ ...REQUEST, minPower: "" });
    expect(blueprints.setMinPower.mock.calls[0]?.[0].minPower).toBeNull();
    await flow.setImageMinPower({ ...REQUEST, minPower: "0" });
    expect(blueprints.setMinPower.mock.calls[1]?.[0].minPower).toBe(0);
  });

  it.each(["support", "finance"] as const)("%s is denied and nothing else runs", async (role) => {
    const { flow, blueprints, deps } = setup(role);
    expect(await flow.setImageMinPower(REQUEST)).toEqual({ ok: false, code: "denied", fields: [] });
    expect(blueprints.setMinPower).not.toHaveBeenCalled();
    expect(deps.limiter).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("names the wrong fields and does nothing else", async () => {
    const { flow, deps, blueprints } = setup();
    for (const [over, fields] of [
      [{ blueprintId: "Not An Id" }, ["blueprintId"]],
      [{ market: "bd" }, ["market"]],
      [{ minPower: "-1" }, ["minPower"]],
      [{ minPower: "1.5" }, ["minPower"]],
      [{ minPower: "100001" }, ["minPower"]],
      [{ minPower: "1 GB" }, ["minPower"]],
      [{ reason: "" }, ["reason"]],
    ] as const) {
      expect(await flow.setImageMinPower({ ...REQUEST, ...over }), JSON.stringify(over)).toEqual({
        ok: false,
        code: "invalid",
        fields,
      });
    }
    expect(deps.run).not.toHaveBeenCalled();
    expect(blueprints.setMinPower).not.toHaveBeenCalled();
  });

  it("an image the sync never listed is not_found; a failing database is unavailable", async () => {
    const s = setup();
    s.blueprints.setMinPower.mockResolvedValueOnce({ ok: false, error: "not_found" } as never);
    expect(await s.flow.setImageMinPower(REQUEST)).toEqual({
      ok: false,
      code: "not_found",
      fields: [],
    });
    const d = setup();
    d.blueprints.setMinPower.mockRejectedValueOnce(new Error("database down"));
    expect(await d.flow.setImageMinPower(REQUEST)).toEqual({
      ok: false,
      code: "unavailable",
      fields: [],
    });
  });
});
