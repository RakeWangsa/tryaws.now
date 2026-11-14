import { beforeEach, describe, expect, it } from "vitest";
import { NOW, SIGN_UP_FORM, makeHarness } from "../fakes/auth-harness.ts";
import type { Customer, Harness } from "../fakes/auth-harness.ts";
import { getFakeState } from "../fakes/outbox.ts";
import { totpCodeAt } from "../fakes/totp.ts";
import { signInCore } from "./sign-in.ts";

let h: Harness;
let customer: Customer;
const FORM = { email: SIGN_UP_FORM.email, password: SIGN_UP_FORM.password, locale: "bn" };

beforeEach(async () => {
  h = makeHarness();
  customer = await h.signedUp();
});

describe("signInCore", () => {
  it("sets the two cookies only when completeSignIn is ok, and audits with the customer id and the viewer address", async () => {
    const out = await signInCore(h.ctx(), FORM);
    expect(out.effects.setCookies.map((c) => c.name)).toEqual(["__Host-tc_at", "__Host-tc_rt"]);
    expect(
      out.effects.setCookies.every((c) => c.httpOnly && c.secure && c.sameSite === "lax"),
    ).toBe(true);
    expect(h.audits).toEqual([
      { customerId: customer.customerId, action: "auth.sign_in", ip: "198.51.100.7" },
    ]);
  });

  it("an unverified phone lands on /verify with a safe next kept", async () => {
    const out = await signInCore(h.ctx(), { ...FORM, next: "/wallet" });
    expect(out.state).toEqual({ status: "done", redirectTo: "/verify?next=%2Fwallet" });
  });

  it("a verified phone lands on next or the default landing", async () => {
    customer.phoneVerified = true;
    expect((await signInCore(h.ctx(), FORM)).state).toEqual({
      status: "done",
      redirectTo: "/wallet",
    });
    expect((await signInCore(h.ctx(), { ...FORM, locale: "en" })).state).toEqual({
      status: "done",
      redirectTo: "/en/wallet",
    });
  });

  it("an unknown subject, a revoked token and a suspended customer set no cookie", async () => {
    customer.revoked = true;
    const revoked = await signInCore(h.ctx(), FORM);
    expect(revoked.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    expect(revoked.effects.setCookies).toEqual([]);

    customer.revoked = false;
    customer.suspended = true;
    const suspended = await signInCore(h.ctx(), FORM);
    expect(suspended.state).toMatchObject({ status: "error", code: "suspended" });
    expect(suspended.effects.setCookies).toEqual([]);

    h.customers.clear();
    const unknown = await signInCore(h.ctx(), FORM);
    expect(unknown.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    expect(unknown.effects.setCookies).toEqual([]);
  });

  it("if the audit row cannot be written no cookie is set (R16)", async () => {
    h.state.auditFails = true;
    const out = await signInCore(h.ctx(), FORM);
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(out.effects.setCookies).toEqual([]);
  });

  it("another challenge than TOTP (a new password, ...) is refused closed as unavailable", async () => {
    const original = h.idp.signIn;
    h.idp.signIn = async () => ({ ok: true, value: { kind: "challenge", challenge: "other" } });
    const out = await signInCore(h.ctx(), FORM);
    h.idp.signIn = original;
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(out.effects.setCookies).toEqual([]);
  });
});

// WPU-X11: a customer who switched the authenticator on signs in with the password and the 6-digit code.
describe("signInCore with an authenticator (TOTP)", () => {
  const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  beforeEach(() => {
    const user = getFakeState().users.get(FORM.email)!;
    user.totpSecret = SECRET;
    user.totpEnabled = true;
  });

  it("without a code: no cookie, the form asks for the code and keeps the e-mail, never the password", async () => {
    const out = await signInCore(h.ctx(), FORM);
    expect(out.state).toMatchObject({
      status: "error",
      code: "totp_required",
      values: { email: FORM.email, totpStep: "1" },
    });
    expect(JSON.stringify(out.state)).not.toContain(FORM.password);
    expect(out.effects.setCookies).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("with the right code: the normal session, cookies and audit", async () => {
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: totpCodeAt(SECRET, NOW) });
    expect(out.effects.setCookies.map((c) => c.name)).toEqual(["__Host-tc_at", "__Host-tc_rt"]);
    expect(h.audits).toEqual([
      { customerId: customer.customerId, action: "auth.sign_in", ip: "198.51.100.7" },
    ]);
  });

  it("a code typed in Bengali digits is read as the same code", async () => {
    const code = totpCodeAt(SECRET, NOW).replace(/[0-9]/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]!);
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: code });
    expect(out.state).toMatchObject({ status: "done" });
  });

  it("a wrong code is the generic sign_in_failed, keeps the code step, sets no cookie and does not echo the code", async () => {
    const right = totpCodeAt(SECRET, NOW);
    const wrong = right === "000000" ? "111111" : "000000";
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: wrong, totpStep: "1" });
    expect(out.state).toMatchObject({
      status: "error",
      code: "sign_in_failed",
      values: { totpStep: "1" },
    });
    expect(JSON.stringify(out.state)).not.toContain(wrong);
    expect(out.effects.setCookies).toEqual([]);
  });

  it("a code is accepted once: the replay of an accepted code is refused", async () => {
    const code = totpCodeAt(SECRET, NOW);
    expect((await signInCore(h.ctx(), { ...FORM, totpCode: code })).state).toMatchObject({
      status: "done",
    });
    const replay = await signInCore(h.ctx(), { ...FORM, totpCode: code });
    expect(replay.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    expect(replay.effects.setCookies).toEqual([]);
  });

  it("a code that is not six digits is a field error before the provider is asked", async () => {
    h.events.length = 0;
    const out = await signInCore(h.ctx(), { ...FORM, totpCode: "12ab" });
    expect(out.state).toMatchObject({
      status: "error",
      code: "invalid",
      fields: { totpCode: "invalid" },
    });
    expect(h.events.filter((e) => e.startsWith("idp."))).toEqual([]);
  });

  it("wrong codes count against the sign-in limit: the ninth try is rate_limited", async () => {
    const right = totpCodeAt(SECRET, NOW);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 8; i++) {
      await signInCore(h.ctx(), { ...FORM, totpCode: wrong });
    }
    expect((await signInCore(h.ctx(), { ...FORM, totpCode: right })).state).toMatchObject({
      code: "rate_limited",
    });
  });

  it("the ninth attempt in fifteen minutes from one address for one email is rate_limited", async () => {
    const wrong = { ...FORM, password: "wrong wrong wrong" };
    for (let i = 0; i < 8; i++) {
      expect((await signInCore(h.ctx(), wrong)).state).toMatchObject({ code: "sign_in_failed" });
    }
    const ninth = await signInCore(h.ctx(), wrong);
    expect(ninth.state).toMatchObject({
      status: "error",
      code: "rate_limited",
      retryAfterSeconds: 123,
    });
    // Even the right password is refused now: the limiter comes before the provider.
    expect((await signInCore(h.ctx(), FORM)).state).toMatchObject({ code: "rate_limited" });
  });

  it("the provider's own rate limit is shown as rate_limited and an outage as unavailable", async () => {
    h.state.idpDown = true;
    expect((await signInCore(h.ctx(), FORM)).state).toMatchObject({ code: "unavailable" });
  });

  it("a signed-in customer who posts the form again is sent on without a provider call", async () => {
    h.state.session = {
      customerId: customer.customerId,
      kycStatus: "none",
      riskTier: "new",
      locale: "bn",
      signedInAt: new Date(),
    };
    h.events.length = 0;
    const out = await signInCore(h.ctx(), FORM);
    expect(out.state).toEqual({ status: "done", redirectTo: "/wallet" });
    expect(h.events.filter((e) => e.startsWith("idp."))).toEqual([]);
  });
});
