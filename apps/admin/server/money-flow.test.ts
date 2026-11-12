import type { AdminActor, AdminRepos, LedgerPoster, LedgerReverser } from "@tc/db";
import { describe, expect, it } from "vitest";
import { makeMoneyAction, parseTaka, type MoneyActionRequest } from "./money-flow.ts";

const ID = "0191a000-0000-7000-8000-000000000001";
const CUSTOMER = "0191a000-0000-7000-8000-0000000000c1";
const ACTOR: AdminActor = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "finance",
  ip: "203.0.113.5",
};
const NOW = new Date("2026-11-12T08:00:00.000Z");
const POSTER: LedgerPoster = async () => ({ ok: true, value: { transactionId: ID } });
const REVERSER: LedgerReverser = async () => ({ ok: true, value: { transactionId: ID } });

// A recorder of the order of the steps and of the calls that reached the repository.
function rig(
  over: {
    allow?: boolean;
    limit?: boolean;
    repo?: unknown;
    boom?: boolean;
    noReverse?: boolean;
  } = {},
) {
  const steps: string[] = [];
  const calls: [string, unknown, string, unknown?][] = [];
  const asked: (readonly string[])[] = [];
  const answer = over.repo ?? {
    ok: true,
    replayed: false,
    value: { id: ID, customerId: CUSTOMER, status: "pending", paymentId: ID },
  };
  const record = (name: string) => async (input: unknown, reason: string, post?: unknown) => {
    steps.push("execute");
    calls.push([name, input, reason, post]);
    return answer;
  };
  const repos = {
    wallets: {
      createAdjustment: record("createAdjustment"),
      approveAdjustment: record("approveAdjustment"),
      rejectAdjustment: record("rejectAdjustment"),
      creditWalletForFailedChange: record("creditWalletForFailedChange"),
    },
    payments: {
      reverify: record("reverify"),
      recordManualRefund: record("recordManualRefund"),
      resolveDiscrepancy: record("resolveDiscrepancy"),
    },
  } as unknown as AdminRepos;
  const act = makeMoneyAction({
    authorize: async (roles) => {
      steps.push("authorize");
      asked.push(roles);
      if (over.allow === false) throw new Error("no");
      return ACTOR;
    },
    limiter: async () => {
      steps.push("limit");
      return over.limit !== false;
    },
    run: async (_actor, fn) => {
      if (over.boom) throw new Error("database down: secret detail");
      return fn(repos);
    },
    post: POSTER,
    ...(over.noReverse === true ? {} : { reverse: REVERSER }),
    clock: { now: () => NOW },
  });
  return { act, steps, calls, asked };
}

const adjust = (over: Partial<MoneyActionRequest> = {}): MoneyActionRequest => ({
  kind: "createAdjustment",
  id: ID,
  customerId: CUSTOMER,
  reason: "bank deposit slip 12",
  direction: "credit",
  amount: "1500.50",
  adjustmentKind: "deposit",
  ...over,
});

describe("parseTaka: taka text to paisa by integer arithmetic (R4)", () => {
  it.each([
    ["1", 100n],
    ["1500.5", 150050n],
    ["1500.50", 150050n],
    ["0.01", 1n],
    ["  25  ", 2500n],
    ["999999999999999.99", 99999999999999999n],
  ])("%s is %s", (text, minor) => expect(parseTaka(text)).toBe(minor));

  it.each([
    "",
    "0",
    "0.00",
    "-5",
    "1e3",
    "1,000",
    "1.234",
    ".5",
    "5.",
    "abc",
    "1 2",
    "1000000000000000",
  ])("%j is refused", (text) => expect(parseTaka(text)).toBeNull());
  it("a number or a missing value is refused", () => {
    expect(parseTaka(1.5 as never)).toBeNull();
    expect(parseTaka(undefined as never)).toBeNull();
  });
});

describe("money actions in the order of R9", () => {
  it("authorizes, validates, limits, executes", async () => {
    const r = rig();
    expect(await r.act(adjust())).toEqual({
      ok: true,
      replayed: false,
      status: "pending",
      customerId: CUSTOMER,
      targetId: ID,
    });
    expect(r.steps).toEqual(["authorize", "limit", "execute"]);
    expect(r.calls).toEqual([
      [
        "createAdjustment",
        {
          requestId: ID,
          at: NOW,
          customerId: CUSTOMER,
          direction: "credit",
          amountMinor: 150050n,
          kind: "deposit",
        },
        "bank deposit slip 12",
        POSTER,
      ],
    ]);
  });

  it("asks for the role of each kind", async () => {
    const r = rig();
    await r.act(adjust());
    await r.act(adjust({ kind: "approveAdjustment" }));
    await r.act(adjust({ kind: "rejectAdjustment" }));
    await r.act(adjust({ kind: "reverifyPayment" }));
    await r.act(adjust({ kind: "recordManualRefund" }));
    await r.act(adjust({ kind: "resolveDiscrepancy" }));
    expect(r.asked).toEqual([
      ["finance"],
      ["finance", "superadmin"],
      ["finance", "superadmin"],
      ["finance"],
      ["finance"],
      ["ops", "finance", "superadmin"],
    ]);
  });

  it("passes the poster only to the kinds that post, and the optional evidence", async () => {
    const r = rig();
    await r.act(adjust({ evidence: " slip 12 " }));
    await r.act(adjust({ kind: "approveAdjustment" }));
    await r.act(adjust({ kind: "rejectAdjustment" }));
    await r.act(adjust({ kind: "reverifyPayment" }));
    await r.act(adjust({ kind: "recordManualRefund" }));
    await r.act(adjust({ kind: "resolveDiscrepancy" }));
    expect(r.calls.map(([name, , , post]) => [name, post === POSTER])).toEqual([
      ["createAdjustment", true],
      ["approveAdjustment", true],
      ["rejectAdjustment", false],
      ["reverify", false],
      ["recordManualRefund", true],
      ["resolveDiscrepancy", false],
    ]);
    expect(r.calls[0]?.[1]).toMatchObject({ evidenceRef: "slip 12" });
    expect(r.calls[1]?.[1]).toEqual({ id: ID });
    expect(r.calls[4]?.[1]).toEqual({ paymentId: ID, amountMinor: 150050n });
  });

  it("an admin without the role is refused before anything else (fail closed)", async () => {
    const r = rig({ allow: false });
    expect(await r.act(adjust())).toEqual({ ok: false, code: "denied" });
    expect(r.steps).toEqual(["authorize"]);
  });

  it.each([
    ["an unknown kind", { kind: "delete" as never }],
    ["an id that is not a UUID", { id: "1 or 1=1" }],
    ["a customer id that is not a UUID", { customerId: "x" }],
    ["a blank reason", { reason: "   " }],
    ["a long reason", { reason: "x".repeat(501) }],
    ["a reason that is a number", { reason: 5 }],
    ["a float amount", { amount: 1.5 }],
    ["an amount with three decimals", { amount: "1.001" }],
    ["a zero amount", { amount: "0" }],
    ["a direction that is not ours", { direction: "sideways" }],
    ["a kind of adjustment that is not ours", { adjustmentKind: "gift" }],
    ["long evidence", { evidence: "x".repeat(201) }],
  ])("%s is invalid and reaches neither the limiter nor the repository", async (_, over) => {
    const r = rig();
    expect(await r.act(adjust(over as Partial<MoneyActionRequest>))).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(r.steps).toEqual(["authorize"]);
  });

  it("the amount is not needed by the kinds that move no amount", async () => {
    const r = rig();
    expect((await r.act({ kind: "approveAdjustment", id: ID, reason: "slip checked" })).ok).toBe(
      true,
    );
    expect((await r.act({ kind: "recordManualRefund", id: ID, reason: "x" })).ok).toBe(false);
  });

  it("over the rate limit nothing is executed", async () => {
    const r = rig({ limit: false });
    expect(await r.act(adjust())).toEqual({ ok: false, code: "rate_limited" });
    expect(r.steps).toEqual(["authorize", "limit"]);
  });

  it.each([
    ["forbidden", "denied"],
    ["validation", "invalid"],
    ["not_found", "not_found"],
    ["conflict", "conflict"],
  ])("a repository refusal %s becomes %s", async (error, code) => {
    const r = rig({ repo: { ok: false, error } });
    expect(await r.act(adjust())).toEqual({ ok: false, code });
  });

  it("a replay is reported as a replay", async () => {
    const r = rig({
      repo: {
        ok: true,
        replayed: true,
        value: { id: ID, customerId: CUSTOMER, status: "approved" },
      },
    });
    expect(await r.act(adjust())).toMatchObject({ ok: true, replayed: true, status: "approved" });
  });

  it("a failing database says nothing about itself (fail closed, R14)", async () => {
    const r = rig({ boom: true });
    const out = await r.act(adjust());
    expect(out).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("a hostile request object cannot answer differently on the second read", async () => {
    const r = rig();
    let reads = 0;
    const hostile = {
      ...adjust(),
      get reason() {
        reads += 1;
        return reads === 1 ? "first read" : "";
      },
    } as MoneyActionRequest;
    expect((await r.act(hostile)).ok).toBe(true);
    expect(r.calls[0]?.[2]).toBe("first read");
  });

  // WPU-M3
  it("creditWalletForFailedChange: finance or superadmin, the id is the operation, the reverser is passed", async () => {
    const r = rig();
    const out = await r.act({
      kind: "creditWalletForFailedChange",
      id: ID,
      reason: "ops rejected the apply",
    });
    expect(out).toMatchObject({ ok: true, customerId: CUSTOMER });
    expect(r.asked).toEqual([["finance", "superadmin"]]);
    expect(r.steps).toEqual(["authorize", "limit", "execute"]);
    expect(r.calls).toEqual([
      ["creditWalletForFailedChange", { operationId: ID }, "ops rejected the apply", REVERSER],
    ]);
  });

  it("creditWalletForFailedChange needs a reason and an operation id, and fails closed without a reverser", async () => {
    const r = rig();
    expect(await r.act({ kind: "creditWalletForFailedChange", id: ID, reason: " " })).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(await r.act({ kind: "creditWalletForFailedChange", id: "x", reason: "r" })).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(r.calls).toEqual([]);
    const none = rig({ noReverse: true });
    expect(await none.act({ kind: "creditWalletForFailedChange", id: ID, reason: "r" })).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(none.calls).toEqual([]);
  });
});
