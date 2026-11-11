import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomerIdentity } from "@tc/db";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../cookies";
import { completeSignIn, type SignInDeps } from "../sign-in";
import { createAccessTokenVerifier } from "../tokens";
import { createTestIssuer, type TestIssuer } from "../testing/keys";

// A whole second, so the boundary of sessions_valid_after is exact.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const nowSec = NOW.getTime() / 1000;
const clock = { now: () => NOW };
const ID_A = "0191a000-0000-7000-8000-00000000000a";
const REFRESH = "r1.r2.r3.r4.r5";

let issuer: TestIssuer;
let verifier: SignInDeps["verifier"];

beforeAll(() => {
  issuer = createTestIssuer(clock);
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
});

const identity = (over: Partial<CustomerIdentity> = {}): CustomerIdentity => ({
  id: ID_A,
  status: "active",
  sessionsValidAfter: null,
  kycStatus: "none",
  riskTier: "new",
  locale: "bn",
  ...over,
});

function setup(found: CustomerIdentity | null = identity()) {
  const lookup = vi.fn<SignInDeps["lookup"]>(() => Promise.resolve(found));
  const onDenied = vi.fn();
  const deps: SignInDeps = {
    verifier,
    lookup,
    onDenied,
    clock,
    refreshMaxAgeSeconds: 2_592_000,
  };
  return { deps, lookup, onDenied };
}

const tokens = (accessToken: string, over: Record<string, unknown> = {}) => ({
  accessToken,
  refreshToken: REFRESH,
  expiresInSeconds: 3600,
  ...over,
});

describe("completeSignIn: a verified token", () => {
  it("gives the session of the row found by the sub, and two cookie specs", async () => {
    const { deps, lookup } = setup();
    const access = issuer.sign({ sub: "sub-1" });
    const out = await completeSignIn(deps, tokens(access));
    if (!out.ok) throw new Error("expected a sign-in");
    expect(out.session.customerId).toBe(ID_A);
    expect(Object.keys(out.session).sort()).toEqual([
      "customerId",
      "kycStatus",
      "locale",
      "riskTier",
      "signedInAt",
    ]);
    expect(lookup.mock.calls).toEqual([["sub-1"]]);
    expect(out.cookies).toEqual([
      {
        name: ACCESS_COOKIE,
        value: access,
        maxAge: 3600,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      },
      {
        name: REFRESH_COOKIE,
        value: REFRESH,
        maxAge: 2_592_000,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      },
    ]);
  });

  it("the customer id is the row's, whatever the token claims", async () => {
    const { deps } = setup();
    const out = await completeSignIn(
      deps,
      tokens(issuer.sign({ "custom:customer_id": "someone-else", username: "someone-else" })),
    );
    expect(out.ok && out.session.customerId).toBe(ID_A);
  });

  it("the access Max-Age follows expiresInSeconds", async () => {
    const { deps } = setup();
    const out = await completeSignIn(deps, tokens(issuer.sign(), { expiresInSeconds: 900 }));
    expect(out.ok && out.cookies[0]!.maxAge).toBe(900);
  });
});

describe("completeSignIn: no cookie unless the token verified against the customer row", () => {
  const denied = (reason: string, error: string) => ({ ok: false, error, reason });

  it.each([
    [
      "an unknown sub",
      () => setup(null),
      () => issuer.sign(),
      denied("unknown_subject", "unauthenticated"),
    ],
    [
      "a token issued before sessionsValidAfter",
      () => setup(identity({ sessionsValidAfter: new Date((nowSec + 10) * 1000) })),
      () => issuer.sign({ iat: nowSec }),
      denied("revoked", "unauthenticated"),
    ],
    [
      "a suspended customer",
      () => setup(identity({ status: "suspended" })),
      () => issuer.sign(),
      denied("suspended", "forbidden"),
    ],
    [
      "an expired token",
      () => setup(),
      () => issuer.sign({ iat: nowSec - 7200, exp: nowSec - 3600 }),
      denied("token_expired", "unauthenticated"),
    ],
    [
      "a token signed by another key",
      () => setup(),
      () => issuer.sign({}, { key: "other" }),
      denied("token_invalid", "unauthenticated"),
    ],
    [
      "a token of another issuer",
      () => setup(),
      () => issuer.sign({ iss: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Other" }),
      denied("token_invalid", "unauthenticated"),
    ],
  ])("%s", async (_name, make, token, expected) => {
    const { deps, onDenied } = make();
    const out = await completeSignIn(deps, tokens(token()));
    expect(out).toEqual(expected);
    expect("cookies" in out).toBe(false);
    expect(onDenied).toHaveBeenCalledTimes(1);
  });

  it("a lookup that throws is upstream_unavailable and sets nothing", async () => {
    const { deps } = setup();
    const failing: SignInDeps = {
      ...deps,
      lookup: () => Promise.reject(new Error("database says PLANTED-ROW")),
    };
    const out = await completeSignIn(failing, tokens(issuer.sign()));
    expect(out).toEqual({ ok: false, error: "upstream_unavailable", reason: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("PLANTED");
  });

  it("a denied result holds no token (planted value search)", async () => {
    const access = issuer.sign({}, { key: "other" });
    const { deps } = setup();
    const out = await completeSignIn(deps, tokens(access, { refreshToken: "planted.refresh.tok" }));
    const text = JSON.stringify(out);
    expect(text).not.toContain(access);
    expect(text).not.toContain("planted.refresh.tok");
    expect(Object.keys(out).sort()).toEqual(["error", "ok", "reason"]);
  });
});

describe("completeSignIn: tokens that cannot be cookies", () => {
  it.each([
    ["an access token with a separator", { accessToken: "a.b;c" }],
    ["an access token with a line break", { accessToken: "a.b\nc" }],
    ["an empty access token", { accessToken: "" }],
    ["a refresh token with a space", { refreshToken: "r1 r2" }],
    ["an empty refresh token", { refreshToken: "" }],
    ["a refresh token of 4001 characters", { refreshToken: "r".repeat(4001) }],
    ["a negative lifetime", { expiresInSeconds: -1 }],
    ["a lifetime that is not an integer", { expiresInSeconds: 1.5 }],
    ["a lifetime of NaN", { expiresInSeconds: Number.NaN }],
  ])("%s is refused without a lookup and without a cookie", async (_name, over) => {
    const { deps, lookup } = setup();
    const out = await completeSignIn(deps, { ...tokens(issuer.sign()), ...over });
    expect(out.ok).toBe(false);
    expect("cookies" in out).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never throws, whatever it is given", async () => {
    const { deps } = setup();
    for (const bad of [null, undefined, 5, {}, { accessToken: 5 }]) {
      const out = await completeSignIn(deps, bad as never);
      expect(out.ok).toBe(false);
    }
  });
});
