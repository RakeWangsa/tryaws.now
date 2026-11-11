import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearCookieSpecs,
  clearSessionSetCookies,
  sessionCookieSpecs,
  sessionSetCookies,
  type CookieSpec,
  type SessionTokens,
} from "../cookies";

const NOW = new Date("2026-11-11T10:00:00.000Z");
const clock = { now: () => NOW };
const tokens = (over: Partial<SessionTokens> = {}): SessionTokens => ({
  accessToken: "aaa.bbb.ccc",
  refreshToken: "r1.r2.r3.r4.r5",
  accessExpiresAt: new Date(NOW.getTime() + 3600_000),
  ...over,
});

// A tiny local serialiser of what a framework does with (name, value, options): the order is the
// order of sessionSetCookies, which is the order of the attributes of 6.1.
const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";
function serialise(s: CookieSpec): string {
  const parts = [`${s.name}=${s.value}`, `Max-Age=${s.maxAge}`];
  if (s.maxAge === 0) parts.push(`Expires=${EPOCH}`);
  parts.push(
    `Path=${s.path}`,
    "Secure",
    "HttpOnly",
    `SameSite=${s.sameSite === "lax" ? "Lax" : ""}`,
  );
  return parts.join("; ");
}

describe("sessionCookieSpecs agrees with sessionSetCookies, attribute by attribute", () => {
  it.each([
    ["both tokens", tokens(), 2_592_000],
    ["a custom refresh lifetime", tokens(), 100],
    ["no refresh token", tokens({ refreshToken: undefined }), 2_592_000],
    [
      "an expired access token (Max-Age 0)",
      tokens({ accessExpiresAt: new Date(NOW.getTime() - 5000) }),
      100,
    ],
    ["an invalid date (Max-Age 0)", tokens({ accessExpiresAt: new Date(Number.NaN) }), 100],
    [
      "a fraction of a second left",
      tokens({ accessExpiresAt: new Date(NOW.getTime() + 1999) }),
      100,
    ],
  ] as const)("%s", (_name, t, refreshMaxAge) => {
    const specs = sessionCookieSpecs(t, clock, refreshMaxAge);
    expect(specs.map(serialise)).toEqual(sessionSetCookies(t, clock, refreshMaxAge));
  });

  it("the default refresh lifetime matches too", () => {
    expect(sessionCookieSpecs(tokens(), clock).map(serialise)).toEqual(
      sessionSetCookies(tokens(), clock),
    );
  });

  it("every spec has the fixed attributes and only the documented fields", () => {
    for (const s of sessionCookieSpecs(tokens(), clock)) {
      expect(Object.keys(s).sort()).toEqual(
        ["httpOnly", "maxAge", "name", "path", "sameSite", "secure", "value"].sort(),
      );
      expect(s).toMatchObject({ path: "/", httpOnly: true, secure: true, sameSite: "lax" });
      expect(Number.isInteger(s.maxAge) && s.maxAge >= 0).toBe(true);
    }
    expect(sessionCookieSpecs(tokens(), clock).map((s) => s.name)).toEqual([
      ACCESS_COOKIE,
      REFRESH_COOKIE,
    ]);
  });
});

describe("a value that is not a token is refused with the fixed text", () => {
  it.each([
    ["a semicolon", "a.b;c"],
    ["a space", "a.b c"],
    ["a line break", "a.b\nSet-Cookie: x=1"],
    ["a comma", "a,b"],
    ["an empty value", ""],
    ["4001 characters", "a".repeat(4001)],
  ])("%s", (_name, bad) => {
    expect(() => sessionCookieSpecs(tokens({ accessToken: bad }), clock)).toThrow(
      new TypeError("cookie: value is not allowed"),
    );
    expect(() => sessionCookieSpecs(tokens({ refreshToken: bad }), clock)).toThrow(
      new TypeError("cookie: value is not allowed"),
    );
  });

  it("4000 characters pass, as they do for Set-Cookie", () => {
    const t = tokens({ accessToken: "a".repeat(4000) });
    expect(() => sessionCookieSpecs(t, clock)).not.toThrow();
    expect(() => sessionSetCookies(t, clock)).not.toThrow();
  });

  it("the thrown error does not carry the value", () => {
    const secret = "secret value;with a separator";
    try {
      sessionCookieSpecs(tokens({ accessToken: secret }), clock);
      throw new Error("expected a throw");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret");
    }
  });
});

describe("clearCookieSpecs", () => {
  it("has Max-Age 0 for both names and matches clearSessionSetCookies", () => {
    const specs = clearCookieSpecs();
    expect(specs.map((s) => [s.name, s.maxAge])).toEqual([
      [ACCESS_COOKIE, 0],
      [REFRESH_COOKIE, 0],
    ]);
    expect(specs.map(serialise)).toEqual(clearSessionSetCookies());
  });
});
