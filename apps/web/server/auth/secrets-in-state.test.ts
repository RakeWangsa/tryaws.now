import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_UP_FORM, makeHarness, sessionOf } from "../fakes/auth-harness.ts";
import type { Harness } from "../fakes/auth-harness.ts";
import { confirmEmailCore } from "./confirm-email.ts";
import { sendPhoneCodeCore, verifyPhoneCodeCore } from "./phone.ts";
import { requestResetCore } from "./request-reset.ts";
import { resendEmailCodeCore } from "./resend-email-code.ts";
import { resetPasswordCore } from "./reset-password.ts";
import { signInCore } from "./sign-in.ts";
import { signOutCore } from "./sign-out.ts";
import { signUpCore } from "./sign-up.ts";
import { ECHOED_FIELDS } from "./state.ts";
import type { Outcome } from "./state.ts";

// Review focus 5: a password, a code, a token or a Cognito Session must not appear in an action
// state, a log line, a redirect, an audit row or the pending cookie.

const PASSWORD = "Planted-Pass-9f3a-xyz";
const CODE = "654321";
const REFRESH = "planted-refresh-token-42";
const SESSION = "planted-cognito-session-77";
const PLANTED = [PASSWORD, CODE, REFRESH, SESSION, "654321"];

let h: Harness;
let logs: string[];

beforeEach(async () => {
  h = makeHarness();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(() => vi.restoreAllMocks());

function expectClean(name: string, out: Outcome): void {
  const shown = JSON.stringify(out.state) + JSON.stringify(out.effects.pending);
  for (const planted of PLANTED) {
    expect(shown, `${name} state/pending vs ${planted}`).not.toContain(planted);
  }
  if (out.state.status === "done") {
    for (const planted of PLANTED) expect(out.state.redirectTo).not.toContain(planted);
  }
  if (out.state.status === "error" && out.state.values !== undefined) {
    for (const key of Object.keys(out.state.values)) expect(ECHOED_FIELDS).toContain(key);
  }
  for (const planted of PLANTED) {
    expect(logs.join("\n"), `${name} log vs ${planted}`).not.toContain(planted);
  }
  expect(logs.join("\n")).not.toContain("@example.test");
  expect(JSON.stringify(h.audits)).not.toContain(PASSWORD);
}

describe("planted secrets never reach a state, a redirect, a log, an audit row or the pending cookie", () => {
  it("sign-up, valid and invalid", async () => {
    const form = {
      ...SIGN_UP_FORM,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      code: CODE,
      refreshToken: REFRESH,
      session: SESSION,
    };
    expectClean("signUp ok", await signUpCore(h.ctx(), form));
    expectClean(
      "signUp mismatch",
      await signUpCore(h.ctx(), { ...form, passwordConfirm: PASSWORD + "x" }),
    );
    expectClean("signUp bad phone", await signUpCore(h.ctx(), { ...form, phone: "12" }));
  });

  it("confirm and resend", async () => {
    await h.signedUp("c@example.test");
    const f = {
      email: "c@example.test",
      code: CODE,
      password: PASSWORD,
      refreshToken: REFRESH,
      session: SESSION,
      locale: "bn",
    };
    expectClean("confirm wrong", await confirmEmailCore(h.ctx(), f));
    expectClean("confirm invalid", await confirmEmailCore(h.ctx(), { ...f, code: "x" }));
    expectClean("resend", await resendEmailCodeCore(h.ctx(), f));
  });

  it("sign-in, success and failure", async () => {
    await h.signedUp("s@example.test");
    const f = {
      email: "s@example.test",
      password: PASSWORD,
      code: CODE,
      refreshToken: REFRESH,
      session: SESSION,
      locale: "bn",
    };
    expectClean("signIn wrong", await signInCore(h.ctx(), f));
    const ok = await signInCore(h.ctx(), { ...f, password: "correct horse 99" });
    expect(ok.state.status).toBe("done");
    // The cookie specs carry the session tokens by design; nothing else of the outcome does.
    expect(JSON.stringify(ok.state)).not.toContain("dev.");
    expect(JSON.stringify(ok.effects.pending)).not.toContain("dev.");
  });

  it("forgot and reset", async () => {
    await h.signedUp("r@example.test");
    const f = {
      email: "r@example.test",
      code: CODE,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      refreshToken: REFRESH,
      session: SESSION,
      locale: "bn",
    };
    expectClean("forgot", await requestResetCore(h.ctx(), f));
    expectClean("reset wrong code", await resetPasswordCore(h.ctx(), f));
    expectClean(
      "reset weak",
      await resetPasswordCore(h.ctx(), { ...f, password: "short", passwordConfirm: "short" }),
    );
  });

  it("phone send and verify, and sign-out", async () => {
    const customer = await h.signedUp("p@example.test");
    h.state.session = sessionOf(customer);
    const f = {
      phone: "01712345678",
      idempotencyKey: "k-1",
      code: CODE,
      password: PASSWORD,
      refreshToken: REFRESH,
      locale: "bn",
    };
    expectClean("sendPhone", await sendPhoneCodeCore(h.ctx(), f));
    expectClean("verifyPhone", await verifyPhoneCodeCore(h.ctx(), f));
    // The SMS text with the code is held by the gateway only, never by the state.
    const sms = h.sms.sent.map((m) => m.text).join();
    expect(sms).toContain("code ");
    expectClean("signOut", await signOutCore(h.ctx(), REFRESH));
  });

  it("an error state echoes only the whitelisted fields", async () => {
    const out = await signUpCore(h.ctx(), {
      ...SIGN_UP_FORM,
      phone: "12",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      code: CODE,
      next: "/wallet",
    });
    expect(out.state.status === "error" && Object.keys(out.state.values ?? {}).sort()).toEqual([
      "email",
      "fullName",
      "locale",
      "next",
      "phone",
    ]);
  });
});
