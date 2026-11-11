import { beforeAll, describe, expect, it } from "vitest";
import { adminAuthConfigFromEnv } from "../config";
import {
  ACCESS_COOKIE,
  ADMIN_ACCESS_COOKIE,
  adminSessionSetCookie,
  clearAdminSessionSetCookie,
  parseCookieHeader,
} from "../cookies";
import { createTestIssuer, type TestIssuer } from "../testing/keys";
import { createAccessTokenVerifier, type AccessTokenVerifier } from "../tokens";

let issuer: TestIssuer;
let verifier: AccessTokenVerifier;

beforeAll(() => {
  issuer = createTestIssuer();
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
});

describe("the amr claim of a verified token", () => {
  it("is returned as a list of strings", async () => {
    const out = await verifier.verify(issuer.sign({ amr: ["pwd", "mfa"] }));
    expect(out.ok && out.token.amr).toEqual(["pwd", "mfa"]);
  });

  it("is an empty list when the claim is absent or not a list", async () => {
    const none = await verifier.verify(issuer.sign());
    expect(none.ok && none.token.amr).toEqual([]);
    const odd = await verifier.verify(issuer.sign({ amr: "mfa" }));
    expect(odd.ok && odd.token.amr).toEqual([]);
  });

  it("keeps only the strings of a mixed list", async () => {
    const out = await verifier.verify(issuer.sign({ amr: ["mfa", 7, null, { a: 1 }] }));
    expect(out.ok && out.token.amr).toEqual(["mfa"]);
  });
});

describe("the admin cookie", () => {
  const now = new Date("2026-11-11T10:00:00.000Z");
  const clock = { now: () => now };

  it("is named __Host-tc_admin_at, apart from the customer cookie", () => {
    expect(ADMIN_ACCESS_COOKIE).toBe("__Host-tc_admin_at");
    expect(ADMIN_ACCESS_COOKIE).not.toBe(ACCESS_COOKIE);
  });

  it("is HttpOnly, Secure, SameSite=Lax, Path=/ with no Domain and lives as long as the token", () => {
    const c = adminSessionSetCookie("aaa.bbb.ccc", new Date(now.getTime() + 28_800_000), clock);
    expect(c.startsWith("__Host-tc_admin_at=aaa.bbb.ccc; ")).toBe(true);
    expect(c).toContain("Max-Age=28800");
    for (const a of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) expect(c).toContain(`; ${a}`);
    expect(c).not.toMatch(/domain=/i);
  });

  it("is cleared by name with Max-Age=0", () => {
    const c = clearAdminSessionSetCookie();
    expect(c).toContain("__Host-tc_admin_at=deleted");
    expect(c).toContain("Max-Age=0");
  });

  it("refuses a value that is not a token", () => {
    expect(() => adminSessionSetCookie("a;b", new Date(now.getTime() + 1000), clock)).toThrow(
      TypeError,
    );
    expect(() => adminSessionSetCookie("", new Date(now.getTime() + 1000), clock)).toThrow(
      TypeError,
    );
  });

  it("a customer cookie is not read as an admin cookie", () => {
    const m = parseCookieHeader("__Host-tc_at=customer.token.x");
    expect(m.get(ADMIN_ACCESS_COOKIE)).toBeUndefined();
  });
});

describe("adminAuthConfigFromEnv", () => {
  const GOOD = {
    COGNITO_ADMIN_POOL_ID: "ap-southeast-1_AdMin123",
    COGNITO_ADMIN_CLIENT_ID: "adminclient1234567890",
    ADMIN_IP_ALLOWLIST: "203.0.113.0/24, 2001:db8::/32",
  };

  it("reads the admin pool and the allowlist", () => {
    const c = adminAuthConfigFromEnv(GOOD);
    expect(c.admin).toEqual({
      region: "ap-southeast-1",
      userPoolId: "ap-southeast-1_AdMin123",
      clientId: "adminclient1234567890",
    });
    expect(c.allowlist).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
  });

  it("throws a TypeError with fixed text for a missing or malformed value", () => {
    expect(() => adminAuthConfigFromEnv({ ...GOOD, COGNITO_ADMIN_POOL_ID: undefined })).toThrow(
      TypeError,
    );
    expect(() => adminAuthConfigFromEnv({ ...GOOD, COGNITO_ADMIN_CLIENT_ID: "x" })).toThrow(
      TypeError,
    );
    expect(() => adminAuthConfigFromEnv({ ...GOOD, ADMIN_IP_ALLOWLIST: "" })).toThrow(TypeError);
    expect(() => adminAuthConfigFromEnv({ ...GOOD, ADMIN_IP_ALLOWLIST: "10.0.0.0/33" })).toThrow(
      /ADMIN_IP_ALLOWLIST/,
    );
  });
});
