import type { AdminActor, AdminRole } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import {
  FLAG_ROLES,
  PRICING_ROLES,
  makePricingFlow,
  type CorePorts,
  type PricingFlowDeps,
} from "./pricing-flow.ts";

const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const OTHER_ID = "0191a000-0000-7000-8000-0000000000ae";
const NOW = new Date("2026-11-12T06:00:00.000Z");
const TX = Symbol("tx") as never;

const actorOf = (role: AdminRole): AdminActor => ({ adminId: ADMIN_ID, role, ip: "203.0.113.7" });

const STEP = { code: "markup", rate: "0.15", base: "subtotal", bn: "মার্কআপ", en: "Markup" };
const RULE = { market: "BD", family: null, steps: [STEP], from: "", reason: "festival offer" };

function setup(role: AdminRole = "finance", over: Partial<PricingFlowDeps> = {}) {
  const order: string[] = [];
  const core: CorePorts = {
    previewChange: vi.fn(async () => {
      order.push("preview");
      return { ok: true, value: { rows: [] } };
    }) as never,
    savePricingRule: vi.fn(async () => {
      order.push("save");
      return {
        ok: true,
        value: { ruleId: "r1", productFamily: null, effectiveFrom: NOW, replayed: false },
      };
    }) as never,
    setFxRate: vi.fn(async () => {
      order.push("fx");
      return {
        ok: true,
        value: {
          fx: { id: "f1", market: "BD", rate: "122.5", effectiveFrom: NOW },
          replayed: false,
        },
      };
    }) as never,
    setFeatureFlag: vi.fn(async () => {
      order.push("flag");
      return {
        ok: true,
        value: { key: "backup", market: "BD", enabled: true, replayed: false },
      };
    }) as never,
  };
  const deps: PricingFlowDeps = {
    authorize: vi.fn(async (roles: readonly AdminRole[]) => {
      order.push("authorize");
      if (!roles.includes(role)) throw new Error("no");
      return actorOf(role);
    }),
    limiter: vi.fn(async () => {
      order.push("limit");
      return true;
    }),
    run: vi.fn(async (_actor, fn) => {
      order.push("run");
      return fn(TX);
    }),
    clock: { now: () => NOW },
    core,
    stage: "staging",
    ...over,
  };
  return { deps, core, order, flow: makePricingFlow(deps) };
}

describe("roles", () => {
  it("pricing and FX are for finance and superadmin, flags for ops and superadmin (16.12)", () => {
    expect([...PRICING_ROLES].sort()).toEqual(["finance", "superadmin"]);
    expect([...FLAG_ROLES].sort()).toEqual(["ops", "superadmin"]);
  });

  it.each(["support", "ops"] as const)("%s cannot save a rule or set a rate", async (role) => {
    const { flow, core, deps } = setup(role);
    expect(await flow.saveRule(RULE)).toEqual({ ok: false, code: "denied", fields: [] });
    expect(
      await flow.setFx({ market: "BD", rate: "122", from: "", reason: "why", requestedBy: "" }),
    ).toEqual({ ok: false, code: "denied", fields: [] });
    expect(core.savePricingRule).not.toHaveBeenCalled();
    expect(core.setFxRate).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each(["support", "finance"] as const)("%s cannot switch a flag", async (role) => {
    const { flow, core } = setup(role);
    const answer = await flow.setFlag({
      key: "backup",
      market: "BD",
      enabled: true,
      reason: "launch day",
    });
    expect(answer).toEqual({ ok: false, code: "denied", fields: [] });
    expect(core.setFeatureFlag).not.toHaveBeenCalled();
  });

  it("an authorize that answers an actor with the wrong role is still refused (defence in depth)", async () => {
    const { flow, core } = setup("finance", { authorize: async () => actorOf("support") });
    expect((await flow.saveRule(RULE)).ok).toBe(false);
    expect(core.savePricingRule).not.toHaveBeenCalled();
  });

  it("superadmin does all three", async () => {
    const { flow } = setup("superadmin");
    expect((await flow.saveRule(RULE)).ok).toBe(true);
    expect(
      (await flow.setFlag({ key: "backup", market: "BD", enabled: true, reason: "go" })).ok,
    ).toBe(true);
  });
});

describe("saveRule: R9 order and the preview", () => {
  it("authenticate and authorize, validate, rate limit, then preview and save in one transaction", async () => {
    const { flow, order } = setup();
    const answer = await flow.saveRule(RULE);
    expect(answer).toEqual({
      ok: true,
      replayed: false,
      value: { ruleId: "r1", effectiveFrom: NOW },
    });
    expect(order).toEqual(["authorize", "limit", "run", "preview", "save"]);
  });

  it("the preview of the same draft runs first and a refused preview stops the save (R16)", async () => {
    const { flow, core } = setup();
    (core.previewChange as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: "validation",
      fields: { "steps[0].rate": "bad" },
    });
    const answer = await flow.saveRule(RULE);
    expect(answer).toEqual({ ok: false, code: "invalid", fields: ["steps[0].rate"] });
    expect(core.savePricingRule).not.toHaveBeenCalled();
  });

  it("gives the engine the steps with their labels and the start as a Dhaka time", async () => {
    const { flow, core } = setup();
    await flow.saveRule({ ...RULE, from: "2026-11-20T09:30", family: "backup" });
    expect(core.savePricingRule).toHaveBeenCalledWith(
      TX,
      actorOf("finance"),
      {
        market: "BD",
        productFamily: "backup",
        steps: [
          {
            code: "markup",
            rate: "0.15",
            base: "subtotal",
            label: { bn: "মার্কআপ", en: "Markup" },
          },
        ],
        effectiveFrom: new Date("2026-11-20T03:30:00.000Z"),
        reason: "festival offer",
      },
      deps_clock(),
    );
  });

  it("answers replayed for the same rule saved twice (R7)", async () => {
    const { flow, core } = setup();
    (core.savePricingRule as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      value: { ruleId: "r1", productFamily: null, effectiveFrom: NOW, replayed: true },
    });
    expect(await flow.saveRule(RULE)).toMatchObject({ ok: true, replayed: true });
  });

  it.each([
    ["no reason", { reason: "  " }],
    ["a reason over 500 characters", { reason: "x".repeat(501) }],
    ["a market that is not two capitals", { market: "bd" }],
    ["a family that is not a key", { family: "Not A Key" }],
    ["no steps", { steps: [] }],
    ["too many steps", { steps: Array.from({ length: 9 }, () => STEP) }],
    ["a step that is not an object", { steps: ["markup"] }],
    ["a rate that is a number", { steps: [{ ...STEP, rate: 0.15 }] }],
    ["a base that is neither aws nor subtotal", { steps: [{ ...STEP, base: "net" }] }],
    ["a start that is not a time", { from: "tomorrow" }],
  ])("rejects %s before anything else happens", async (_name, over) => {
    const { flow, deps, core } = setup();
    const answer = await flow.saveRule({ ...RULE, ...over } as never);
    expect(answer).toMatchObject({ ok: false, code: "invalid" });
    expect(deps.limiter).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(core.savePricingRule).not.toHaveBeenCalled();
  });

  it("maps the engine's refusals to fixed codes and never shows its text", async () => {
    const { flow, core } = setup();
    const save = core.savePricingRule as ReturnType<typeof vi.fn>;
    save.mockResolvedValueOnce({
      ok: false,
      error: "conflict",
      fields: { effectiveFrom: "taken_by_other_steps" },
    });
    expect(await flow.saveRule(RULE)).toEqual({ ok: false, code: "conflict", fields: [] });
    save.mockResolvedValueOnce({ ok: false, error: "validation", fields: { reason: "required" } });
    expect(await flow.saveRule(RULE)).toEqual({ ok: false, code: "invalid", fields: ["reason"] });
    save.mockResolvedValueOnce({ ok: false, error: "internal" });
    expect(await flow.saveRule(RULE)).toEqual({ ok: false, code: "unavailable", fields: [] });
  });

  it("is rate limited, and the limit runs before the write", async () => {
    const { flow, core } = setup("finance", { limiter: async () => false });
    expect(await flow.saveRule(RULE)).toEqual({ ok: false, code: "rate_limited", fields: [] });
    expect(core.savePricingRule).not.toHaveBeenCalled();
  });

  it("fails closed when the database or the limiter throws, with no text of the error", async () => {
    const boom = setup("finance", {
      run: async () => {
        throw new Error("password=secret host=db.internal");
      },
    });
    const answer = await boom.flow.saveRule(RULE);
    expect(answer).toEqual({ ok: false, code: "unavailable", fields: [] });
    expect(JSON.stringify(answer)).not.toContain("secret");
    const limiter = setup("finance", {
      limiter: async () => {
        throw new Error("down");
      },
    });
    expect(await limiter.flow.saveRule(RULE)).toEqual({
      ok: false,
      code: "unavailable",
      fields: [],
    });
  });

  it("a getter cannot answer differently on the second read", async () => {
    const { flow, core } = setup();
    let reads = 0;
    const tricky = {
      ...RULE,
      get reason() {
        reads += 1;
        return reads === 1 ? "first" : "";
      },
    };
    await flow.saveRule(tricky);
    expect((core.savePricingRule as ReturnType<typeof vi.fn>).mock.calls[0]?.[2].reason).toBe(
      "first",
    );
  });
});

describe("setFx", () => {
  const FX = { market: "BD", rate: "122.5", from: "", reason: "bank rate", requestedBy: "" };

  it("saves a rate in the order of R9 and gives no second admin when none was named", async () => {
    const { flow, core, order } = setup();
    const answer = await flow.setFx(FX);
    expect(answer).toMatchObject({ ok: true, replayed: false });
    expect(order).toEqual(["authorize", "limit", "run", "fx"]);
    expect(core.setFxRate).toHaveBeenCalledWith(
      TX,
      actorOf("finance"),
      { market: "BD", rate: "122.5", reason: "bank rate" },
      deps_clock(),
    );
  });

  it("passes the second admin when one is named", async () => {
    const { flow, core } = setup();
    await flow.setFx({ ...FX, requestedBy: OTHER_ID });
    expect((core.setFxRate as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      requestedBy: OTHER_ID,
    });
  });

  it.each(["second_admin_required", "must_differ_from_actor", "not_an_approver"])(
    "a change above the percent is answered %s",
    async (token) => {
      const { flow, core } = setup();
      (core.setFxRate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: "forbidden",
        fields: { requestedBy: token },
      });
      expect(await flow.setFx(FX)).toEqual({ ok: false, code: token, fields: [] });
    },
  );

  it.each([
    ["a rate with an exponent", { rate: "1e2" }],
    ["a rate that is a number", { rate: 122.5 }],
    ["a second admin that is no id", { requestedBy: "me" }],
    ["no reason", { reason: "" }],
  ])("rejects %s", async (_name, over) => {
    const { flow, core } = setup();
    const answer = await flow.setFx({ ...FX, ...over } as never);
    expect(answer).toMatchObject({ ok: false, code: "invalid" });
    expect(core.setFxRate).not.toHaveBeenCalled();
  });
});

describe("setFlag", () => {
  const FLAG = { key: "backup", market: "BD", enabled: true, reason: "backup is ready" };

  it("switches a family in the order of R9", async () => {
    const { flow, core, order } = setup("ops");
    expect(await flow.setFlag(FLAG)).toMatchObject({ ok: true, replayed: false });
    expect(order).toEqual(["authorize", "limit", "run", "flag"]);
    expect(core.setFeatureFlag).toHaveBeenCalledWith(TX, actorOf("ops"), FLAG);
  });

  it("rejects an unknown key and a value that is not a boolean", async () => {
    const { flow, core } = setup("ops");
    expect((await flow.setFlag({ ...FLAG, key: "rocket" })).ok).toBe(false);
    expect((await flow.setFlag({ ...FLAG, enabled: "yes" as never })).ok).toBe(false);
    expect(core.setFeatureFlag).not.toHaveBeenCalled();
  });

  it("turning a family ON in production needs a real reason; OFF and staging need only a reason", async () => {
    const prod = setup("ops", { stage: "production" });
    expect(await prod.flow.setFlag({ ...FLAG, reason: "ok" })).toEqual({
      ok: false,
      code: "invalid",
      fields: ["reason"],
    });
    expect(prod.core.setFeatureFlag).not.toHaveBeenCalled();
    expect((await prod.flow.setFlag(FLAG)).ok).toBe(true);
    expect((await prod.flow.setFlag({ ...FLAG, enabled: false, reason: "ok" })).ok).toBe(true);
    const staging = setup("ops", { stage: "staging" });
    expect((await staging.flow.setFlag({ ...FLAG, reason: "ok" })).ok).toBe(true);
  });

  it("an unknown stage is treated as production (R16)", async () => {
    const { flow } = setup("ops", { stage: "" });
    expect((await flow.setFlag({ ...FLAG, reason: "ok" })).ok).toBe(false);
  });
});

function deps_clock() {
  return expect.objectContaining({ now: expect.any(Function) });
}
