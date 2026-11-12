import type { AdminActor, AdminRole } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import { makeConfigPriceFlow, type SaveConfigPriceRequest } from "./config-price-flow.ts";
import { PRICING_ROLES, type PricingFlowDeps } from "./pricing-flow.ts";

// WPU-G10: the prices that no AWS API fills (load balancer, snapshot, block storage, hosted zone). The order
// of R9: authorize (finance and superadmin), validate, rate limit, then in one transaction the same preview
// the screen showed and the audited write. Answers are fixed codes and field names (R14, R16).
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const NOW = new Date("2026-11-12T06:00:00.000Z");
const TX = Symbol("tx") as never;
const actorOf = (role: AdminRole): AdminActor => ({ adminId: ADMIN_ID, role, ip: "203.0.113.7" });
const KEY = "config_price.load_balancer_month";

const REQUEST: SaveConfigPriceRequest = {
  market: "BD",
  key: KEY,
  usd: "18",
  from: "",
  reason: "AWS price page of today",
};

function setup(
  role: AdminRole = "finance",
  over: Partial<PricingFlowDeps> = {},
  preview: "ok" | "refused" | "throws" = "ok",
) {
  const order: string[] = [];
  const configPrices = {
    read: vi.fn(),
    save: vi.fn(async (input: { effectiveFrom: Date; key: string; usd: string }) => {
      order.push("save");
      return {
        ok: true,
        replayed: false,
        value: {
          key: input.key,
          entry: { from: input.effectiveFrom, usd: input.usd },
          laterChangePending: null,
        },
      };
    }),
  };
  const previewConfigPrice = vi.fn(async () => {
    order.push("preview");
    if (preview === "throws") throw new Error("database down");
    return preview === "refused"
      ? { ok: false, error: "not_found", fields: { fxRate: "not_in_force" } }
      : { ok: true, value: { fxRate: "127", current: null, candidate: {}, deltaMinor: null } };
  });
  const deps = {
    repos: () => ({ configPrices }) as never,
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
    core: { previewConfigPrice } as never,
    stage: "staging",
    ...over,
  } as unknown as PricingFlowDeps;
  return { deps, configPrices, previewConfigPrice, order, flow: makeConfigPriceFlow(deps) };
}

describe("roles (R9 step 2, R10)", () => {
  it("are the roles of the pricing area", () => {
    expect([...PRICING_ROLES].sort()).toEqual(["finance", "superadmin"]);
  });
  it.each(["support", "ops"] as const)(
    "%s cannot save a price, and nothing else runs",
    async (role) => {
      const { flow, configPrices, previewConfigPrice, deps } = setup(role);
      expect(await flow.saveConfigPrice(REQUEST)).toEqual({
        ok: false,
        code: "denied",
        fields: [],
      });
      expect(configPrices.save).not.toHaveBeenCalled();
      expect(previewConfigPrice).not.toHaveBeenCalled();
      expect(deps.limiter).not.toHaveBeenCalled();
      expect(deps.run).not.toHaveBeenCalled();
    },
  );
  it("an actor with the wrong role from authorize, or an authorize that throws, is a refusal", async () => {
    const wrong = setup("finance", { authorize: async () => actorOf("support") });
    expect((await wrong.flow.saveConfigPrice(REQUEST)).ok).toBe(false);
    const thrown = setup("finance", {
      authorize: async () => {
        throw new Error("no session");
      },
    });
    expect(await thrown.flow.saveConfigPrice(REQUEST)).toEqual({
      ok: false,
      code: "denied",
      fields: [],
    });
    expect(thrown.deps.run).not.toHaveBeenCalled();
  });
  it.each(["finance", "superadmin"] as const)("%s can save", async (role) => {
    expect((await setup(role).flow.saveConfigPrice(REQUEST)).ok).toBe(true);
  });
});

describe("saveConfigPrice", () => {
  it("authorize, validate, rate limit, then the preview and the save in one transaction", async () => {
    const { flow, order, configPrices, previewConfigPrice } = setup();
    const answer = await flow.saveConfigPrice(REQUEST);
    expect(answer).toEqual({
      ok: true,
      replayed: false,
      value: { key: KEY, effectiveFrom: NOW, laterChangePending: null },
    });
    expect(order).toEqual(["authorize", "limit", "run", "preview", "save"]);
    expect(previewConfigPrice).toHaveBeenCalledWith(
      TX,
      { market: "BD", key: KEY, usd: "18" },
      expect.anything(),
    );
    expect(configPrices.save).toHaveBeenCalledWith(
      { market: "BD", key: KEY, usd: "18", effectiveFrom: NOW, at: NOW },
      "AWS price page of today",
    );
  });

  it("a start typed in Dhaka time is the instant at UTC+6", async () => {
    const { flow, configPrices } = setup();
    await flow.saveConfigPrice({ ...REQUEST, from: "2026-11-20T09:30" });
    expect(configPrices.save.mock.calls[0]?.[0].effectiveFrom).toEqual(
      new Date("2026-11-20T03:30:00.000Z"),
    );
  });

  it("names the fields that are wrong and does nothing else (no limiter, no transaction)", async () => {
    const { flow, deps, configPrices } = setup();
    for (const [over, fields] of [
      [{ market: "bd" }, ["market"]],
      [{ key: "config_price.other" }, ["key"]],
      [{ key: "price_book.disk" }, ["key"]],
      [{ usd: "0" }, ["usd"]],
      [{ usd: "-3" }, ["usd"]],
      [{ usd: "1e3" }, ["usd"]],
      [{ usd: "1.23456" }, ["usd"]],
      [{ usd: " " }, ["usd"]],
      [{ usd: 18 }, ["usd"]],
      [{ from: "tomorrow" }, ["from"]],
      [{ reason: "" }, ["reason"]],
      [{ reason: "x".repeat(501) }, ["reason"]],
      [{ market: 5, key: null, usd: null }, ["market", "key", "usd"]],
    ] as const) {
      expect(await flow.saveConfigPrice({ ...REQUEST, ...over }), JSON.stringify(over)).toEqual({
        ok: false,
        code: "invalid",
        fields,
      });
    }
    expect(deps.limiter).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(configPrices.save).not.toHaveBeenCalled();
  });

  it("a price the engine cannot price (no rate or rule in force) is not saved (R16)", async () => {
    const { flow, configPrices } = setup("finance", {}, "refused");
    expect(await flow.saveConfigPrice(REQUEST)).toEqual({
      ok: false,
      code: "not_found",
      fields: [],
    });
    expect(configPrices.save).not.toHaveBeenCalled();
  });

  it("an over-limit admin and a failing database are fixed refusals without the error text", async () => {
    const limited = setup("finance", { limiter: async () => false });
    expect(await limited.flow.saveConfigPrice(REQUEST)).toEqual({
      ok: false,
      code: "rate_limited",
      fields: [],
    });
    expect(limited.deps.run).not.toHaveBeenCalled();
    const down = setup("finance", {}, "throws");
    const answer = await down.flow.saveConfigPrice(REQUEST);
    expect(answer).toEqual({ ok: false, code: "unavailable", fields: [] });
    expect(JSON.stringify(answer)).not.toContain("database down");
  });

  it("the repository's refusals map to fixed codes", async () => {
    for (const [error, code] of [
      ["conflict", "conflict"],
      ["forbidden", "denied"],
      ["validation", "invalid"],
    ] as const) {
      const s = setup();
      s.configPrices.save.mockResolvedValueOnce({ ok: false, error } as never);
      expect((await s.flow.saveConfigPrice(REQUEST)) as { code?: string }).toMatchObject({ code });
    }
  });

  it("a replay is reported as a replay", async () => {
    const s = setup();
    s.configPrices.save.mockResolvedValueOnce({
      ok: true,
      replayed: true,
      value: { key: KEY, entry: { from: NOW, usd: "18" }, laterChangePending: null },
    } as never);
    expect(await s.flow.saveConfigPrice(REQUEST)).toMatchObject({ ok: true, replayed: true });
  });
});
