import { emailSubject, ipSubject } from "@tc/notify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LIMIT_KEY,
  SIGN_UP_FORM,
  goodHeaders,
  makeHarness,
  sessionOf,
} from "../fakes/auth-harness.ts";
import type { Harness } from "../fakes/auth-harness.ts";
import { sendPhoneCodeCore } from "./phone.ts";
import { signInCore } from "./sign-in.ts";
import { signUpCore } from "./sign-up.ts";

// Review focus 3 (and parked finding 5 of WP2-T3): the limit key is the CloudFront-Viewer-Address,
// never x-forwarded-for, which a client can forge.

let h: Harness;
const REAL = "198.51.100.7";
const FORGED = "203.0.113.1";

beforeEach(() => {
  h = makeHarness();
});

const subjects = (h: Harness): string[] => h.rules.flat().map((r) => r.subject);

describe("the limiter counts under the CloudFront address", () => {
  it("sign-up with both headers is limited under the CloudFront address and never the forged one", async () => {
    const headers = goodHeaders({
      "cloudfront-viewer-address": `${REAL}:4711`,
      "x-forwarded-for": FORGED,
    });
    await signUpCore(h.ctx(headers), { ...SIGN_UP_FORM });
    expect(subjects(h)).toContain(ipSubject(LIMIT_KEY, REAL));
    expect(subjects(h)).not.toContain(ipSubject(LIMIT_KEY, FORGED));
  });

  it("the sign-in pair rule is made with the CloudFront address too", async () => {
    const headers = goodHeaders({ "x-forwarded-for": FORGED });
    await signInCore(h.ctx(headers), {
      email: "a@example.test",
      password: "x".repeat(12),
      locale: "bn",
    });
    expect(subjects(h)).toContain(emailSubject(LIMIT_KEY, "a@example.test", REAL));
    expect(subjects(h)).not.toContain(emailSubject(LIMIT_KEY, "a@example.test", FORGED));
  });

  it("a request with only x-forwarded-for is refused as unavailable outside fakes", async () => {
    const headers = goodHeaders({ "x-forwarded-for": FORGED });
    headers.delete("cloudfront-viewer-address");
    const out = await signUpCore(h.ctx(headers), { ...SIGN_UP_FORM });
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(h.rules).toEqual([]);
    expect(h.events.filter((e) => e.startsWith("idp."))).toEqual([]);
  });

  it("a malformed CloudFront address is refused the same way", async () => {
    const headers = goodHeaders({
      "cloudfront-viewer-address": "999.1.1.1:80",
      "x-forwarded-for": FORGED,
    });
    const out = await signInCore(h.ctx(headers), {
      email: "a@example.test",
      password: "x".repeat(12),
    });
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(h.rules).toEqual([]);
  });

  it("the phone send passes the CloudFront address to the OTP service, never the forged one", async () => {
    const customer = await h.signedUp();
    h.state.session = sessionOf(customer);
    const seen: string[] = [];
    const original = h.ports.sendOtp;
    h.ports.sendOtp = async (session, input) => {
      seen.push(input.ip);
      return original(session, input);
    };
    const headers = goodHeaders({ "x-forwarded-for": FORGED });
    await sendPhoneCodeCore(h.ctx(headers), {
      phone: "01712345678",
      idempotencyKey: "k-1",
      locale: "bn",
    });
    expect(seen).toEqual([REAL]);

    const noViewer = goodHeaders({ "x-forwarded-for": FORGED });
    noViewer.delete("cloudfront-viewer-address");
    const out = await sendPhoneCodeCore(h.ctx(noViewer), {
      phone: "01712345678",
      idempotencyKey: "k-2",
      locale: "bn",
    });
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(seen).toEqual([REAL]);
  });
});
