import { describe, expect, it } from "vitest";
import { SIGN_UP_FORM, makeHarness, sessionOf } from "../fakes/auth-harness.ts";
import { DEFAULT_LANDING, landingAfterSignIn, landingPath } from "./landing.ts";
import { verifyPhoneCodeCore } from "./phone.ts";
import { signInCore } from "./sign-in.ts";
import { confirmEmailCore } from "./confirm-email.ts";

// U12: `next` is a relative path under an allow-list of prefixes. The same table is applied when the
// sign-in action runs, when the landing is built and in the phone step. The pending cookie and the
// ?verified flag never choose a target.

const HOSTILE: unknown[] = [
  "//evil.com",
  "/\\evil.com",
  "https://evil.com",
  "javascript:alert(1)",
  "/wallet/../admin",
  "/%2F%2Fevil.com",
  "/walletx",
  "/" + "a".repeat(2000),
  "",
  undefined,
  null,
  42,
  ["/wallet"],
  { toString: () => "/wallet" },
];

describe("landing", () => {
  it("every hostile value gives the default landing in both locales", () => {
    for (const bad of HOSTILE) {
      expect(landingPath("bn", bad), String(bad).slice(0, 30)).toBe(`/en${DEFAULT_LANDING}`);
      expect(landingPath("en", bad), String(bad).slice(0, 30)).toBe(`/en${DEFAULT_LANDING}`);
      expect(landingAfterSignIn("bn", bad, true)).toBe(`/en${DEFAULT_LANDING}`);
    }
  });

  it("an allowed path is kept, with its query, and localised", () => {
    expect(landingPath("bn", "/wallet?x=1")).toBe("/en/wallet?x=1");
    expect(landingPath("en", "/wallet?x=1")).toBe("/en/wallet?x=1");
    expect(landingPath("en", "/servers/abc")).toBe("/en/servers/abc");
  });

  it("an unverified phone goes to /verify first, with a safe next kept and a hostile next dropped", () => {
    expect(landingAfterSignIn("bn", "/wallet", false)).toBe("/en/verify?next=%2Fwallet");
    expect(landingAfterSignIn("en", "/wallet", false)).toBe("/en/verify?next=%2Fwallet");
    for (const bad of HOSTILE) expect(landingAfterSignIn("bn", bad, false)).toBe("/en/verify");
  });
});

describe("the actions", () => {
  it("sign-in lands on the default for every hostile next", async () => {
    for (const bad of HOSTILE) {
      const h = makeHarness();
      const customer = await h.signedUp();
      customer.phoneVerified = true;
      const out = await signInCore(h.ctx(), {
        email: SIGN_UP_FORM.email,
        password: SIGN_UP_FORM.password,
        next: bad,
        locale: "bn",
      });
      expect(out.state, String(bad).slice(0, 30)).toEqual({
        status: "done",
        redirectTo: `/en${DEFAULT_LANDING}`,
      });
    }
  });

  it("sign-in keeps an allowed next", async () => {
    const h = makeHarness();
    const customer = await h.signedUp();
    customer.phoneVerified = true;
    const out = await signInCore(h.ctx(), {
      email: SIGN_UP_FORM.email,
      password: SIGN_UP_FORM.password,
      next: "/wallet?x=1",
      locale: "en",
    });
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/wallet?x=1" });
  });

  it("the phone step ends on the default for every hostile next", async () => {
    for (const bad of HOSTILE) {
      const h = makeHarness();
      const customer = await h.signedUp();
      h.state.session = sessionOf(customer);
      await h.ports.sendOtp(h.state.session, {
        phone: "+8801712345678",
        ip: "198.51.100.7",
        idempotencyKey: "k",
      });
      const out = await verifyPhoneCodeCore(h.ctx(), { code: "111111", next: bad, locale: "bn" });
      expect(out.state, String(bad).slice(0, 30)).toEqual({
        status: "done",
        redirectTo: `/en${DEFAULT_LANDING}`,
      });
    }
  });

  it("the email confirmation drops a hostile next and keeps no other flag", async () => {
    const h = makeHarness();
    await h.idp.signUp({
      email: "n@example.test",
      password: "correct horse 99",
      name: "N",
      locale: "bn",
    });
    const { getFakeState } = await import("../fakes/outbox.ts");
    const code = getFakeState().emailCodes.get("n@example.test")?.code ?? "";
    const out = await confirmEmailCore(h.ctx(), {
      email: "n@example.test",
      code,
      next: "//evil.com",
      locale: "bn",
    });
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/login?verified=1" });
  });
});
