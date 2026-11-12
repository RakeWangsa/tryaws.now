import type { AdminActor, AdminRole } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import { PRICING_ROLES, type PricingFlowDeps } from "./pricing-flow.ts";
import { makeInvoiceSellerFlow, type SaveInvoiceSellerRequest } from "./invoice-seller-flow.ts";

// WPU-I1: the seller of the tax invoices. The order of R9: authorize (finance and superadmin, the roles of
// the pricing area), validate, rate limit, execute in one transaction, audit (inside the repository, R10).
const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const NOW = new Date("2026-11-12T06:00:00.000Z");
const TX = Symbol("tx") as never;
const actorOf = (role: AdminRole): AdminActor => ({ adminId: ADMIN_ID, role, ip: "203.0.113.7" });

const REQUEST: SaveInvoiceSellerRequest = {
  market: "BD",
  legalNameBn: "পরীক্ষা লিমিটেড",
  legalNameEn: "Test Limited",
  bin: "0000000000000",
  addressBn: "ঢাকা",
  addressEn: "Dhaka",
  vatCircle: "",
  signatoryName: "Test Signatory",
  signatoryDesignation: "Director",
  phone: "",
  email: "",
  reason: "from the registration certificate",
};

function setup(role: AdminRole = "finance", over: Partial<PricingFlowDeps> = {}) {
  const order: string[] = [];
  const invoiceSeller = {
    read: vi.fn(),
    save: vi.fn(async (input: { market: string }) => {
      order.push("save");
      return { ok: true, replayed: false, value: { market: input.market, version: 1 } };
    }),
  };
  const deps = {
    repos: () => ({ invoiceSeller }) as never,
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
  return { deps, invoiceSeller, order, flow: makeInvoiceSellerFlow(deps) };
}

describe("roles (R9 step 2, R10)", () => {
  it("are those of the pricing area", () => {
    expect([...PRICING_ROLES].sort()).toEqual(["finance", "superadmin"]);
  });
  it.each(["support", "ops"] as const)("%s cannot save, and nothing else runs", async (role) => {
    const { flow, invoiceSeller, deps } = setup(role);
    expect(await flow.saveInvoiceSeller(REQUEST)).toEqual({
      ok: false,
      code: "denied",
      fields: [],
    });
    expect(invoiceSeller.save).not.toHaveBeenCalled();
    expect(deps.limiter).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("a wrong role from authorize, or an authorize that throws, is a refusal", async () => {
    const wrong = setup("finance", { authorize: async () => actorOf("ops") });
    expect((await wrong.flow.saveInvoiceSeller(REQUEST)).ok).toBe(false);
    const thrown = setup("finance", {
      authorize: async () => {
        throw new Error("no session");
      },
    });
    expect((await thrown.flow.saveInvoiceSeller(REQUEST)).ok).toBe(false);
    expect(thrown.deps.run).not.toHaveBeenCalled();
  });
  it.each(["finance", "superadmin"] as const)("%s can save", async (role) => {
    expect((await setup(role).flow.saveInvoiceSeller(REQUEST)).ok).toBe(true);
  });
});

describe("saveInvoiceSeller", () => {
  it("authorize, validate, rate limit, then the audited save with the reason", async () => {
    const { flow, order, invoiceSeller } = setup();
    expect(await flow.saveInvoiceSeller(REQUEST)).toEqual({
      ok: true,
      replayed: false,
      value: { market: "BD", version: 1 },
    });
    expect(order).toEqual(["authorize", "limit", "run", "save"]);
    const [input, reason] = invoiceSeller.save.mock.calls[0] as unknown as [
      { market: string; seller: Record<string, string> },
      string,
    ];
    expect(reason).toBe("from the registration certificate");
    expect(input.market).toBe("BD");
    expect(input.seller["bin"]).toBe("0000000000000");
    // empty optional fields are not stored
    expect(input.seller).not.toHaveProperty("vatCircle");
    expect(input.seller).not.toHaveProperty("phone");
  });

  it("names the fields that are wrong and does nothing else (a BIN of 12 digits, a blank address)", async () => {
    const { flow, deps, invoiceSeller } = setup();
    for (const [over, fields] of [
      [{ market: "bd" }, ["market"]],
      [{ bin: "123456789012" }, ["bin"]],
      [{ bin: "12345678901234" }, ["bin"]],
      [{ bin: "০০০০০০০০০০০০০" }, ["bin"]],
      [{ addressEn: "  " }, ["addressEn"]],
      [{ legalNameBn: "" }, ["legalNameBn"]],
      [{ signatoryName: "" }, ["signatoryName"]],
      [{ email: "nope" }, ["email"]],
      [{ reason: "" }, ["reason"]],
      [{ bin: 5 }, ["bin"]],
    ] as const) {
      const answer = await flow.saveInvoiceSeller({ ...REQUEST, ...over });
      expect(answer, JSON.stringify(over)).toEqual({ ok: false, code: "invalid", fields });
    }
    expect(invoiceSeller.save).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.limiter).not.toHaveBeenCalled();
  });

  it("an answer never holds the value that was refused (R14)", async () => {
    const { flow } = setup();
    const answer = await flow.saveInvoiceSeller({ ...REQUEST, bin: "SECRET-BIN" });
    expect(JSON.stringify(answer)).not.toContain("SECRET-BIN");
  });

  it("over the rate limit: rate_limited, nothing saved", async () => {
    const { flow, invoiceSeller } = setup("finance", { limiter: async () => false });
    expect(await flow.saveInvoiceSeller(REQUEST)).toEqual({
      ok: false,
      code: "rate_limited",
      fields: [],
    });
    expect(invoiceSeller.save).not.toHaveBeenCalled();
  });

  it("a failing database is unavailable, a repository refusal maps to a fixed code (R16)", async () => {
    const down = setup("finance", {
      run: async () => {
        throw new Error("db down");
      },
    });
    expect(await down.flow.saveInvoiceSeller(REQUEST)).toEqual({
      ok: false,
      code: "unavailable",
      fields: [],
    });
    const refused = setup();
    refused.invoiceSeller.save.mockResolvedValueOnce({ ok: false, error: "forbidden" } as never);
    expect((await refused.flow.saveInvoiceSeller(REQUEST)).ok).toBe(false);
  });

  it("a replay is reported as a replay", async () => {
    const { flow, invoiceSeller } = setup();
    invoiceSeller.save.mockResolvedValueOnce({
      ok: true,
      replayed: true,
      value: { market: "BD", version: 3 },
    } as never);
    expect(await flow.saveInvoiceSeller(REQUEST)).toMatchObject({ ok: true, replayed: true });
  });
});
