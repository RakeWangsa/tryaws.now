import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness } from "../fakes/auth-harness.ts";
import type { Harness } from "../fakes/auth-harness.ts";
import { getFakeState } from "../fakes/outbox.ts";
import { requestResetCore } from "./request-reset.ts";
import { resetPasswordCore } from "./reset-password.ts";
import { signInCore } from "./sign-in.ts";
import { signOutCore } from "./sign-out.ts";
import { sessionOf } from "../fakes/auth-harness.ts";

let h: Harness;
const EMAIL = "reset@example.test";
const OLD = "correct horse 99";
const NEW = "another long password 7";
const form = (over: Record<string, unknown> = {}) => ({
  email: EMAIL,
  code: getFakeState().emailCodes.get(EMAIL)?.code ?? "000000",
  password: NEW,
  passwordConfirm: NEW,
  locale: "bn",
  ...over,
});

beforeEach(async () => {
  h = makeHarness();
  await h.signedUp(EMAIL);
  await requestResetCore(h.ctx(), { email: EMAIL, locale: "bn" });
});

describe("resetPasswordCore", () => {
  it("a wrong code is code_wrong", async () => {
    const out = await resetPasswordCore(h.ctx(), form({ code: "000000" }));
    expect(out.state).toMatchObject({ status: "error", code: "code_wrong" });
  });

  it("an expired code is code_wrong too", async () => {
    const original = h.idp.confirmForgotPassword;
    h.idp.confirmForgotPassword = async () => ({ ok: false, kind: "expired_code" });
    const out = await resetPasswordCore(h.ctx(), form());
    h.idp.confirmForgotPassword = original;
    expect(out.state).toMatchObject({ status: "error", code: "code_wrong" });
  });

  it("a password the pool refuses is password_rejected on the password field", async () => {
    const original = h.idp.confirmForgotPassword;
    h.idp.confirmForgotPassword = async () => ({ ok: false, kind: "invalid_password" });
    const out = await resetPasswordCore(h.ctx(), form());
    h.idp.confirmForgotPassword = original;
    expect(out.state).toMatchObject({
      status: "error",
      code: "password_rejected",
      fields: { password: "invalid" },
    });
  });

  it("a weak password never reaches the provider", async () => {
    const out = await resetPasswordCore(
      h.ctx(),
      form({ password: "short", passwordConfirm: "short" }),
    );
    expect(out.state).toMatchObject({ status: "error", code: "invalid" });
    expect(h.events).not.toContain("idp.confirmForgotPassword");
  });

  it("success clears the pending cookie and the old password no longer signs in", async () => {
    const out = await resetPasswordCore(h.ctx(), form());
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/login?reset=1" });
    expect(out.effects.pending).toBe("clear");
    const old = await signInCore(h.ctx(), { email: EMAIL, password: OLD, locale: "bn" });
    expect(old.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    const fresh = await signInCore(h.ctx(), { email: EMAIL, password: NEW, locale: "bn" });
    expect(fresh.state.status).toBe("done");
  });
});

describe("signOutCore", () => {
  it("clears both cookies, revokes the refresh token and audits", async () => {
    const customer = [...h.customers.values()][0]!;
    h.state.session = sessionOf(customer);
    h.events.length = 0;
    const out = await signOutCore(h.ctx(), "fake-rt.x.1");
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/login" });
    expect(out.effects.clearCookies.map((c) => [c.name, c.maxAge])).toEqual([
      ["__Host-tc_at", 0],
      ["__Host-tc_rt", 0],
    ]);
    expect(h.events).toEqual(["session", "idp.revokeRefreshToken", "audit"]);
    expect(h.audits.at(-1)).toMatchObject({
      action: "auth.sign_out",
      customerId: customer.customerId,
    });
  });

  it("clears the cookies even when nobody is signed in", async () => {
    h.state.session = null;
    const out = await signOutCore(h.ctx(), undefined);
    expect(out.effects.clearCookies).toHaveLength(2);
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/login" });
  });
});
