import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  FRESH_SIGN_IN_MINUTES,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  REFRESH_WINDOW_SECONDS,
  authConfigFromEnv,
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
