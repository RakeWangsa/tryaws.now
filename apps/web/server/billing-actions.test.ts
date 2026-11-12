import type { CustomerSession } from "@tc/auth";
import type { AuditRepo, BillingProfile, ProfileRepo, RateLimitsRepo } from "@tc/db";
import { describe, expect, it } from "vitest";
import { updateBillingCore } from "./billing-actions.ts";
import type { SettingsDeps, SettingsRepos } from "./settings-actions.ts";

// WPU-I3: the billing details of /settings/profile. R9 order, R8 (the customer comes from the session),
// R14 (no address, BIN, NID or name in the audit entry), R16 (an unavailable store refuses).

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const EMPTY: BillingProfile = {
  billingName: null,
  billingAddress: null,
  customerBin: null,
  customerNid: null,
};
const FORM = {
  billingName: "Rahim & Sons Ltd.",
  billingAddress: "House 5, Road 3, Dhanmondi, Dhaka",
  customerBin: "123456789-0123",
  customerNid: "",
};
const STORED: BillingProfile = {
  billingName: "Rahim & Sons Ltd.",
  billingAddress: "House 5, Road 3, Dhanmondi, Dhaka",
  customerBin: "1234567890123",
  customerNid: null,
};

function world(over: { limited?: boolean; refuseWrite?: boolean; auditRefused?: boolean } = {}) {
  const calls: string[] = [];
  const logged: unknown[] = [];
  const state = { billing: { ...EMPTY } };
  const repos: SettingsRepos = {
    profile: {
      setBilling: async (input: BillingProfile) => {
        calls.push("profile.setBilling");
        logged.push(input);
        if (over.refuseWrite === true) return { ok: false, error: "validation" };
        state.billing = { ...input };
        return { ok: true, replayed: false, value: input };
      },
    } as unknown as ProfileRepo,
    audit: {
      record: async (input) => {
        calls.push(`audit:${input.action}`);
        logged.push(input);
        return over.auditRefused === true
          ? { ok: false, error: "validation" }
          : { ok: true, replayed: false, value: { id: "a" } };
      },
    } satisfies AuditRepo,
    rateLimits: {
      consume: async (limits) => {
        calls.push("rateLimit");
        logged.push(limits);
        return over.limited === true
          ? { allowed: false, action: "x", retryAfterSeconds: 9 }
          : { allowed: true };
      },
    } satisfies RateLimitsRepo,
  };
  let current: CustomerSession | null = {
    customerId: CUSTOMER,
    kycStatus: "none",
    riskTier: "new",
    locale: "bn",
    signedInAt: NOW,
  };
  const deps: SettingsDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return current;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push("store");
      // R8: the repositories are opened for the customer of the session, never for one of the body.
      expect(customerId).toBe(CUSTOMER);
      return fn(repos);
    },
    ports: null,
    clientIp: () => null,
  };
  return {
    deps,
    calls,
    logged,
    state,
    setSession: (s: CustomerSession | null) => {
      current = s;
    },
  };
}

describe("updateBillingCore", () => {
  it("authenticates, validates, rate limits, writes and audits, in that order", async () => {
    const w = world();
    expect(await updateBillingCore(w.deps, FORM)).toEqual({ ok: true });
    expect(w.calls).toEqual([
      "authenticate",
      "store",
      "rateLimit",
      "profile.setBilling",
      "audit:profile.billing_updated",
    ]);
    expect(w.state.billing).toEqual(STORED);
  });

  it("refuses without a session and touches nothing else", async () => {
    const w = world();
    w.setSession(null);
    expect(await updateBillingCore(w.deps, FORM)).toEqual({ ok: false, error: "unauthenticated" });
    expect(w.calls).toEqual(["authenticate"]);
  });

  it("refuses a bad form with the field codes, before the database", async () => {
    const w = world();
    expect(
      await updateBillingCore(w.deps, {
        billingName: "x",
        billingAddress: "Dhk",
        customerBin: "12345",
        customerNid: "",
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fields: { billingName: "too_short", billingAddress: "too_short", customerBin: "invalid" },
    });
    expect(
      await updateBillingCore(w.deps, { customerBin: "1234567890123", customerNid: "1234567890" }),
    ).toEqual({
      ok: false,
      error: "validation",
      fields: { customerBin: "conflict", customerNid: "conflict" },
    });
    expect(await updateBillingCore(w.deps, { customerNid: "12345678" })).toMatchObject({
      fields: { customerNid: "invalid" },
    });
    expect(w.calls).toEqual(["authenticate", "authenticate", "authenticate"]);
    expect(w.state.billing).toEqual(EMPTY);
  });

  it("answers rate_limited and writes nothing", async () => {
    const w = world({ limited: true });
    expect(await updateBillingCore(w.deps, FORM)).toEqual({ ok: false, error: "rate_limited" });
    expect(w.calls).toEqual(["authenticate", "store", "rateLimit"]);
    expect(w.state.billing).toEqual(EMPTY);
  });

  it("a customer id, an e-mail or a role in the body reaches nothing (R8, R11)", async () => {
    const w = world();
    await updateBillingCore(w.deps, {
      ...FORM,
      customerId: "22222222-2222-4222-8222-222222222222",
      email: "x@example.test",
      kycStatus: "verified",
    });
    expect(w.logged[1]).toEqual(STORED);
  });

  it("is idempotent: the same form twice leaves the same state; an empty form clears it", async () => {
    const w = world();
    await updateBillingCore(w.deps, FORM);
    await updateBillingCore(w.deps, FORM);
    expect(w.state.billing).toEqual(STORED);
    expect(await updateBillingCore(w.deps, {})).toEqual({ ok: true });
    expect(w.state.billing).toEqual(EMPTY);
  });

  it("keeps the name, the address and the tax ids out of the audit entry (R14)", async () => {
    const w = world();
    await updateBillingCore(w.deps, FORM);
    const entry = JSON.stringify(
      w.logged.filter((x) => (x as { action?: string }).action !== undefined),
    );
    expect(entry).toContain("profile.billing_updated");
    for (const secret of ["Rahim", "Dhanmondi", "1234567890123", "123456789-0123"]) {
      expect(entry).not.toContain(secret);
    }
  });

  it("fails closed when the store refuses the write or the audit entry is refused (R16)", async () => {
    expect(await updateBillingCore(world({ refuseWrite: true }).deps, FORM)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await updateBillingCore(world({ auditRefused: true }).deps, FORM)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("an error of the store becomes unavailable and carries no value", async () => {
    const w = world();
    const failing: SettingsDeps = {
      ...w.deps,
      store: async () => {
        throw new Error("connection to 1234567890123 failed");
      },
    };
    const result = await updateBillingCore(failing, FORM);
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("1234567890123");
  });
});
