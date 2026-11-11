import { beforeEach, describe, expect, it } from "vitest";
import { SIGN_UP_FORM, goodHeaders, makeHarness, sessionOf } from "../fakes/auth-harness.ts";
import type { Harness } from "../fakes/auth-harness.ts";
import { confirmEmailCore } from "./confirm-email.ts";
import { sendPhoneCodeCore, verifyPhoneCodeCore } from "./phone.ts";
import { requestResetCore } from "./request-reset.ts";
import { resendEmailCodeCore } from "./resend-email-code.ts";
import { resetPasswordCore } from "./reset-password.ts";
import { signInCore } from "./sign-in.ts";
import { signOutCore } from "./sign-out.ts";
import { signUpCore } from "./sign-up.ts";
import type { Outcome } from "./state.ts";

// R9: authenticate, authorize, validate, rate limit, execute, audit. The harness records what each
// core asks of the session, the limiter, the provider and the audit; a failure at step n must leave
// the later steps uncalled.

interface Case {
  name: string;
  needsSession: boolean;
  /** The calls of a complete run, in order. */
  full: string[];
  form: Record<string, unknown>;
  run: (h: Harness, form: Record<string, unknown>, headers?: Headers) => Promise<Outcome>;
  hasLimiter: boolean;
}

const OLD = "correct horse 99";
const cases: Case[] = [
  {
    name: "signUpCore",
    needsSession: false,
    full: ["session", "limit", "register", "idp.signUp"],
    form: { ...SIGN_UP_FORM },
    run: (h, f, headers) => signUpCore(h.ctx(headers), f),
    hasLimiter: true,
  },
  {
    name: "confirmEmailCore",
    needsSession: false,
    full: ["limit", "idp.confirmSignUp"],
    form: { email: SIGN_UP_FORM.email, code: "000000", locale: "bn" },
    run: (h, f, headers) => confirmEmailCore(h.ctx(headers), f),
    hasLimiter: true,
  },
  {
    name: "resendEmailCodeCore",
    needsSession: false,
    full: ["limit", "idp.resendConfirmationCode"],
    form: { email: SIGN_UP_FORM.email, locale: "bn" },
    run: (h, f, headers) => resendEmailCodeCore(h.ctx(headers), f),
    hasLimiter: true,
  },
  {
    name: "signInCore",
    needsSession: false,
    full: ["session", "limit", "idp.signIn", "completeSignIn", "audit"],
    form: { email: SIGN_UP_FORM.email, password: OLD, locale: "bn" },
    run: (h, f, headers) => signInCore(h.ctx(headers), f),
    hasLimiter: true,
  },
  {
    name: "requestResetCore",
    needsSession: false,
    full: ["session", "limit", "idp.forgotPassword"],
    form: { email: SIGN_UP_FORM.email, locale: "bn" },
    run: (h, f, headers) => requestResetCore(h.ctx(headers), f),
    hasLimiter: true,
  },
  {
    name: "resetPasswordCore",
    needsSession: false,
    full: ["limit", "idp.confirmForgotPassword"],
    form: {
      email: SIGN_UP_FORM.email,
      code: "000000",
      password: "another long password 7",
      passwordConfirm: "another long password 7",
      locale: "bn",
    },
    run: (h, f, headers) => resetPasswordCore(h.ctx(headers), f),
    hasLimiter: true,
  },
  {
    name: "sendPhoneCodeCore",
    needsSession: true,
    full: ["session", "otp.send"],
    form: { phone: "01712345678", idempotencyKey: "key-1", locale: "bn" },
    run: (h, f, headers) => sendPhoneCodeCore(h.ctx(headers), f),
    hasLimiter: false,
  },
  {
    name: "verifyPhoneCodeCore",
    needsSession: true,
    full: ["session", "otp.verify"],
    form: { code: "123456", locale: "bn" },
    run: (h, f, headers) => verifyPhoneCodeCore(h.ctx(headers), f),
    hasLimiter: false,
  },
  {
    name: "signOutCore",
    needsSession: true,
    full: ["session", "audit"],
    form: {},
    run: (h, _f, headers) => signOutCore(h.ctx(headers), undefined),
    hasLimiter: false,
  },
];

let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  const customer = await h.signedUp();
  h.state.session = null;
  // An open challenge for the verify case, from this customer's own session.
  h.state.session = sessionOf(customer);
  await h.ports.sendOtp(h.state.session, {
    phone: "+8801712345678",
    ip: "198.51.100.7",
    idempotencyKey: "k0",
  });
  h.state.session = null;
  h.events.length = 0;
  h.sms.reset();
});

const SIDE_EFFECTS = /^(limit|register|audit|otp\.|idp\.|completeSignIn)/;
const sideEffects = (events: string[]) => events.filter((e) => SIDE_EFFECTS.test(e));

describe("each core runs its steps in the R9 order", () => {
  for (const c of cases) {
    it(`${c.name}: bad origin stops before the parser, the limiter and the provider`, async () => {
      if (c.needsSession) h.state.session = sessionOf([...h.customers.values()][0]!);
      const out = await c.run(h, c.form, goodHeaders({ origin: "https://evil.example" }));
      expect(out.state).toMatchObject({ status: "error", code: "bad_origin" });
      expect(sideEffects(h.events)).toEqual([]);
      expect(out.effects.setCookies).toEqual([]);
    });

    it(`${c.name}: a request with no viewer address stops before the limiter and the provider`, async () => {
      if (c.needsSession) h.state.session = sessionOf([...h.customers.values()][0]!);
      const headers = goodHeaders();
      headers.delete("cloudfront-viewer-address");
      headers.set("x-forwarded-for", "203.0.113.1");
      const out = await c.run(h, c.form, headers);
      if (c.name === "signOutCore" || c.name === "verifyPhoneCodeCore") {
        // These two need no address: they have no limiter and the service does not read it.
        expect(out.state.status).not.toBe("idle");
        return;
      }
      expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
      expect(sideEffects(h.events)).toEqual([]);
    });

    if (c.name !== "signOutCore") {
      it(`${c.name}: an invalid form reaches neither the limiter nor the provider`, async () => {
        if (c.needsSession) h.state.session = sessionOf([...h.customers.values()][0]!);
        const bad = Object.fromEntries(
          Object.keys(c.form).map((k) => [k, k === "locale" ? "bn" : ""]),
        );
        const out = await c.run(h, bad);
        expect(out.state).toMatchObject({ status: "error", code: "invalid" });
        expect(sideEffects(h.events)).toEqual([]);
      });
    }

    if (c.hasLimiter) {
      it(`${c.name}: a refused limiter stops before the provider`, async () => {
        for (let i = 0; i < 60; i++) await c.run(h, c.form);
        h.events.length = 0;
        const out = await c.run(h, c.form);
        expect(out.state).toMatchObject({ status: "error", code: "rate_limited" });
        expect(sideEffects(h.events)).toEqual(["limit"]);
      });
    }

    it(`${c.name}: a complete run makes exactly its calls, in order`, async () => {
      if (c.needsSession) h.state.session = sessionOf([...h.customers.values()][0]!);
      const form =
        c.name === "signUpCore"
          ? { ...c.form, email: "new.person@example.test" }
          : c.name === "verifyPhoneCodeCore"
            ? { ...c.form, code: "111111" }
            : c.form;
      await c.run(h, form);
      expect(h.events).toEqual(c.full);
    });
  }
});

describe("the identity provider and the limiter key must be configured (R16)", () => {
  it("no identity provider means not_open and no further work", async () => {
    h.runtime.identity = null;
    const out = await signInCore(h.ctx(), cases[3]!.form);
    expect(out.state).toMatchObject({ status: "error", code: "not_open" });
    expect(sideEffects(h.events)).toEqual([]);
  });

  it("no limiter key means not_open and no limiter call", async () => {
    h.runtime.authLimitKey = null;
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    expect(out.state).toMatchObject({ status: "error", code: "not_open" });
    expect(sideEffects(h.events)).toEqual([]);
  });
});
