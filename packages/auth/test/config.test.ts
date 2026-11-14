import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  FRESH_SIGN_IN_MINUTES,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  REFRESH_WINDOW_SECONDS,
  CUSTOMER_CLIENT_LINK,
  SIGN_UP_CLIENT_LINK,
  customerClientFromLink,
  authConfigFromEnv,
  signUpClientFromLink,
} from "../config";

const GOOD = {
  COGNITO_CUSTOMER_POOL_ID: "ap-southeast-1_AbC123xyz",
  COGNITO_CUSTOMER_CLIENT_ID: "abcdefghij1234567890",
};

describe("authConfigFromEnv", () => {
  it("authConfigFromEnv reads the pool id and the client id", () => {
    const c = authConfigFromEnv(GOOD);
    expect(c.customer.userPoolId).toBe("ap-southeast-1_AbC123xyz");
    expect(c.customer.clientId).toBe("abcdefghij1234567890");
  });

  it("derives the region from the pool id", () => {
    expect(authConfigFromEnv(GOOD).customer.region).toBe("ap-southeast-1");
  });

  it("throws a TypeError without a pool id", () => {
    expect(() =>
      authConfigFromEnv({ COGNITO_CUSTOMER_CLIENT_ID: GOOD.COGNITO_CUSTOMER_CLIENT_ID }),
    ).toThrow(TypeError);
    expect(() => authConfigFromEnv({})).toThrow(TypeError);
  });

  it("throws a TypeError without a client id or with a malformed one", () => {
    const pool = { COGNITO_CUSTOMER_POOL_ID: GOOD.COGNITO_CUSTOMER_POOL_ID };
    expect(() => authConfigFromEnv(pool)).toThrow(TypeError);
    for (const clientId of ["", "short", "has space 1234567890", "x".repeat(65)]) {
      expect(() => authConfigFromEnv({ ...GOOD, COGNITO_CUSTOMER_CLIENT_ID: clientId })).toThrow(
        TypeError,
      );
    }
  });

  it.each(["", "abc", "_x", "ap-southeast-1_", "ap-southeast-1_ab cd"])(
    "throws for a pool id that has no region part: %j",
    (poolId) => {
      expect(() => authConfigFromEnv({ ...GOOD, COGNITO_CUSTOMER_POOL_ID: poolId })).toThrow(
        TypeError,
      );
    },
  );

  it("the error text holds no value that was passed in", () => {
    const secret = "SECRET-LOOKING_VALUE";
    for (const env of [
      { ...GOOD, COGNITO_CUSTOMER_POOL_ID: secret },
      { ...GOOD, COGNITO_CUSTOMER_CLIENT_ID: secret },
    ]) {
      let message = "";
      try {
        authConfigFromEnv(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });

  it("uses the documented defaults for the window and the cookie age", () => {
    const c = authConfigFromEnv(GOOD);
    expect(c.refreshWindowSeconds).toBe(300);
    expect(c.refreshCookieMaxAgeSeconds).toBe(2_592_000);
    expect(REFRESH_WINDOW_SECONDS).toBe(300);
    expect(REFRESH_COOKIE_MAX_AGE_SECONDS).toBe(2_592_000);
    expect(FRESH_SIGN_IN_MINUTES).toBe(10);
    expect(CLOCK_SKEW_SECONDS).toBe(60);
  });
});

// WPU-X12: the server-only sign-up client reaches the web server function as the SST link of the
// Cognito client component (properties id and secret), never as an environment variable.
describe("signUpClientFromLink", () => {
  const ID = "1example23456789";
  const SECRET = "13ka4h7u28d9oo44tqpq9djqsfvhvu8rk4d2ighvpu0k8fj1c2r9";

  it("names the link of the infra component", () => {
    expect(SIGN_UP_CLIENT_LINK).toBe("CustomerSignUpClient");
  });

  it("reads the id and the secret of the link", () => {
    expect(signUpClientFromLink({ id: ID, secret: SECRET })).toEqual({
      clientId: ID,
      clientSecret: SECRET,
    });
  });

  it.each([
    ["no link", undefined],
    ["null", null],
    ["a string", `${ID}:${SECRET}`],
    ["no secret", { id: ID }],
    ["an empty secret", { id: ID, secret: "" }],
    ["a short secret", { id: ID, secret: "abc" }],
    ["a secret with spaces", { id: ID, secret: `${SECRET.slice(0, 30)} ${SECRET.slice(31)}` }],
    ["the placeholder", { id: ID, secret: "not-configured" }],
    ["a non-string secret", { id: ID, secret: 42 }],
    ["no id", { secret: SECRET }],
    ["a malformed id", { id: "has space 1234567890", secret: SECRET }],
  ])("fails closed with %s (R16)", (_label, link) => {
    expect(() => signUpClientFromLink(link)).toThrow(TypeError);
  });

  it("the error text is fixed and holds no value that was passed in", () => {
    const messages = new Set<string>();
    for (const link of [{ id: ID, secret: "x y" }, { id: SECRET, secret: 1 }, { id: "bad id" }]) {
      try {
        signUpClientFromLink(link);
      } catch (e) {
        const message = (e as Error).message;
        expect(message).not.toContain(ID);
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain("bad id");
        messages.add(message);
      }
    }
    expect(messages.size).toBeGreaterThan(0);
    for (const m of messages) expect(m).toMatch(/^auth config: CustomerSignUpClient /);
  });
});

// WPU-X12 round 4: the token-issuing customer client has a secret too (so Cognito itself refuses
// SignUp, Resend and ForgotPassword through it). Its id stays an environment value (the proxy and the
// token verifier read it); its secret is the property of the SST link CustomerAppClient, and the link's id
// must be that same client.
describe("customerClientFromLink", () => {
  const ID = GOOD.COGNITO_CUSTOMER_CLIENT_ID;
  const SECRET = "customer0app0client0secret0abcdef";

  it("names the link of the infra component", () => {
    expect(CUSTOMER_CLIENT_LINK).toBe("CustomerAppClient");
  });

  it("reads the secret of the link when its id is the client of the pool", () => {
    expect(customerClientFromLink({ id: ID, secret: SECRET }, ID)).toEqual({
      clientId: ID,
      clientSecret: SECRET,
    });
  });

  it.each([
    ["no link", undefined, ID],
    ["null", null, ID],
    ["a string", `${ID}:${SECRET}`, ID],
    ["no secret", { id: ID }, ID],
    ["an empty secret", { id: ID, secret: "" }, ID],
    ["a short secret", { id: ID, secret: "abc" }, ID],
    ["the placeholder", { id: ID, secret: "not-configured" }, ID],
    ["no id", { secret: SECRET }, ID],
    ["a malformed id", { id: "has space 1234567890", secret: SECRET }, ID],
    ["another client's id", { id: "zyxwvutsrq0987654321", secret: SECRET }, ID],
    ["an unusable expected id", { id: ID, secret: SECRET }, "has space"],
  ])("fails closed with %s (R16)", (_label, link, expected) => {
    expect(() => customerClientFromLink(link, expected)).toThrow(TypeError);
  });

  it("the error text is fixed and holds no value that was passed in", () => {
    const messages = new Set<string>();
    for (const link of [
      { id: ID, secret: "x y" },
      { id: "zyxwvutsrq0987654321", secret: SECRET },
      { id: SECRET, secret: 1 },
    ]) {
      try {
        customerClientFromLink(link, ID);
      } catch (e) {
        const message = (e as Error).message;
        for (const value of [ID, SECRET, "zyxwvutsrq0987654321"]) {
          expect(message).not.toContain(value);
        }
        messages.add(message);
      }
    }
    expect(messages.size).toBeGreaterThan(0);
    for (const m of messages) expect(m).toMatch(/^auth config: CustomerAppClient /);
  });
});
