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

function world(
  over: {
    limited?: boolean;
    refuseWrite?: boolean;
    auditRefused?: boolean;
    stored?: BillingProfile;
    signedInAt?: Date;
  } = {},
) {
  const calls: string[] = [];
  const logged: unknown[] = [];
  const state = { billing: { ...(over.stored ?? EMPTY) } };
  const repos: SettingsRepos = {
    profile: {
      getBilling: async () => {
        calls.push("profile.getBilling");
        return { ...state.billing };
      },
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
    signedInAt: over.signedInAt ?? NOW,
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
      "profile.getBilling",
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
    expect(w.calls).toEqual(["authenticate", "store", "profile.getBilling", "rateLimit"]);
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

// WPU-S8 (L2): a change to the BIN or the NID (set, change or clear) needs a fresh sign-in (6.1, U10);
// the address and the name do not. The stored NID is never sent back to the browser, so an empty NID
// field means "keep it" and a clear is an explicit request.
const STALE = new Date(NOW.getTime() - 11 * 60_000);
const WITH_NID: BillingProfile = {
  billingName: "Rahim",
  billingAddress: "House 5, Road 3, Dhaka",
  customerBin: null,
  customerNid: "1990123456789",
};
const WITH_BIN: BillingProfile = { ...WITH_NID, customerBin: "1234567890123", customerNid: null };

describe("updateBillingCore: tax identifiers need a fresh sign-in (WPU-S8)", () => {
  it("refuses to set a BIN or a NID on a stale session, and writes nothing", async () => {
    for (const form of [
      { ...FORM, customerBin: "1234567890123" },
      { ...FORM, customerBin: "", customerNid: "1990123456789" },
    ]) {
      const w = world({ signedInAt: STALE, stored: EMPTY });
      expect(await updateBillingCore(w.deps, form)).toEqual({
        ok: false,
        error: "fresh_sign_in_required",
      });
      expect(w.calls).not.toContain("profile.setBilling");
      expect(w.calls).not.toContain("audit:profile.billing_updated");
      expect(w.state.billing).toEqual(EMPTY);
    }
  });
  it("refuses to change a BIN or to clear it on a stale session", async () => {
    const changed = world({ signedInAt: STALE, stored: WITH_BIN });
    expect(
      await updateBillingCore(changed.deps, { ...WITH_BIN, customerBin: "9999999999999" }),
    ).toEqual({ ok: false, error: "fresh_sign_in_required" });
    expect(changed.state.billing).toEqual(WITH_BIN);
    const cleared = world({ signedInAt: STALE, stored: WITH_BIN });
    expect(await updateBillingCore(cleared.deps, { ...WITH_BIN, customerBin: "" })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(cleared.state.billing).toEqual(WITH_BIN);
  });
  it("refuses to change or to clear the NID on a stale session", async () => {
    const changed = world({ signedInAt: STALE, stored: WITH_NID });
    expect(await updateBillingCore(changed.deps, { customerNid: "1234567890" })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    const cleared = world({ signedInAt: STALE, stored: WITH_NID });
    expect(await updateBillingCore(cleared.deps, { clearCustomerNid: "on" })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(changed.state.billing).toEqual(WITH_NID);
    expect(cleared.state.billing).toEqual(WITH_NID);
  });
  it("allows the same changes on a fresh session", async () => {
    const set = world({ stored: EMPTY });
    expect(await updateBillingCore(set.deps, { ...FORM })).toEqual({ ok: true });
    expect(set.state.billing.customerBin).toBe("1234567890123");
    const cleared = world({ stored: WITH_NID });
    expect(await updateBillingCore(cleared.deps, { clearCustomerNid: "on" })).toEqual({ ok: true });
    expect(cleared.state.billing.customerNid).toBeNull();
  });
  it("needs no fresh sign-in for the name or the address, and keeps the stored ids", async () => {
    const w = world({ signedInAt: STALE, stored: WITH_NID });
    expect(
      await updateBillingCore(w.deps, {
        billingName: "Rahim Uddin",
        billingAddress: "House 12//B, Road 5",
        customerBin: "",
        customerNid: "",
      }),
    ).toEqual({ ok: true });
    expect(w.state.billing).toEqual({
      billingName: "Rahim Uddin",
      billingAddress: "House 12//B, Road 5",
      customerBin: null,
      customerNid: "1990123456789",
    });
    const same = world({ signedInAt: STALE, stored: WITH_BIN });
    // the BIN is shown in full, so the form sends it back unchanged: not a change
    expect(await updateBillingCore(same.deps, { ...WITH_BIN })).toEqual({ ok: true });
  });
  it("an empty NID field keeps the stored NID; a BIN entered next to it is a conflict", async () => {
    const w = world({ stored: WITH_NID });
    expect(await updateBillingCore(w.deps, { ...WITH_NID, customerNid: "" })).toEqual({ ok: true });
    expect(w.state.billing.customerNid).toBe("1990123456789");
    expect(
      await updateBillingCore(w.deps, {
        ...WITH_NID,
        customerNid: "",
        customerBin: "1234567890123",
      }),
    ).toMatchObject({ ok: false, error: "validation" });
    expect(w.state.billing.customerBin).toBeNull();
  });
  it("a stale session is refused before the rate limit is spent and before any write (R9, R16)", async () => {
    const w = world({ signedInAt: STALE, stored: EMPTY });
    await updateBillingCore(w.deps, { customerBin: "1234567890123" });
    expect(w.calls).toEqual(["authenticate", "store", "profile.getBilling"]);
  });
  it("keeps the ids out of the result and the audit entry of a refused or accepted change", async () => {
    const w = world({ signedInAt: STALE, stored: WITH_NID });
    const refused = await updateBillingCore(w.deps, { customerNid: "1234567890" });
    expect(JSON.stringify(refused)).not.toMatch(/1234567890|1990123456789/);
    const ok = world({ stored: WITH_NID });
    await updateBillingCore(ok.deps, { clearCustomerNid: "on" });
    const entry = JSON.stringify(
      ok.logged.filter((x) => (x as { action?: string }).action !== undefined),
    );
    expect(entry).not.toContain("1990123456789");
  });
});
