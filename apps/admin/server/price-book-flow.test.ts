import type { AdminActor, AdminRole } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import { makePriceBookFlow, type SaveBookRequest } from "./price-book-flow.ts";
import { PRICING_ROLES, type PricingFlowDeps } from "./pricing-flow.ts";

const ADMIN_ID = "0191a000-0000-7000-8000-0000000000ad";
const PRODUCT = "0191a000-0000-7000-8000-0000000000b1";
const NOW = new Date("2026-11-12T06:00:00.000Z");
const TX = Symbol("tx") as never;
const actorOf = (role: AdminRole): AdminActor => ({ adminId: ADMIN_ID, role, ip: "203.0.113.7" });

const BOOK: SaveBookRequest = {
  market: "BD",
  family: "disk",
  marginKind: "percent",
  margin: "15",
  commissionKind: "percent",
  commission: "20",
  from: "",
  reason: "new price list",
};
const BASE = {
  market: "BD",
  family: "disk",
  catalogProductId: PRODUCT,
  awsPriceUsd: "0.125",
  reason: "AWS price page",
};

function setup(role: AdminRole = "finance", over: Partial<PricingFlowDeps> = {}) {
  const order: string[] = [];
  const priceBook = {
    read: vi.fn(),
    save: vi.fn(async (input: { effectiveFrom: Date }) => {
      order.push("save");
      return {
        ok: true,
        replayed: false,
        value: {
          family: "disk",
          entry: { from: input.effectiveFrom },
          laterChangePending: null,
        },
      };
    }),
    setBaseCost: vi.fn(async () => {
      order.push("setBase");
      return {
        ok: true,
        replayed: false,
        value: {
          catalogProductId: PRODUCT,
          family: "disk",
          region: "ap-south-1",
          awsPriceUsd: "0.125",
        },
      };
    }),
  };
  const previewBook = vi.fn(async () => {
    order.push("preview");
    return { ok: true, value: { fxRate: "127", fromSamples: false, rows: [] } };
  });
  const deps = {
    repos: () => ({ priceBook }) as never,
    authorize: vi.fn(async (roles: readonly AdminRole[]) => {
      order.push("authorize");
      if (!roles.includes(role)) throw new Error("no");
      return actorOf(role);
    }),
    limiter: vi.fn(async () => {
      order.push("limit");
      return true;
    }),
    run: vi.fn(async (_actor: AdminActor, fn: (tx: never) => Promise<unknown>) => {
      order.push("run");
      return fn(TX);
    }),
    clock: { now: () => NOW },
    core: { previewBook } as never,
    stage: "staging",
    ...over,
  } as unknown as PricingFlowDeps;
  return { deps, priceBook, previewBook, order, flow: makePriceBookFlow(deps) };
}

describe("roles (R9 step 2, R10)", () => {
  it("is for finance and superadmin", () => {
    expect([...PRICING_ROLES].sort()).toEqual(["finance", "superadmin"]);
  });

  it.each(["support", "ops"] as const)("%s cannot save terms or a base cost", async (role) => {
    const { flow, priceBook, previewBook, deps } = setup(role);
    expect(await flow.saveBook(BOOK)).toEqual({ ok: false, code: "denied", fields: [] });
    expect(await flow.setBaseCost(BASE)).toEqual({ ok: false, code: "denied", fields: [] });
    expect(priceBook.save).not.toHaveBeenCalled();
    expect(priceBook.setBaseCost).not.toHaveBeenCalled();
    expect(previewBook).not.toHaveBeenCalled();
    expect(deps.limiter).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("an authorize that answers an actor with the wrong role is still refused (defence in depth)", async () => {
    const { flow, priceBook } = setup("finance", { authorize: async () => actorOf("support") });
    expect((await flow.saveBook(BOOK)).ok).toBe(false);
    expect((await flow.setBaseCost(BASE)).ok).toBe(false);
    expect(priceBook.save).not.toHaveBeenCalled();
  });

  it("an authorize that throws is a refusal", async () => {
    const { flow, deps } = setup("finance", {
      authorize: async () => {
        throw new Error("no session");
      },
    });
    expect(await flow.saveBook(BOOK)).toEqual({ ok: false, code: "denied", fields: [] });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each(["finance", "superadmin"] as const)("%s can do both", async (role) => {
    const { flow } = setup(role);
    expect((await flow.saveBook(BOOK)).ok).toBe(true);
    expect((await flow.setBaseCost(BASE)).ok).toBe(true);
  });
});

describe("saveBook: the order of R9 and the preview", () => {
  it("authorize, validate, rate limit, then preview and save in one transaction", async () => {
    const { flow, order, priceBook, previewBook } = setup();
    const answer = await flow.saveBook(BOOK);
    expect(answer).toEqual({
      ok: true,
      replayed: false,
      value: { family: "disk", effectiveFrom: NOW, laterChangePending: null },
    });
    expect(order).toEqual(["authorize", "limit", "run", "preview", "save"]);
    // the percent typed as percent reaches the engine as a fraction
    expect(previewBook).toHaveBeenCalledWith(
      TX,
      {
        market: "BD",
        productFamily: "disk",
        terms: {
          margin: { kind: "percent", value: "0.15" },
          commission: { kind: "percent", value: "0.2" },
        },
      },
      expect.anything(),
    );
    expect(priceBook.save).toHaveBeenCalledWith(
      {
        market: "BD",
        family: "disk",
        margin: { kind: "percent", value: "0.15" },
        commission: { kind: "percent", value: "0.2" },
        effectiveFrom: NOW,
        at: NOW,
      },
      "new price list",
    );
  });

  it("a fixed margin is whole paisa for each unit and no commission is null", async () => {
    const { flow, priceBook } = setup();
    await flow.saveBook({ ...BOOK, marginKind: "fixed", margin: "500", commissionKind: "none" });
    expect(priceBook.save).toHaveBeenCalledWith(
      expect.objectContaining({
        margin: { kind: "fixed", value: "500" },
        commission: null,
      }),
      "new price list",
    );
  });

  it("the start is a Dhaka wall time", async () => {
    const { flow, priceBook } = setup();
    await flow.saveBook({ ...BOOK, from: "2026-11-20T09:30" });
    expect(priceBook.save).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveFrom: new Date("2026-11-20T03:30:00.000Z"), at: NOW }),
      "new price list",
    );
  });

  it("a refused preview stops the save (R16)", async () => {
    const { flow, priceBook, previewBook } = setup();
    previewBook.mockResolvedValueOnce({
      ok: false,
      error: "validation",
      fields: { margin: "bad" },
    } as never);
    expect(await flow.saveBook(BOOK)).toEqual({ ok: false, code: "invalid", fields: ["margin"] });
    expect(priceBook.save).not.toHaveBeenCalled();
  });

  it("no rate or rule in force is not_found, and nothing is saved", async () => {
    const { flow, priceBook, previewBook } = setup();
    previewBook.mockResolvedValueOnce({
      ok: false,
      error: "not_found",
      fields: { fxRate: "not_in_force" },
    } as never);
    expect(await flow.saveBook(BOOK)).toEqual({ ok: false, code: "not_found", fields: [] });
    expect(priceBook.save).not.toHaveBeenCalled();
  });

  it("answers what the repository refused as a fixed code", async () => {
    const { flow, priceBook } = setup();
    priceBook.save.mockResolvedValueOnce({ ok: false, error: "conflict" } as never);
    expect(await flow.saveBook(BOOK)).toEqual({ ok: false, code: "conflict", fields: [] });
    priceBook.save.mockResolvedValueOnce({ ok: false, error: "forbidden" } as never);
    expect(await flow.saveBook(BOOK)).toEqual({ ok: false, code: "denied", fields: [] });
  });

  it("replayed is passed on (R7)", async () => {
    const { flow, priceBook } = setup();
    priceBook.save.mockResolvedValueOnce({
      ok: true,
      replayed: true,
      value: { family: "disk", entry: { from: NOW }, laterChangePending: null },
    } as never);
    expect(await flow.saveBook(BOOK)).toMatchObject({ ok: true, replayed: true });
  });

  it("over the rate limit nothing runs", async () => {
    const { flow, deps, priceBook } = setup("finance", { limiter: async () => false });
    expect(await flow.saveBook(BOOK)).toEqual({ ok: false, code: "rate_limited", fields: [] });
    expect(deps.run).not.toHaveBeenCalled();
    expect(priceBook.save).not.toHaveBeenCalled();
  });

  it("a failing database or limiter is a fixed refusal, with no text of the error (R14, R16)", async () => {
    const { flow } = setup("finance", {
      run: async () => {
        throw new Error("password=secret host=db.internal");
      },
    });
    const answer = await flow.saveBook(BOOK);
    expect(answer).toEqual({ ok: false, code: "unavailable", fields: [] });
    expect(JSON.stringify(answer)).not.toContain("secret");
  });

  it.each([
    ["market", { market: "bd" }],
    ["family", { family: "not_a_family" }],
    ["family", { family: 7 }],
    ["margin", { margin: "abc" }],
    ["margin", { margin: "1000" }],
    ["marginKind", { marginKind: "other" }],
    ["commissionKind", { commissionKind: "x" }],
    ["commission", { commission: "-1" }],
    ["from", { from: "tomorrow" }],
    ["reason", { reason: "   " }],
    ["reason", { reason: "x".repeat(501) }],
    ["reason", { reason: undefined }],
  ])("refuses a bad %s and runs nothing", async (field, patch) => {
    const { flow, deps, priceBook } = setup();
    const answer = await flow.saveBook({ ...BOOK, ...patch } as never);
    expect(answer).toMatchObject({ ok: false, code: "invalid" });
    if (!answer.ok) expect(answer.fields).toContain(field);
    expect(deps.run).not.toHaveBeenCalled();
    expect(priceBook.save).not.toHaveBeenCalled();
  });

  it("a request cannot name an actor, a role or an approver: only its own fields are read", async () => {
    const { flow, priceBook } = setup();
    await flow.saveBook({ ...BOOK, actor: "evil", role: "superadmin", adminId: "x" } as never);
    const call = priceBook.save.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(Object.keys(call[0]).sort()).toEqual([
      "at",
      "commission",
      "effectiveFrom",
      "family",
      "margin",
      "market",
    ]);
  });
});

describe("setBaseCost", () => {
  it("authorize, validate, rate limit, preview the new base cost, then write", async () => {
    const { flow, order, previewBook, priceBook } = setup();
    expect(await flow.setBaseCost(BASE)).toEqual({
      ok: true,
      replayed: false,
      value: { family: "disk", awsPriceUsd: "0.125" },
    });
    expect(order).toEqual(["authorize", "limit", "run", "preview", "setBase"]);
    expect(previewBook).toHaveBeenCalledWith(
      TX,
      { market: "BD", productFamily: "disk", base: { productId: PRODUCT, awsPriceUsd: "0.125" } },
      expect.anything(),
    );
    expect(priceBook.setBaseCost).toHaveBeenCalledWith(
      { catalogProductId: PRODUCT, awsPriceUsd: "0.125" },
      "AWS price page",
    );
  });

  it.each([
    ["market", { market: "x" }],
    ["family", { family: "nope" }],
    ["product", { catalogProductId: "not-a-uuid" }],
    ["awsPriceUsd", { awsPriceUsd: "0" }],
    ["awsPriceUsd", { awsPriceUsd: "-1" }],
    ["awsPriceUsd", { awsPriceUsd: "1.23456" }],
    ["awsPriceUsd", { awsPriceUsd: "1e2" }],
    ["awsPriceUsd", { awsPriceUsd: 5 }],
    ["reason", { reason: "" }],
  ])("refuses a bad %s and runs nothing", async (field, patch) => {
    const { flow, deps, priceBook } = setup();
    const answer = await flow.setBaseCost({ ...BASE, ...patch } as never);
    expect(answer).toMatchObject({ ok: false, code: "invalid" });
    if (!answer.ok) expect(answer.fields).toContain(field);
    expect(deps.run).not.toHaveBeenCalled();
    expect(priceBook.setBaseCost).not.toHaveBeenCalled();
  });

  it("a product that is not of the family is refused by the preview before the write (R16)", async () => {
    const { flow, previewBook, priceBook } = setup();
    previewBook.mockResolvedValueOnce({
      ok: false,
      error: "validation",
      fields: { product: "unknown" },
    } as never);
    expect(await flow.setBaseCost(BASE)).toEqual({
      ok: false,
      code: "invalid",
      fields: ["product"],
    });
    expect(priceBook.setBaseCost).not.toHaveBeenCalled();
  });

  it("a synced family answers invalid from the repository", async () => {
    const { flow, priceBook } = setup();
    priceBook.setBaseCost.mockResolvedValueOnce({ ok: false, error: "validation" } as never);
    expect(await flow.setBaseCost(BASE)).toEqual({ ok: false, code: "invalid", fields: [] });
  });
});
