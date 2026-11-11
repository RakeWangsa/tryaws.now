import { beforeEach, describe, expect, it, vi } from "vitest";

// recheckPaymentAction with its real wiring and everything outside the app replaced. A fake payment
// service that knows which customer owns which payment stands in for @tc/eps; the tests that run
// verifyPayment against PostgreSQL (credit once, twice and in parallel) are in packages/eps and have
// not been run in this session.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MINE = "0190aaaa-0000-7000-8000-000000000001";
const THEIRS = "0190aaaa-0000-7000-8000-000000000002";
const ORIGIN = "http://localhost:3000";

const state = vi.hoisted(() => ({
  customer: "11111111-1111-4111-8111-111111111111",
  headers: new Headers(),
  epsNull: false,
  epsDown: false,
  rows: new Map<string, { owner: string; status: string }>(),
  verifyCalls: [] as string[],
  nextCallAt: 0,
  now: 0,
  logs: [] as string[],
  locale: "bn",
}));

vi.mock("@tc/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tc/auth")>();
  return {
    ...actual,
    requireCustomer: async () => ({
      customerId: state.customer,
      kycStatus: "verified",
      riskTier: "new",
      locale: "bn",
      signedInAt: new Date(0),
    }),
  };
});
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next-intl/server", () => ({ getLocale: async () => state.locale }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("../../../../../../server/log.ts", () => ({
  writeLog: (entry: Record<string, unknown>) => state.logs.push(JSON.stringify(entry)),
}));
vi.mock("../../../../../../server/topup-view.ts", () => ({
  loadPayment: async (session: { customerId: string }, id: string) => {
    const row = state.rows.get(id);
    if (row === undefined || row.owner !== session.customerId) return null;
    return { payment: { id, status: row.status }, balanceMinor: 0n };
  },
  loadRange: async () => null,
}));
vi.mock("../../../../../../server/runtime.ts", () => ({
  getRuntime: async () => ({
    config: { stage: "local", appOrigin: ORIGIN, epsMode: "sandbox", fakes: true },
    eps: state.epsNull
      ? null
      : {
          recheckPayment: async (session: { customerId: string }, paymentId: string) => {
            const row = state.rows.get(paymentId);
            if (row === undefined || row.owner !== session.customerId) {
              return { ok: false, error: "not_found" };
            }
            if (state.epsDown) return { ok: false, error: "upstream_unavailable" };
            // The 5-second pause per payment of verifyPayment.
            if (state.now < state.nextCallAt) {
              return {
                ok: false,
                error: "rate_limited",
                data: { retryAfterSeconds: state.nextCallAt - state.now },
              };
            }
            state.nextCallAt = state.now + 5;
            state.verifyCalls.push(paymentId);
            if (row.status === "redirected") row.status = "credited";
            const open = row.status === "initiated" || row.status === "redirected";
            return { ok: true, value: { state: open ? "pending" : row.status, review: false } };
          },
        },
  }),
}));

const { recheckPaymentAction, checkAgainAction } = await import("./actions.ts");

const same = () => new Headers({ origin: ORIGIN, "sec-fetch-site": "same-origin" });

beforeEach(() => {
  state.customer = A;
  state.headers = same();
  state.epsNull = false;
  state.epsDown = false;
  state.rows = new Map([
    [MINE, { owner: A, status: "redirected" }],
    [THEIRS, { owner: B, status: "redirected" }],
  ]);
  state.verifyCalls = [];
  state.nextCallAt = 0;
  state.now = 100;
  state.locale = "bn";
  state.logs = [];
});

describe("recheckPaymentAction", () => {
  it("another customer's id is 'unknown' and EPS is never asked", async () => {
    expect(await recheckPaymentAction(THEIRS)).toEqual({ state: "unknown", review: false });
    expect(state.verifyCalls).toEqual([]);
  });

  it("an open payment that EPS now confirms is 'credited'", async () => {
    expect(await recheckPaymentAction(MINE)).toEqual({ state: "credited", review: false });
    expect(state.verifyCalls).toEqual([MINE]);
  });

  it("EPS down is the row's state, 'pending'", async () => {
    state.epsDown = true;
    expect(await recheckPaymentAction(MINE)).toEqual({ state: "pending", review: false });
  });

  it("a second call within 5 seconds returns the row state with a wait; the row is read again, so a parallel credit shows", async () => {
    // First call: the row stays open because we make EPS answer 'pending' by marking it credited later.
    state.rows.set(MINE, { owner: A, status: "initiated" });
    expect(await recheckPaymentAction(MINE)).toEqual({ state: "pending", review: false });
    state.rows.set(MINE, { owner: A, status: "credited" }); // settled by the parallel check
    state.now = 102;
    expect(await recheckPaymentAction(MINE)).toEqual({
      state: "credited",
      review: false,
      retryAfterSeconds: 3,
    });
    expect(state.verifyCalls).toEqual([MINE]);
  });

  it("a cross-site call is refused with no EPS call", async () => {
    state.headers = new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(await recheckPaymentAction(MINE)).toEqual({ state: "unknown", review: false });
    expect(state.verifyCalls).toEqual([]);
  });

  it("a malformed id and an unconfigured gateway never reach EPS", async () => {
    expect(await recheckPaymentAction("not-a-uuid")).toEqual({ state: "unknown", review: false });
    state.epsNull = true;
    expect(await recheckPaymentAction(MINE)).toEqual({ state: "pending", review: false });
    expect(state.verifyCalls).toEqual([]);
  });
});

describe("checkAgainAction (the button without JavaScript)", () => {
  it("checks once and goes back to the status page in the language of the request", async () => {
    await expect(checkAgainAction(MINE)).rejects.toThrow(`REDIRECT:/wallet/topup/${MINE}`);
    expect(state.verifyCalls).toEqual([MINE]);
    state.locale = "en";
    await expect(checkAgainAction(MINE)).rejects.toThrow(`REDIRECT:/en/wallet/topup/${MINE}`);
  });

  it("a malformed id goes to the top-up page and checks nothing", async () => {
    await expect(checkAgainAction("../x")).rejects.toThrow("REDIRECT:/wallet/topup");
    expect(state.verifyCalls).toEqual([]);
  });
});
