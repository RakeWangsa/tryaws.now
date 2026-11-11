import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  boundTo: [] as string[],
  profile: { market: "BD" } as null | { market: string },
  market: null as unknown,
  payments: [] as { id: string; status: string }[],
  row: null as unknown,
}));

vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => {
    state.boundTo.push(customerId);
    return {
      profile: { get: async () => state.profile },
      payments: { list: async () => state.payments, get: async () => state.row },
      wallet: { view: async () => ({ balanceMinor: 150000n, currency: "BDT" }) },
    };
  },
  readMarket: async () => state.market,
}));

const { loadTopUp, loadPayment, loadRange } = await import("./topup-view.ts");

const A = "11111111-1111-4111-8111-111111111111";
const ID = "0190aaaa-0000-7000-8000-000000000001";
const market = (over: Record<string, unknown> = {}) => ({
  code: "BD",
  active: true,
  topupMinMinor: 10000n,
  topupMaxMinor: 5000000n,
  quickAmounts: [500, 1000, 0, -5, 1.5, 999999999],
  ...over,
});

describe("loadTopUp", () => {
  it("is bound to the session's customer, keeps only valid quick amounts and the open payments", async () => {
    state.boundTo = [];
    state.market = market();
    state.payments = [
      { id: "p1", status: "redirected" },
      { id: "p2", status: "credited" },
      { id: "p3", status: "review" },
    ];
    const screen = await loadTopUp({ customerId: A } as never);
    expect(state.boundTo).toEqual([A]);
    expect(screen.market?.code).toBe("BD");
    expect(screen.range).toEqual({ minMinor: 10000n, maxMinor: 5000000n });
    expect(screen.quick).toEqual([50000n, 100000n]);
    expect(screen.open.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("an inactive market, a missing market and a missing profile all mean 'not open'", async () => {
    state.market = market({ active: false });
    expect((await loadTopUp({ customerId: A } as never)).market).toBeNull();
    state.market = null;
    expect((await loadTopUp({ customerId: A } as never)).market).toBeNull();
    state.market = market();
    state.profile = null;
    const none = await loadTopUp({ customerId: A } as never);
    expect(none.market).toBeNull();
    expect(none.quick).toEqual([]);
    expect(await loadRange({ customerId: A } as never)).toBeNull();
    state.profile = { market: "BD" };
  });
});

describe("loadPayment", () => {
  it("returns the row with the live balance, and null for a row that is not this customer's", async () => {
    state.row = { id: ID, status: "credited" };
    const found = await loadPayment({ customerId: A } as never, ID);
    expect(found?.balanceMinor).toBe(150000n);
    state.row = null;
    expect(await loadPayment({ customerId: A } as never, ID)).toBeNull();
  });

  it("a malformed id never reaches the database", async () => {
    state.boundTo = [];
    expect(await loadPayment({ customerId: A } as never, "../etc/passwd")).toBeNull();
    expect(state.boundTo).toEqual([]);
  });
});
