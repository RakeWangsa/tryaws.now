import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomerIdentity } from "@tc/db";
import { authConfigFromEnv, type AuthConfig } from "../config";
import { ACCESS_COOKIE } from "../cookies";
import {
  configureAuth,
  currentCustomer,
  requireCustomer,
  resetAuthForTests,
  type AuthRuntime,
} from "../require";
import type { SessionDeps } from "../session";
import { createAccessTokenVerifier } from "../tokens";
import { createTestIssuer, type TestIssuer } from "../testing/keys";
import { AuthError } from "../types";

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const clock = { now: () => NOW };

let issuer: TestIssuer;
let config: AuthConfig;
let verifier: ReturnType<typeof createAccessTokenVerifier>;

beforeAll(() => {
  issuer = createTestIssuer(clock);
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
  config = authConfigFromEnv({
    COGNITO_CUSTOMER_POOL_ID: issuer.pool.userPoolId,
    COGNITO_CUSTOMER_CLIENT_ID: issuer.pool.clientId,
  });
});

afterEach(() => resetAuthForTests());

const identity = (over: Partial<CustomerIdentity> = {}): CustomerIdentity => ({
  id: "0191a000-0000-7000-8000-00000000000a",
  status: "active",
  sessionsValidAfter: null,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  ...over,
});

function configure(
  token: string | null,
  found: CustomerIdentity | null = identity(),
  extra: Partial<AuthRuntime> = {},
) {
  const readCookieHeader = vi.fn(() =>
    Promise.resolve(token === null ? null : `${ACCESS_COOKIE}=${token}`),
  );
  const lookup = vi.fn<SessionDeps["lookup"]>(() => Promise.resolve(found));
  configureAuth({ config, readCookieHeader, deps: { verifier, lookup }, clock, ...extra });
  return { readCookieHeader, lookup };
}

async function failure(p: Promise<unknown>): Promise<AuthError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("requireCustomer", () => {
  it("rejects with AuthError not_configured before configureAuth", async () => {
    const e = await failure(requireCustomer());
    expect([e.code, e.reason]).toEqual(["unauthenticated", "not_configured"]);
    expect(await currentCustomer()).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("returns the session when the cookies are valid", async () => {
    configure(issuer.sign());
    const s = await requireCustomer();
    expect(s).toMatchObject({ customerId: identity().id, kycStatus: "verified", locale: "bn" });
    const r = await currentCustomer();
    expect(r).toEqual({ ok: true, value: s });
  });

  it("rejects with unauthenticated for a tampered token", async () => {
    const [h, p, s] = issuer.sign().split(".");
    const { lookup } = configure(`${h}.${p}.${s!.slice(0, -4)}AAAA`);
    const e = await failure(requireCustomer());
    expect([e.code, e.reason]).toEqual(["unauthenticated", "token_invalid"]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects with forbidden for a suspended customer", async () => {
    configure(issuer.sign(), identity({ status: "suspended" }));
    const e = await failure(requireCustomer());
    expect([e.code, e.reason]).toEqual(["forbidden", "suspended"]);
  });

  it("rejects with upstream_unavailable when the lookup throws", async () => {
    configureAuth({
      config,
      readCookieHeader: () => Promise.resolve(`${ACCESS_COOKIE}=${issuer.sign()}`),
      deps: {
        verifier,
        lookup: () => Promise.reject(new Error("db down")),
      },
    });
    const e = await failure(requireCustomer());
    expect([e.code, e.reason]).toEqual(["upstream_unavailable", "unavailable"]);
    expect(e.message).toBe("auth: upstream_unavailable");
  });

  it("takes no parameter", async () => {
    expect(requireCustomer.length).toBe(0);
    const { lookup } = configure(issuer.sign(), identity());
    // @ts-expect-error nothing a caller passes may change whose session it is (R8)
    const s = await requireCustomer(identity({ id: "someone-else" }));
    expect(s.customerId).toBe(identity().id);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("currentCustomer maps every AuthError to a Result and never throws", async () => {
    configure(null);
    expect(await currentCustomer()).toEqual({ ok: false, error: "unauthenticated" });
    configure(issuer.sign(), identity({ status: "suspended" }));
    expect(await currentCustomer()).toEqual({ ok: false, error: "forbidden" });
    configure(issuer.sign(), null, {
      deps: { verifier, lookup: () => Promise.reject(new Error("x")) },
    });
    expect(await currentCustomer()).toEqual({ ok: false, error: "upstream_unavailable" });
  });

  it("the cookie reader is called once per call", async () => {
    const { readCookieHeader } = configure(issuer.sign());
    await requireCustomer();
    expect(readCookieHeader).toHaveBeenCalledTimes(1);
    await currentCustomer();
    expect(readCookieHeader).toHaveBeenCalledTimes(2);
  });

  it("a reader that throws is unauthenticated, not a crash", async () => {
    configureAuth({
      config,
      readCookieHeader: () => {
        throw new Error("cookies() called outside a request scope");
      },
      deps: { verifier, lookup: () => Promise.resolve(identity()) },
    });
    const e = await failure(requireCustomer());
    expect(e.code).toBe("unauthenticated");
    expect(await currentCustomer()).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("configureAuth again replaces the runtime and onDenied sees the reason", async () => {
    configure(issuer.sign(), null);
    const onDenied = vi.fn();
    configure(issuer.sign(), null, {
      deps: { verifier, lookup: () => Promise.resolve(null), onDenied },
    });
    await failure(requireCustomer());
    expect(onDenied).toHaveBeenCalledWith("unknown_subject");
  });
});
