import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IdpResult, TotpPort } from "@tc/auth";
import type { Orders, OrderSession } from "@tc/core";
import { describe, expect, it } from "vitest";
import { mfaGuardedOrders } from "./mfa-gate.ts";

// WPU-X11 round 2 (security review, finding 2c): a session that was open before the authenticator was
// switched off OUTSIDE the panel must not buy. Every draft and every purchase of every product family goes
// through one Orders port; this wrapper asks Cognito (GetUser with the session's own access token) first and
// refuses unless the authenticator is on there, or when it cannot ask (R16). R1: an identity call only.

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const session: OrderSession = {
  customerId: CUSTOMER,
  kycStatus: "none",
  riskTier: "new",
  locale: "en",
};
const TOKEN = "access.token.of.this.request";

function world(
  mfa: IdpResult<{ totp: boolean }> | "throw",
  over: { token?: string | null; noPort?: boolean; driftThrows?: boolean } = {},
) {
  const inner: string[] = [];
  const asked: string[] = [];
  const drift: string[] = [];
  const orders: Orders = {
    createOrderDraft: async (_s, input) => {
      inner.push("createOrderDraft");
      return {
        ok: true,
        value: { token: String(input), quote: {} as never, expiresAt: new Date(0) },
      };
    },
    placeOrder: async (_s, input) => {
      inner.push("placeOrder");
      return { ok: true, value: { orderId: input.idempotencyKey } };
    },
  };
  const totp = {
    mfaState: async (token: string) => {
      asked.push(token);
      if (mfa === "throw") throw new Error("boom: the token is " + token);
      return mfa;
    },
  } as unknown as TotpPort;
  const guarded = mfaGuardedOrders(orders, {
    totp: over.noPort === true ? null : totp,
    accessToken: () => (over.token === undefined ? TOKEN : over.token),
    onDrift: async (customerId) => {
      drift.push(customerId);
      if (over.driftThrows === true) throw new Error("db down");
    },
  });
  return { guarded, inner, asked, drift };
}

describe("mfaGuardedOrders", () => {
  it("passes a draft and a purchase on when Cognito lists the authenticator, asking with this request's token", async () => {
    const w = world({ ok: true, value: { totp: true } });
    expect(await w.guarded.createOrderDraft(session, "draft-input")).toMatchObject({ ok: true });
    expect(
      await w.guarded.placeOrder(session, { token: "t", idempotencyKey: "k".repeat(16) }),
    ).toEqual({ ok: true, value: { orderId: "k".repeat(16) } });
    expect(w.inner).toEqual(["createOrderDraft", "placeOrder"]);
    expect(w.asked).toEqual([TOKEN, TOKEN]);
    expect(w.drift).toEqual([]);
  });

  it("refuses both when Cognito says the authenticator is off, names the step, and reconciles the platform copy", async () => {
    const w = world({ ok: true, value: { totp: false } });
    const refusal = { ok: false, error: "kyc_required", data: { missing: ["totp"] } };
    expect(await w.guarded.createOrderDraft(session, "x")).toEqual(refusal);
    expect(await w.guarded.placeOrder(session, { token: "t", idempotencyKey: "k" })).toEqual(
      refusal,
    );
    // The inner order code is never reached: nothing is drafted, nothing is charged.
    expect(w.inner).toEqual([]);
    expect(w.drift).toEqual([CUSTOMER, CUSTOMER]);
  });

  it("refuses when the check cannot be completed, whatever the reason, and leaves the platform copy alone (R16)", async () => {
    for (const mfa of [
      { ok: false, kind: "unavailable" },
      { ok: false, kind: "denied" },
      { ok: false, kind: "rate_limited" },
      "throw",
    ] as const) {
      const w = world(mfa as never);
      expect(await w.guarded.createOrderDraft(session, "x")).toEqual({
        ok: false,
        error: "upstream_unavailable",
      });
      expect(await w.guarded.placeOrder(session, { token: "t", idempotencyKey: "k" })).toEqual({
        ok: false,
        error: "upstream_unavailable",
      });
      expect(w.inner).toEqual([]);
      expect(w.drift).toEqual([]);
    }
  });

  it("refuses without the port or without a token, and does not call Cognito then", async () => {
    for (const over of [{ noPort: true }, { token: null }, { token: "" }]) {
      const w = world({ ok: true, value: { totp: true } }, over);
      expect(await w.guarded.createOrderDraft(session, "x")).toEqual({
        ok: false,
        error: "upstream_unavailable",
      });
      expect(w.inner).toEqual([]);
      expect(w.asked).toEqual([]);
    }
  });

  it("a failing reconcile does not turn the refusal into anything else, and no text of an error leaks", async () => {
    const w = world({ ok: true, value: { totp: false } }, { driftThrows: true });
    const out = await w.guarded.createOrderDraft(session, "x");
    expect(out).toEqual({ ok: false, error: "kyc_required", data: { missing: ["totp"] } });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const thrown = world("throw");
    expect(JSON.stringify(await thrown.guarded.createOrderDraft(session, "x"))).not.toContain(
      TOKEN,
    );
  });

  it("is wired into orderActionDeps, which every family's draft and purchase action uses", () => {
    const source = readFileSync(join(import.meta.dirname, "action-deps.ts"), "utf8");
    const block = /export async function orderActionDeps[^]*?\n}\n/.exec(source)?.[0] ?? "";
    expect(block).toContain("mfaGuardedOrders(");
    // No action builds the order port another way.
    expect(source.match(/runtime\.orders/g)?.length ?? 0).toBe(1);
  });
});
