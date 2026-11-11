import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, SIGN_UP_FORM, makeHarness } from "../fakes/auth-harness.ts";
import type { Harness } from "../fakes/auth-harness.ts";
import { LEGAL_VERSIONS } from "./legal.ts";
import { decodePending } from "./pending.ts";
import { signUpCore } from "./sign-up.ts";

let h: Harness;
let logs: string[];

beforeEach(() => {
  h = makeHarness();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("signUpCore", () => {
  it("registers once with the three acceptances at the legal versions and the viewer address", async () => {
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    expect(out.state).toEqual({ status: "done", redirectTo: "/verify" });
    expect(h.registered).toHaveLength(1);
    const input = h.registered[0] as {
      email: string;
      phone: string;
      name: string;
      ip: string;
      userAgent: string;
      acceptances: { document: string; version: string }[];
    };
    expect(input.email).toBe("rahim@example.test");
    expect(input.phone).toBe("+8801712345678");
    expect(input.name).toBe("Rahim Uddin");
    expect(input.ip).toBe("198.51.100.7");
    expect(input.userAgent).toBe("vitest-agent");
    expect(input.acceptances).toEqual([
      { document: "terms", version: LEGAL_VERSIONS.terms },
      { document: "acceptable_use", version: LEGAL_VERSIONS.acceptable_use },
      { document: "privacy", version: LEGAL_VERSIONS.privacy },
    ]);
    expect(h.customers.size).toBe(1);
  });

  it("sets a pending cookie for /verify that holds the address and no password", async () => {
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    const raw = out.effects.pending;
    expect(typeof raw).toBe("string");
    const pending = decodePending(raw as string, NOW.getTime());
    expect(pending).toMatchObject({ p: "signup", e: "rahim@example.test" });
    expect(raw).not.toContain(SIGN_UP_FORM.password);
  });

  it("uses the locale of the form for the redirect", async () => {
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM, locale: "en" });
    expect(out.state).toEqual({ status: "done", redirectTo: "/en/verify" });
  });

  it("a double submit creates one customer and the second answer equals the first", async () => {
    const first = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    const second = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    expect(second.state).toEqual(first.state);
    expect(h.customers.size).toBe(1);
  });

  it("a closed market is not_open", async () => {
    h.state.marketOpen = false;
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    expect(out.state).toMatchObject({ status: "error", code: "not_open" });
    expect(h.customers.size).toBe(0);
  });

  it("an identity provider that is down creates nothing and says unavailable", async () => {
    h.state.idpDown = true;
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    expect(h.customers.size).toBe(0);
  });

  it("an orphan (the row failed after the user was created) is unavailable and logs without the address", async () => {
    h.state.registerFails = true;
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    expect(out.state).toMatchObject({ status: "error", code: "unavailable" });
    const line = logs.find((l) => l.includes("signup.orphan_risk"));
    expect(line).toBeDefined();
    expect(line).not.toContain("example.test");
    expect(line).not.toContain("Rahim");
    expect(JSON.parse(line as string)).toMatchObject({ event: "signup.orphan_risk" });
  });

  it("field errors come from the shared parser, with the whitelisted values and no password", async () => {
    const out = await signUpCore(h.ctx(), {
      ...SIGN_UP_FORM,
      passwordConfirm: "different password 1",
      consentTerms: "",
      email: "not-an-email",
    });
    expect(out.state.status).toBe("error");
    if (out.state.status !== "error") return;
    expect(out.state.code).toBe("invalid");
    expect(out.state.fields).toMatchObject({
      email: "invalid",
      passwordConfirm: "mismatch",
      consentTerms: "must_accept",
    });
    expect(out.state.values).toMatchObject({ fullName: "Rahim Uddin", email: "not-an-email" });
    expect(JSON.stringify(out.state)).not.toContain(SIGN_UP_FORM.password);
    expect(h.registered).toHaveLength(0);
  });

  it("a signed-in customer is sent to the panel and nothing is registered", async () => {
    const customer = await h.signedUp("signed.in@example.test");
    h.state.session = {
      customerId: customer.customerId,
      kycStatus: "none",
      riskTier: "new",
      locale: "bn",
      signedInAt: new Date(),
    };
    const out = await signUpCore(h.ctx(), { ...SIGN_UP_FORM });
    expect(out.state).toEqual({ status: "done", redirectTo: "/wallet" });
    expect(h.registered).toHaveLength(0);
  });
});
