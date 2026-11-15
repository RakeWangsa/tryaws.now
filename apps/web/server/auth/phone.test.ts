import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, sessionOf } from "../fakes/auth-harness.ts";
import type { Customer, Harness } from "../fakes/auth-harness.ts";
import { sendPhoneCodeCore, verifyPhoneCodeCore } from "./phone.ts";

// R8: the phone steps take the customer only from the session. Two customers; the second one's open
// challenge is never reachable from the first one's session, whatever the form says.

let h: Harness;
let a: Customer;
let b: Customer;

beforeEach(async () => {
  h = makeHarness();
  a = await h.signedUp("a@example.test");
  b = await h.signedUp("b@example.test");
});

const send = (key: string, extra: Record<string, unknown> = {}) =>
  sendPhoneCodeCore(h.ctx(), { phone: "01712345678", idempotencyKey: key, locale: "bn", ...extra });

describe("sendPhoneCodeCore", () => {
  it("without a session it sends the customer to sign in and sends nothing", async () => {
    h.state.session = null;
    const out = await send("k-1");
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/login" });
    expect(h.sms.sent).toHaveLength(0);
  });

  it("ignores a customerId field of the form", async () => {
    h.state.session = sessionOf(a);
    const seen: string[] = [];
    const original = h.ports.sendOtp;
    h.ports.sendOtp = async (session, input) => {
      seen.push(session.customerId);
      return original(session, input);
    };
    await send("k-1", { customerId: b.customerId, customer_id: b.customerId });
    expect(seen).toEqual([a.customerId]);
  });

  it("the same key twice sends one SMS and answers the same", async () => {
    h.state.session = sessionOf(a);
    const first = await send("k-1");
    const second = await send("k-1");
    expect(second.state).toEqual(first.state);
    expect(h.sms.sent).toHaveLength(1);
  });

  it("a missing or malformed key sends nothing and asks the page to render again", async () => {
    h.state.session = sessionOf(a);
    for (const key of [undefined, "", "bad key with spaces", "x".repeat(200)]) {
      const out = await sendPhoneCodeCore(h.ctx(), {
        phone: "01712345678",
        ...(key === undefined ? {} : { idempotencyKey: key }),
        locale: "bn",
      });
      expect(out.state).toEqual({ status: "done", redirectTo: "/en/verify" });
    }
    expect(h.sms.sent).toHaveLength(0);
  });

  it("a fourth send is rate_limited with the retry time of the service", async () => {
    h.state.session = sessionOf(a);
    await send("k-1");
    h.state.session = sessionOf(b);
    await send("k-2");
    h.state.session = sessionOf(a);
    await send("k-3");
    const out = await send("k-4");
    expect(out.state).toMatchObject({
      status: "error",
      code: "rate_limited",
      retryAfterSeconds: 77,
    });
  });

  it("an invalid number is a field error and the SMS text is never in the state", async () => {
    h.state.session = sessionOf(a);
    const bad = await sendPhoneCodeCore(h.ctx(), {
      phone: "12",
      idempotencyKey: "k-1",
      locale: "bn",
    });
    expect(bad.state).toMatchObject({
      status: "error",
      code: "invalid",
      fields: { phone: "invalid" },
    });
    await send("k-2");
    expect(JSON.stringify((await send("k-2")).state)).not.toContain("code ");
  });

  it("without an OTP service it is not_open", async () => {
    h.state.session = sessionOf(a);
    h.state.otpOn = false;
    expect((await send("k-1")).state).toMatchObject({ status: "error", code: "not_open" });
  });
});

describe("verifyPhoneCodeCore (cross-tenant)", () => {
  it("A with B's code gets code_wrong and B's challenge keeps its attempts", async () => {
    h.state.session = sessionOf(b);
    await send("kb"); // B's code is 111111 + 0
    h.state.session = sessionOf(a);
    await send("ka"); // A's code is 111111 + 1 = 111112
    const wrong = await verifyPhoneCodeCore(h.ctx(), { code: "111111", locale: "bn" });
    expect(wrong.state).toMatchObject({ status: "error", code: "code_wrong" });
    // B can still verify with their own code in the first attempt: A's try did not touch it.
    h.state.session = sessionOf(b);
    const right = await verifyPhoneCodeCore(h.ctx(), { code: "111111", locale: "bn" });
    expect(right.state).toEqual({ status: "done", redirectTo: "/en/wallet" });
  });

  it("a customer with no challenge gets code_wrong, never a hint about others", async () => {
    h.state.session = sessionOf(a);
    const out = await verifyPhoneCodeCore(h.ctx(), { code: "111111", locale: "bn" });
    expect(out.state).toMatchObject({ status: "error", code: "code_wrong" });
  });

  it("five wrong tries end in rate_limited", async () => {
    h.state.session = sessionOf(a);
    await send("ka");
    for (let i = 0; i < 5; i++) {
      await verifyPhoneCodeCore(h.ctx(), { code: "000000", locale: "bn" });
    }
    const out = await verifyPhoneCodeCore(h.ctx(), { code: "000000", locale: "bn" });
    expect(out.state).toMatchObject({
      status: "error",
      code: "rate_limited",
      retryAfterSeconds: 300,
    });
  });

  it("without a session it goes to sign-in", async () => {
    h.state.session = null;
    const out = await verifyPhoneCodeCore(h.ctx(), { code: "111111", locale: "en" });
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/login" });
  });

  it("a malformed code is a field error and does not reach the service", async () => {
    h.state.session = sessionOf(a);
    const out = await verifyPhoneCodeCore(h.ctx(), { code: "12", locale: "bn" });
    expect(out.state).toMatchObject({
      status: "error",
      code: "invalid",
      fields: { code: "invalid" },
    });
    expect(h.events).not.toContain("otp.verify");
  });
});
