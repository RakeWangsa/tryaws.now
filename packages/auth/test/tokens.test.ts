import https from "node:https";
import { FetchError, NonRetryableFetchError } from "aws-jwt-verify/error";
import type { JwksCache } from "aws-jwt-verify/jwk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccessTokenVerifier, type AccessTokenVerifier, type TokenOutcome } from "../tokens";
import { createTestIssuer, type TestIssuer } from "../testing/keys";

let issuer: TestIssuer;
let verifier: AccessTokenVerifier;

beforeAll(() => {
  issuer = createTestIssuer();
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const nowSec = () => Math.floor(Date.now() / 1000);

function failure(o: TokenOutcome) {
  if (o.ok) throw new Error("expected a failure");
  return o;
}

// Replaces one character of a base64url segment by another one of the alphabet.
function flip(segment: string, at: number): string {
  const c = segment[at]!;
  return segment.slice(0, at) + (c === "A" ? "B" : "A") + segment.slice(at + 1);
}

function parts(jwt: string): [string, string, string] {
  const p = jwt.split(".");
  return [p[0]!, p[1]!, p[2]!];
}

describe("access token verification", () => {
  it("a valid access token is accepted and its claims are returned", async () => {
    const iat = nowSec() - 30;
    const jwt = issuer.sign({ sub: "sub-123", iat, auth_time: iat - 60, exp: nowSec() + 3600 });
    const out = await verifier.verify(jwt);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.token.sub).toBe("sub-123");
    expect(out.token.issuedAt).toEqual(new Date(iat * 1000));
    expect(out.token.authTime).toEqual(new Date((iat - 60) * 1000));
    expect(out.token.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a token with one changed character in the payload is rejected", async () => {
    const [h, p, s] = parts(issuer.sign({ sub: "customer-a" }));
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims["sub"] = "customer-b";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    expect(failure(await verifier.verify(forged))).toMatchObject({
      error: "unauthenticated",
      reason: "token_invalid",
    });
  });

  it("a token with one changed character in the signature is rejected", async () => {
    const [h, p, s] = parts(issuer.sign());
    // a character in the middle: the last base64url character of a 256-byte signature carries padding bits
    const out = failure(await verifier.verify(`${h}.${p}.${flip(s, 100)}`));
    expect(out).toMatchObject({ error: "unauthenticated", reason: "token_invalid" });
  });

  it("a token signed by another key with the same kid is rejected", async () => {
    const jwt = issuer.sign({}, { key: "other" });
    expect(failure(await verifier.verify(jwt))).toMatchObject({
      error: "unauthenticated",
      reason: "token_invalid",
    });
  });

  it("a token with an unknown kid is rejected without a network call", async () => {
    const request = vi.spyOn(https, "request");
    const get = vi.spyOn(https, "get");
    const getJwk = vi.spyOn(issuer.jwksCache, "getJwk");
    const jwt = issuer.sign({}, { kid: "some-other-kid" });
    expect(failure(await verifier.verify(jwt))).toMatchObject({
      error: "unauthenticated",
      reason: "token_invalid",
    });
    expect(getJwk).toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("a token with alg none is rejected", async () => {
    const jwt = issuer.sign({}, { alg: "none" });
    expect(jwt.endsWith(".")).toBe(true);
    expect(failure(await verifier.verify(jwt))).toMatchObject({
      error: "unauthenticated",
      reason: "token_invalid",
    });
  });

  it("a token with alg HS256 signed with the public key text is rejected", async () => {
    const jwt = issuer.sign({}, { alg: "HS256" });
    expect(failure(await verifier.verify(jwt))).toMatchObject({
      error: "unauthenticated",
      reason: "token_invalid",
    });
  });

  it("an expired token is rejected as token_expired", async () => {
    const jwt = issuer.sign({
      iat: nowSec() - 7200,
      auth_time: nowSec() - 7200,
      exp: nowSec() - 3600,
    });
    expect(failure(await verifier.verify(jwt))).toMatchObject({
      error: "unauthenticated",
      reason: "token_expired",
    });
  });

  it("a token that expires in the future is accepted until its exp", async () => {
    const out = await verifier.verify(issuer.sign({ exp: nowSec() + 2 }));
    expect(out.ok).toBe(true);
  });

  it("a token of another issuer is rejected", async () => {
    const other = issuer.issuer.replace("TESTPOOL1", "OTHERPOOL2");
    const admin = "https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_ADMINPOOL";
    for (const iss of [other, admin, "https://evil.example.com/ap-southeast-1_TESTPOOL1"]) {
      expect(failure(await verifier.verify(issuer.sign({ iss })))).toMatchObject({
        error: "unauthenticated",
        reason: "token_invalid",
      });
    }
  });

  it("a token for another client_id is rejected", async () => {
    expect(
      failure(await verifier.verify(issuer.sign({ client_id: "someotherclient0123456789" }))),
    ).toMatchObject({
      error: "unauthenticated",
      reason: "token_invalid",
    });
  });

  it("an ID token is rejected where an access token is required", async () => {
    const jwt = issuer.sign({ token_use: "id", aud: issuer.pool.clientId });
    expect(failure(await verifier.verify(jwt))).toMatchObject({
      error: "unauthenticated",
      reason: "token_invalid",
    });
  });

  it.each(["sub", "iat", "exp", "auth_time"] as const)(
    "a token without %s is rejected",
    async (claim) => {
      const jwt = issuer.sign({ [claim]: undefined });
      expect(failure(await verifier.verify(jwt))).toMatchObject({
        error: "unauthenticated",
        reason: "token_invalid",
      });
    },
  );

  it("a token with a claim of the wrong type is rejected", async () => {
    for (const bad of [
      { sub: 5 },
      { sub: "" },
      { iat: "1" },
      { auth_time: "now" },
      { exp: null },
    ]) {
      const out = await verifier.verify(issuer.sign(bad as never));
      expect(failure(out).reason).toBe("token_invalid");
    }
  });

  it.each([
    ["undefined", undefined],
    ["an empty string", ""],
    ["a non-JWT", "not-a-jwt"],
    ["an oversized string", "a".repeat(8193)],
    ["a string with three empty parts", ".."],
    ["a string with two parts", "aaa.bbb"],
    ["a string with four parts", "a.b.c.d"],
  ])("rejects %s without throwing", async (_name, input) => {
    const out = await verifier.verify(input);
    expect(failure(out)).toMatchObject({ error: "unauthenticated", reason: "token_invalid" });
  });

  it("an oversized string does not reach the library", async () => {
    const getJwk = vi.spyOn(issuer.jwksCache, "getJwk");
    await verifier.verify("a".repeat(8193));
    await verifier.verify("");
    await verifier.verify(undefined);
    expect(getJwk).not.toHaveBeenCalled();
  });

  it("a JWKS that cannot be fetched is upstream_unavailable and not a session", async () => {
    for (const error of [
      new NonRetryableFetchError("https://x", "no"),
      new FetchError("https://x", "no"),
    ]) {
      const down = createAccessTokenVerifier(issuer.pool, {
        jwksCache: throwingCache(issuer.jwksCache, error),
      });
      expect(failure(await down.verify(issuer.sign()))).toEqual({
        ok: false,
        error: "upstream_unavailable",
        reason: "unavailable",
      });
    }
  });

  it("any unexpected error from the library is token_invalid", async () => {
    for (const thrown of [new TypeError("boom"), "a string", 42, undefined, { message: "x" }]) {
      const odd = createAccessTokenVerifier(issuer.pool, {
        jwksCache: throwingCache(issuer.jwksCache, thrown),
      });
      expect(failure(await odd.verify(issuer.sign()))).toEqual({
        ok: false,
        error: "unauthenticated",
        reason: "token_invalid",
      });
    }
  });

  it("the outcome never contains the token or the library message", async () => {
    const good = issuer.sign();
    const [h, p, s] = parts(good);
    const cases: string[] = [
      good.slice(0, -4),
      `${h}.${p}.${flip(s, 100)}`,
      issuer.sign({}, { key: "other" }),
      issuer.sign({ exp: nowSec() - 3600 }),
      issuer.sign({ client_id: "someotherclient0123456789" }),
      issuer.sign({ iss: "https://evil.example.com/x" }),
      issuer.sign({ sub: undefined }),
      issuer.sign({}, { kid: "nope" }),
      "not-a-jwt",
    ];
    const unreachable = createAccessTokenVerifier(issuer.pool, {
      jwksCache: throwingCache(
        issuer.jwksCache,
        new NonRetryableFetchError("https://secret.example/x", "secret-detail"),
      ),
    });
    const outcomes = [
      ...(await Promise.all(cases.map((t) => verifier.verify(t)))),
      await unreachable.verify(issuer.sign()),
    ];
    for (const [i, outcome] of outcomes.entries()) {
      const text = JSON.stringify(failure(outcome));
      const token = cases[i] ?? issuer.sign();
      expect(text).not.toContain(token.slice(0, 20));
      expect(text).not.toContain(token.slice(-20));
      expect(text).not.toContain("secret");
      expect(Object.keys(outcome).sort()).toEqual(["error", "ok", "reason"]);
    }
  });
});

// A cache that behaves like the issuer's but throws a chosen value when a key is asked for.
function throwingCache(base: JwksCache, thrown: unknown): JwksCache {
  return {
    getJwk: () => Promise.reject(thrown),
    getCachedJwk: () => {
      throw thrown;
    },
    addJwks: (u, j) => base.addJwks(u, j),
    getJwks: (u) => base.getJwks(u),
  };
}
