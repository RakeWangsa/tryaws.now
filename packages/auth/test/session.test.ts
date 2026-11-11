import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomerIdentity } from "@tc/db";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../cookies";
import { authenticateCustomer, type SessionDeps } from "../session";
import { createAccessTokenVerifier } from "../tokens";
import { createTestIssuer, type TestIssuer } from "../testing/keys";

// A whole second, so the boundary of sessions_valid_after is exact (iat is whole seconds).
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const nowSec = NOW.getTime() / 1000;
const clock = { now: () => NOW };

let issuer: TestIssuer;
let verifier: SessionDeps["verifier"];

beforeAll(() => {
  issuer = createTestIssuer(clock);
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
});

const ID_A = "0191a000-0000-7000-8000-00000000000a";
const ID_B = "0191a000-0000-7000-8000-00000000000b";

function identity(over: Partial<CustomerIdentity> = {}): CustomerIdentity {
  return {
    id: ID_A,
    status: "active",
    sessionsValidAfter: null,
    kycStatus: "verified",
    riskTier: "trusted",
    locale: "en",
    ...over,
  };
}

function setup(found: CustomerIdentity | null = identity(), onDenied?: SessionDeps["onDenied"]) {
  const lookup = vi.fn<SessionDeps["lookup"]>(() => Promise.resolve(found));
  const deps: SessionDeps = { verifier, lookup, ...(onDenied ? { onDenied } : {}) };
  return { lookup, deps };
}

const header = (token: string) => `theme=dark; ${ACCESS_COOKIE}=${token}`;

describe("authenticateCustomer: the session", () => {
  it("a valid token of an active customer gives a session with the five fields and nothing else", async () => {
    const { deps } = setup();
    const out = await authenticateCustomer(deps, header(issuer.sign()));
    if (!out.ok) throw new Error("expected a session");
    expect(Object.keys(out.session).sort()).toEqual([
      "customerId",
      "kycStatus",
      "locale",
      "riskTier",
      "signedInAt",
    ]);
    expect(out.session).toMatchObject({
      customerId: ID_A,
      kycStatus: "verified",
      riskTier: "trusted",
      locale: "en",
    });
  });

  it("signedInAt is the auth_time of the token, not its iat and not the clock", async () => {
    const { deps } = setup();
    const authTime = nowSec - 1234;
    const out = await authenticateCustomer(
      deps,
      header(issuer.sign({ auth_time: authTime, iat: nowSec - 10 })),
    );
    if (!out.ok) throw new Error("expected a session");
    expect(out.session.signedInAt).toEqual(new Date(authTime * 1000));
  });

  it("the lookup is called with the verified sub, once", async () => {
    const { deps, lookup } = setup();
    await authenticateCustomer(deps, header(issuer.sign({ sub: "sub-verified-1" })));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]).toEqual(["sub-verified-1"]);
  });

  it("claims other than sub cannot choose the customer", async () => {
    const { deps, lookup } = setup(identity({ id: ID_A }));
    const token = issuer.sign({
      sub: "sub-of-a",
      "custom:customer_id": ID_B,
      customerId: ID_B,
      "cognito:username": ID_B,
      username: ID_B,
    });
    const out = await authenticateCustomer(deps, header(token));
    if (!out.ok) throw new Error("expected a session");
    expect(out.session.customerId).toBe(ID_A);
    expect(lookup.mock.calls).toEqual([["sub-of-a"]]);
  });
});

describe("authenticateCustomer: no session", () => {
  it("no cookie header is unauthenticated", async () => {
    const { deps, lookup } = setup();
    for (const h of [null, undefined, ""]) {
      expect(await authenticateCustomer(deps, h)).toEqual({
        ok: false,
        error: "unauthenticated",
        reason: "no_cookie",
      });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a cookie header without the access cookie is unauthenticated", async () => {
    const { deps } = setup();
    expect(await authenticateCustomer(deps, "theme=dark; other=1")).toEqual({
      ok: false,
      error: "unauthenticated",
      reason: "no_cookie",
    });
  });

  it("the refresh cookie alone is no session", async () => {
    const { deps, lookup } = setup();
    const out = await authenticateCustomer(deps, `${REFRESH_COOKIE}=${issuer.sign()}`);
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "no_cookie" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a tampered token never reaches the lookup", async () => {
    const { deps, lookup } = setup();
    const [h, p, s] = issuer.sign().split(".");
    const tampered = `${h}.${p}.${s!.slice(0, -4)}AAAA`;
    const out = await authenticateCustomer(deps, header(tampered));
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "token_invalid" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("an expired token never reaches the lookup", async () => {
    const { deps, lookup } = setup();
    const out = await authenticateCustomer(
      deps,
      header(issuer.sign({ iat: nowSec - 7200, exp: nowSec - 3600 })),
    );
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "token_expired" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("an unknown subject is unauthenticated", async () => {
    const { deps, lookup } = setup(null);
    const out = await authenticateCustomer(deps, header(issuer.sign()));
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "unknown_subject" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("a lookup that throws is upstream_unavailable and gives no session", async () => {
    const lookup = vi.fn<SessionDeps["lookup"]>(() => {
      throw new Error("connection refused: postgres://user:secret@host");
    });
    const out = await authenticateCustomer({ verifier, lookup }, header(issuer.sign()));
    expect(out).toEqual({ ok: false, error: "upstream_unavailable", reason: "unavailable" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("a lookup that rejects is upstream_unavailable and gives no session", async () => {
    const lookup = vi.fn<SessionDeps["lookup"]>(() => Promise.reject(new Error("boom")));
    const out = await authenticateCustomer({ verifier, lookup }, header(issuer.sign()));
    expect(out).toEqual({ ok: false, error: "upstream_unavailable", reason: "unavailable" });
  });

  it("a verifier that throws is no session, not a crash", async () => {
    const throwing = {
      verify: (): never => {
        throw new TypeError("unexpected");
      },
    };
    const lookup = vi.fn();
    const out = await authenticateCustomer({ verifier: throwing, lookup }, header(issuer.sign()));
    expect(out).toEqual({ ok: false, error: "upstream_unavailable", reason: "unavailable" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("authenticateCustomer: sessions_valid_after and status", () => {
  it("a token issued before sessions_valid_after is revoked", async () => {
    const { deps } = setup(identity({ sessionsValidAfter: new Date(NOW.getTime() + 5000) }));
    const out = await authenticateCustomer(deps, header(issuer.sign({ iat: nowSec })));
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "revoked" });
  });

  it("a token issued exactly at sessions_valid_after is accepted", async () => {
    const { deps } = setup(identity({ sessionsValidAfter: NOW }));
    const out = await authenticateCustomer(deps, header(issuer.sign({ iat: nowSec })));
    expect(out.ok).toBe(true);
  });

  it("a token issued one millisecond before sessions_valid_after is refused", async () => {
    const { deps } = setup(identity({ sessionsValidAfter: new Date(NOW.getTime() + 1) }));
    const out = await authenticateCustomer(deps, header(issuer.sign({ iat: nowSec })));
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "revoked" });
  });

  it("a null sessions_valid_after means no cut-off", async () => {
    const { deps } = setup(identity({ sessionsValidAfter: null }));
    const out = await authenticateCustomer(deps, header(issuer.sign({ iat: nowSec - 3000 })));
    expect(out.ok).toBe(true);
  });

  it("a sessions_valid_after that is not a valid time revokes (fail closed)", async () => {
    const { deps } = setup(identity({ sessionsValidAfter: new Date(Number.NaN) }));
    const out = await authenticateCustomer(deps, header(issuer.sign()));
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "revoked" });
  });

  it("a suspended customer is forbidden, also with a fresh token", async () => {
    const { deps } = setup(identity({ status: "suspended" }));
    const out = await authenticateCustomer(deps, header(issuer.sign({ auth_time: nowSec })));
    expect(out).toEqual({ ok: false, error: "forbidden", reason: "suspended" });
  });

  it("a revoked token of a suspended customer is unauthenticated", async () => {
    const { deps } = setup(
      identity({ status: "suspended", sessionsValidAfter: new Date(NOW.getTime() + 5000) }),
    );
    const out = await authenticateCustomer(deps, header(issuer.sign({ iat: nowSec })));
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "revoked" });
  });
});

describe("authenticateCustomer: the onDenied hook", () => {
  it("the hook receives only the reason", async () => {
    const seen: unknown[][] = [];
    const { deps } = setup(null, (...args: unknown[]) => void seen.push(args));
    await authenticateCustomer(deps, header(issuer.sign()));
    expect(seen).toEqual([["unknown_subject"]]);
  });

  it("the hook is not called for a session", async () => {
    const hook = vi.fn();
    const { deps } = setup(identity(), hook);
    await authenticateCustomer(deps, header(issuer.sign()));
    expect(hook).not.toHaveBeenCalled();
  });

  it("a hook that throws does not change the outcome", async () => {
    const hook: NonNullable<SessionDeps["onDenied"]> = () => {
      throw new Error("hook failed");
    };
    const { deps } = setup(null, hook);
    expect(await authenticateCustomer(deps, header(issuer.sign()))).toEqual({
      ok: false,
      error: "unauthenticated",
      reason: "unknown_subject",
    });
    const ok = setup(identity(), hook);
    expect((await authenticateCustomer(ok.deps, header(issuer.sign()))).ok).toBe(true);
  });
});
