import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE,
  MAX_SET_COOKIE_BYTES,
  REFRESH_COOKIE,
  clearSessionSetCookies,
  parseCookieHeader,
  serializeSetCookie,
  sessionSetCookies,
  withSessionCookies,
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

// The attributes the proof of 6.1 names, each as a whole attribute (case-sensitive as written).
const ATTRIBUTES = [/; Secure(;|$)/, /; HttpOnly(;|$)/, /; SameSite=Lax(;|$)/, /; Path=\/(;|$)/];

function all(): string[] {
  return [...sessionSetCookies(tokens(), clock, 100), ...clearSessionSetCookies()];
}

describe("Set-Cookie building", () => {
  it("a session cookie is HttpOnly, Secure and SameSite=Lax", () => {
    const cookies = all();
    expect(cookies).toHaveLength(4);
    for (const c of cookies) {
      for (const re of ATTRIBUTES.slice(0, 3)) expect(c).toMatch(re);
      expect(c).not.toMatch(/samesite=(none|strict)/i);
    }
  });

  it("the cookies have Path=/ and no Domain attribute", () => {
    for (const c of all()) {
      expect(c).toMatch(ATTRIBUTES[3]!);
      expect(c).not.toMatch(/domain/i);
    }
  });

  it("the names carry the __Host- prefix", () => {
    expect(ACCESS_COOKIE).toBe("__Host-tc_at");
    expect(REFRESH_COOKIE).toBe("__Host-tc_rt");
    const [a, r] = sessionSetCookies(tokens(), clock, 100);
    expect(a!.startsWith("__Host-tc_at=aaa.bbb.ccc;")).toBe(true);
    expect(r!.startsWith("__Host-tc_rt=r1.r2.r3.r4.r5;")).toBe(true);
  });

  it("Max-Age of the access cookie is the remaining life of the token", () => {
    const [a, r] = sessionSetCookies(tokens(), clock, 2_592_000);
    expect(a).toContain("; Max-Age=3600;");
    expect(r).toContain("; Max-Age=2592000;");
  });

  it("Max-Age of an already expired token is 0, never negative", () => {
    const [a] = sessionSetCookies(
      tokens({ accessExpiresAt: new Date(NOW.getTime() - 5000) }),
      clock,
    );
    expect(a).toContain("; Max-Age=0;");
    expect(a).not.toContain("Max-Age=-");
  });

  it("the refresh cookie is written only when a refresh token is given", () => {
    const cookies = sessionSetCookies(
      { accessToken: "aaa.bbb.ccc", accessExpiresAt: new Date(NOW.getTime() + 3600_000) },
      clock,
    );
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.startsWith("__Host-tc_at=")).toBe(true);
  });

  it("a cleared cookie has Max-Age=0 and the Expires of the epoch", () => {
    const cleared = clearSessionSetCookies();
    expect(cleared).toHaveLength(2);
    expect(cleared[0]!.startsWith("__Host-tc_at=")).toBe(true);
    expect(cleared[1]!.startsWith("__Host-tc_rt=")).toBe(true);
    for (const c of cleared) {
      expect(c).toContain("; Max-Age=0;");
      expect(c).toContain("; Expires=Thu, 01 Jan 1970 00:00:00 GMT;");
    }
  });
});

describe("serializeSetCookie refusals", () => {
  const SECRET = "abc.def.ghi";

  it.each([
    ["a semicolon", `${SECRET};x`],
    ["a comma", `${SECRET},x`],
    ["a space", `${SECRET} x`],
    ["CR", `${SECRET}\rx`],
    ["LF", `${SECRET}\nx`],
    ["an equals sign", `${SECRET}=x`],
  ])("serializeSetCookie refuses a value with %s", (_n, value) => {
    expect(() => serializeSetCookie(ACCESS_COOKIE, value, { maxAgeSeconds: 10 })).toThrow(
      TypeError,
    );
  });

  it("serializeSetCookie refuses an empty value, a value over 4000 characters, a name outside the two constants, a fractional or negative Max-Age", () => {
    const ok = { maxAgeSeconds: 10 };
    expect(() => serializeSetCookie(ACCESS_COOKIE, "", ok)).toThrow(TypeError);
    expect(() => serializeSetCookie(ACCESS_COOKIE, "a".repeat(4001), ok)).toThrow(TypeError);
    expect(() => serializeSetCookie(ACCESS_COOKIE, "a".repeat(4000), ok)).not.toThrow();
    expect(() => serializeSetCookie("session" as never, "abc", ok)).toThrow(TypeError);
    expect(() => serializeSetCookie(ACCESS_COOKIE, "abc", { maxAgeSeconds: 1.5 })).toThrow(
      TypeError,
    );
    expect(() => serializeSetCookie(ACCESS_COOKIE, "abc", { maxAgeSeconds: -1 })).toThrow(
      TypeError,
    );
    expect(() => serializeSetCookie(ACCESS_COOKIE, "abc", { maxAgeSeconds: Number.NaN })).toThrow(
      TypeError,
    );
    expect(() =>
      serializeSetCookie(ACCESS_COOKIE, "abc", { maxAgeSeconds: Number.POSITIVE_INFINITY }),
    ).toThrow(TypeError);
  });

  it("the error text of a refused value does not contain the value", () => {
    for (const value of [`${SECRET};x`, `${SECRET} y`, `${SECRET}=z`, SECRET.repeat(1000)]) {
      let message = "";
      try {
        serializeSetCookie(ACCESS_COOKIE, value, { maxAgeSeconds: 1 });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(SECRET);
    }
  });

  it("a Set-Cookie over 4096 bytes is refused", () => {
    expect(MAX_SET_COOKIE_BYTES).toBe(4096);
    // With Max-Age=0 the Expires attribute is added and 4000 characters no longer fit.
    expect(() =>
      serializeSetCookie(REFRESH_COOKIE, "a".repeat(4000), { maxAgeSeconds: 0 }),
    ).toThrow(TypeError);
    // A live cookie with the same value fits.
    const live = serializeSetCookie(REFRESH_COOKIE, "a".repeat(4000), {
      maxAgeSeconds: Number.MAX_SAFE_INTEGER,
    });
    expect(Buffer.byteLength(live)).toBeLessThanOrEqual(MAX_SET_COOKIE_BYTES);
  });
});

describe("parseCookieHeader", () => {
  it("parseCookieHeader reads both cookies among others", () => {
    const m = parseCookieHeader(
      "theme=dark; __Host-tc_at=aaa.bbb.ccc; lang=bn; __Host-tc_rt=r1.r2",
    );
    expect(m.get(ACCESS_COOKIE)).toBe("aaa.bbb.ccc");
    expect(m.get(REFRESH_COOKIE)).toBe("r1.r2");
    expect(m.get("theme")).toBe("dark");
    expect(m.get("lang")).toBe("bn");
  });

  it("parseCookieHeader keeps the first of a duplicated name", () => {
    const m = parseCookieHeader("__Host-tc_at=first; x=1; __Host-tc_at=second");
    expect(m.get(ACCESS_COOKIE)).toBe("first");
    expect(m.size).toBe(2);
  });

  it.each([
    null,
    undefined,
    "",
    "==",
    "a",
    ";;;",
    "=v",
    " = ",
    "a b=c",
    "a\u0000b=c",
    "x".repeat(100_000),
  ])("parseCookieHeader skips malformed pairs and never throws (%#)", (header) => {
    let m: ReadonlyMap<string, string> | undefined;
    expect(() => {
      m = parseCookieHeader(header as string | null | undefined);
    }).not.toThrow();
    expect(m!.size).toBe(0);
  });

  it("parseCookieHeader skips a bad pair and keeps the good ones next to it", () => {
    const m = parseCookieHeader("junk; ==; ok=1; =x; fine=2");
    expect([...m.entries()]).toEqual([
      ["ok", "1"],
      ["fine", "2"],
    ]);
  });

  it("parseCookieHeader does not decode percent signs", () => {
    const m = parseCookieHeader("a=%41%3B; __Host-tc_at=ab%2Fcd");
    expect(m.get("a")).toBe("%41%3B");
    expect(m.get(ACCESS_COOKIE)).toBe("ab%2Fcd");
  });
});

describe("withSessionCookies", () => {
  it("withSessionCookies replaces the access token, keeps other cookies, and adds the refresh token only when given", () => {
    const before = "theme=dark; __Host-tc_at=old.old.old; __Host-tc_rt=oldrefresh; lang=bn";

    const noRefresh = withSessionCookies(before, {
      accessToken: "new.new.new",
      accessExpiresAt: NOW,
    });
    const m1 = parseCookieHeader(noRefresh);
    expect(m1.get(ACCESS_COOKIE)).toBe("new.new.new");
    expect(m1.get(REFRESH_COOKIE)).toBe("oldrefresh");
    expect(m1.get("theme")).toBe("dark");
    expect(m1.get("lang")).toBe("bn");
    expect(noRefresh.match(/__Host-tc_at=/g)).toHaveLength(1);

    const rotated = withSessionCookies(before, {
      accessToken: "new.new.new",
      refreshToken: "rot.rot",
      accessExpiresAt: NOW,
    });
    const m2 = parseCookieHeader(rotated);
    expect(m2.get(REFRESH_COOKIE)).toBe("rot.rot");
    expect(rotated.match(/__Host-tc_rt=/g)).toHaveLength(1);

    for (const empty of [null, undefined, ""]) {
      const m = parseCookieHeader(
        withSessionCookies(empty, { accessToken: "n.n.n", accessExpiresAt: NOW }),
      );
      expect(m.get(ACCESS_COOKIE)).toBe("n.n.n");
      expect(m.size).toBe(1);
    }
  });

  it("withSessionCookies drops a duplicated old cookie and refuses a bad token without echoing it", () => {
    const out = withSessionCookies("__Host-tc_at=a1; __Host-tc_at=a2; z=9", {
      accessToken: "n.n.n",
      accessExpiresAt: NOW,
    });
    expect(out.match(/__Host-tc_at=/g)).toHaveLength(1);
    expect(parseCookieHeader(out).get("z")).toBe("9");
    let message = "";
    try {
      withSessionCookies("", { accessToken: "bad token;x", accessExpiresAt: NOW });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("bad token");
  });
});
