import { beforeEach, describe, expect, it } from "vitest";
import { SIGN_UP_FORM, makeHarness } from "../fakes/auth-harness.ts";
import type { Harness } from "../fakes/auth-harness.ts";
import { getFakeState } from "../fakes/outbox.ts";
import { confirmEmailCore } from "./confirm-email.ts";
import { requestResetCore } from "./request-reset.ts";
import { resendEmailCodeCore } from "./resend-email-code.ts";
import { resetPasswordCore } from "./reset-password.ts";
import { signInCore } from "./sign-in.ts";
import { signUpCore } from "./sign-up.ts";
import type { Outcome } from "./state.ts";

// Review focus 1: an address that has an account and one that has none are told the same thing, in
// the same state, with the same message and the same redirect. Compared as structures, `ref` aside.

let h: Harness;
const KNOWN = "known@example.test";
const UNKNOWN = "nobody@example.test";
const PASSWORD = "correct horse 99";

const sameButRef = (o: Outcome): unknown => {
  const state = { ...o.state } as Record<string, unknown>;
  delete state["ref"];
  return { state, effects: o.effects };
};

beforeEach(async () => {
  h = makeHarness();
  await h.signedUp(KNOWN);
});

describe("one answer for a known and an unknown address", () => {
  it("sign-up: a new address and an existing one", async () => {
    const fresh = await signUpCore(h.ctx(), { ...SIGN_UP_FORM, email: "fresh@example.test" });
    const existing = await signUpCore(h.ctx(), { ...SIGN_UP_FORM, email: KNOWN });
    expect(fresh.state.status).toBe("done");
    // The pending cookie carries the address, so compare it without the address.
    const strip = (o: Outcome) => ({
      ...(sameButRef(o) as object),
      effects: { ...o.effects, pending: o.effects.pending === null ? null : "set" },
    });
    expect(strip(existing)).toEqual(strip(fresh));
    expect((fresh.state as { redirectTo: string }).redirectTo).toBe("/en/verify");
  });

  it("sign-up: the one documented extra call is a resend for an existing address", async () => {
    await signUpCore(h.ctx(), { ...SIGN_UP_FORM, email: "fresh@example.test" });
    const freshCalls = h.events.filter((e) => e.startsWith("idp."));
    h.events.length = 0;
    await signUpCore(h.ctx(), { ...SIGN_UP_FORM, email: KNOWN });
    const existingCalls = h.events.filter((e) => e.startsWith("idp."));
    expect(freshCalls).toEqual(["idp.signUp"]);
    expect(existingCalls).toEqual(["idp.signUp", "idp.resendConfirmationCode"]);
  });

  it("forgot password: a known and an unknown address", async () => {
    const known = await requestResetCore(h.ctx(), { email: KNOWN, locale: "bn" });
    const unknown = await requestResetCore(h.ctx(), { email: UNKNOWN, locale: "bn" });
    expect((known.state as { redirectTo: string }).redirectTo).toBe("/en/reset-password");
    expect(unknown.state).toEqual({ ...known.state, ref: (unknown.state as { ref: string }).ref });
    expect(unknown.effects.pending).not.toBeNull();
    // Only the known address got a code.
    expect(getFakeState().emailCodes.has(KNOWN)).toBe(true);
    expect(getFakeState().emailCodes.has(UNKNOWN)).toBe(false);
  });

  it("sign-in: a wrong password, an unknown address and an unconfirmed address", async () => {
    await h.idp.signUp({
      email: "pending@example.test",
      password: PASSWORD,
      name: "P",
      locale: "bn",
    });
    const wrong = await signInCore(h.ctx(), {
      email: KNOWN,
      password: "wrong wrong wrong",
      locale: "bn",
    });
    const unknown = await signInCore(h.ctx(), { email: UNKNOWN, password: PASSWORD, locale: "bn" });
    const unconfirmed = await signInCore(h.ctx(), {
      email: "pending@example.test",
      password: PASSWORD,
      locale: "bn",
    });
    expect(wrong.state).toMatchObject({ status: "error", code: "sign_in_failed" });
    const shape = (o: Outcome) => {
      const s = sameButRef(o) as { state: Record<string, unknown> };
      const values = { ...(s.state["values"] as Record<string, string>) };
      delete values["email"];
      return { ...s, state: { ...s.state, values } };
    };
    expect(shape(unknown)).toEqual(shape(wrong));
    expect(shape(unconfirmed)).toEqual(shape(wrong));
    expect(wrong.effects.setCookies).toEqual([]);
  });

  it("confirm: a wrong code and an unknown address", async () => {
    await h.idp.signUp({
      email: "waiting@example.test",
      password: PASSWORD,
      name: "W",
      locale: "bn",
    });
    const wrong = await confirmEmailCore(h.ctx(), {
      email: "waiting@example.test",
      code: "000000",
      locale: "bn",
    });
    const unknown = await confirmEmailCore(h.ctx(), {
      email: UNKNOWN,
      code: "000000",
      locale: "bn",
    });
    expect(wrong.state).toMatchObject({ status: "error", code: "code_wrong" });
    const strip = (o: Outcome) => {
      const s = sameButRef(o) as { state: Record<string, unknown> };
      return { ...s, state: { ...s.state, values: {} } };
    };
    expect(strip(unknown)).toEqual(strip(wrong));
  });

  it("reset: a wrong code and an unknown address", async () => {
    await requestResetCore(h.ctx(), { email: KNOWN, locale: "bn" });
    const body = {
      code: "000000",
      password: "another long password 7",
      passwordConfirm: "another long password 7",
      locale: "bn",
    };
    const wrong = await resetPasswordCore(h.ctx(), { ...body, email: KNOWN });
    const unknown = await resetPasswordCore(h.ctx(), { ...body, email: UNKNOWN });
    expect(wrong.state).toMatchObject({ status: "error", code: "code_wrong" });
    const strip = (o: Outcome) => {
      const s = sameButRef(o) as { state: Record<string, unknown> };
      return { ...s, state: { ...s.state, values: {} } };
    };
    expect(strip(unknown)).toEqual(strip(wrong));
  });

  it("resend: a known and an unknown address", async () => {
    const known = await resendEmailCodeCore(h.ctx(), { email: KNOWN, locale: "bn" });
    const unknown = await resendEmailCodeCore(h.ctx(), { email: UNKNOWN, locale: "bn" });
    expect((known.state as { redirectTo: string }).redirectTo).toBe("/en/verify");
    expect((unknown.state as { redirectTo: string }).redirectTo).toBe("/en/verify");
    expect(unknown.effects.pending).not.toBeNull();
  });
});
