import { beforeAll, describe, expect, it, vi } from "vitest";
import { customerRepos, lookupCustomerBySub, withTx } from "@tc/db";
import {
  expectTenantIsolation,
  newCustomer,
  newResource,
  useBoundTestDatabase,
} from "@tc/db/testing";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../cookies";
import { authenticateCustomer, type SessionDeps } from "../session";
import { createAccessTokenVerifier } from "../tokens";
import { createTestIssuer, type TestIssuer } from "../testing/keys";

// web_rw: the role of the web function. The lookup is the real SQL.
const t = useBoundTestDatabase("web_rw");

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const nowSec = NOW.getTime() / 1000;

let issuer: TestIssuer;
let verifier: SessionDeps["verifier"];

beforeAll(() => {
  issuer = createTestIssuer({ now: () => NOW });
  verifier = createAccessTokenVerifier(issuer.pool, { jwksCache: issuer.jwksCache });
});

const lookupSpy = () => vi.fn((sub: string) => withTx((tx) => lookupCustomerBySub(tx, sub)));
const subOf = async (id: string): Promise<string> =>
  (
    await t.pool.query<{ cognito_sub: string }>("select cognito_sub from customers where id = $1", [
      id,
    ])
  ).rows[0]!.cognito_sub;
const header = (token: string) => `${ACCESS_COOKIE}=${token}`;

describe("authenticateCustomer on a real database", () => {
  it("end to end: a token of customer A gives A's session on a real database", async () => {
    const a = await newCustomer(t.pool, { kyc_status: "verified", locale: "en" });
    const lookup = lookupSpy();
    const out = await authenticateCustomer(
      { verifier, lookup },
      header(issuer.sign({ sub: await subOf(a) })),
    );
    if (!out.ok) throw new Error("expected a session");
    expect(out.session).toMatchObject({ customerId: a, kycStatus: "verified", locale: "en" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("cross-tenant: a token of customer A, with customer B's id in the claims, the cookie and the Origin of B, gives A's session and never B's", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const token = issuer.sign({
      sub: await subOf(a),
      "custom:customer_id": b,
      customerId: b,
      "cognito:username": b,
      username: await subOf(b),
    });
    const cookies =
      `customerId=${b}; customer_id=${b}; ${REFRESH_COOKIE}=${b}; ` +
      `${ACCESS_COOKIE}=${token}; x-customer-id=${b}`;
    const out = await authenticateCustomer({ verifier, lookup: lookupSpy() }, cookies);
    if (!out.ok) throw new Error("expected a session");
    expect(out.session.customerId).toBe(a);
    expect(out.session.customerId).not.toBe(b);
    // The Origin (and every other header) of B is not an input of the pipeline: it takes the
    // dependencies and the cookie header, nothing else.
    expect(authenticateCustomer.length).toBe(2);
  });

  it("customer B's rows are unreachable with A's session", async () => {
    await expectTenantIsolation({
      pool: t.pool,
      seed: async (pool, customerId) => ({ resourceId: await newResource(pool, customerId) }),
      cases: [
        {
          // The session comes from a real token of the acting customer; the only thing the caller
          // chooses is the id of the row, here the resource of the other customer.
          name: "session.resources.get",
          kind: "read",
          run: async (customerId, target) => {
            const out = await authenticateCustomer(
              { verifier, lookup: lookupSpy() },
              header(issuer.sign({ sub: await subOf(customerId) })),
            );
            if (!out.ok) throw new Error("expected a session");
            return withTx((tx) =>
              customerRepos(tx, out.session.customerId).resources.get(target.resourceId),
            );
          },
        },
      ],
    });
  });

  it("sign-out everywhere: setting sessions_valid_after makes the same token refused on the next request", async () => {
    const a = await newCustomer(t.pool);
    const cookie = header(issuer.sign({ sub: await subOf(a), iat: nowSec - 30 }));
    const deps = { verifier, lookup: lookupSpy() };
    expect((await authenticateCustomer(deps, cookie)).ok).toBe(true);
    await t.pool.query("update customers set sessions_valid_after = $2 where id = $1", [
      a,
      new Date(NOW.getTime() - 10_000),
    ]);
    expect(await authenticateCustomer(deps, cookie)).toEqual({
      ok: false,
      error: "unauthenticated",
      reason: "revoked",
    });
    // A token issued after the cut-off (a new sign-in) passes again.
    const again = header(issuer.sign({ sub: await subOf(a), iat: nowSec }));
    expect((await authenticateCustomer(deps, again)).ok).toBe(true);
  });

  it("a suspended customer in the database is forbidden", async () => {
    const a = await newCustomer(t.pool, { status: "suspended" });
    const out = await authenticateCustomer(
      { verifier, lookup: lookupSpy() },
      header(issuer.sign({ sub: await subOf(a) })),
    );
    expect(out).toEqual({ ok: false, error: "forbidden", reason: "suspended" });
  });

  it("an unknown subject in the database is unauthenticated", async () => {
    const out = await authenticateCustomer(
      { verifier, lookup: lookupSpy() },
      header(issuer.sign({ sub: "sub-nobody" })),
    );
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "unknown_subject" });
  });

  it("the pool of the admins is not accepted", async () => {
    const a = await newCustomer(t.pool);
    const adminIssuer = createTestIssuer(
      { now: () => NOW },
      { pool: { userPoolId: "ap-southeast-1_ADMINPOOL", clientId: "adminclient0123456789abcdef" } },
    );
    const lookup = lookupSpy();
    const out = await authenticateCustomer(
      { verifier, lookup },
      header(adminIssuer.sign({ sub: await subOf(a) })),
    );
    expect(out).toEqual({ ok: false, error: "unauthenticated", reason: "token_invalid" });
    expect(lookup).not.toHaveBeenCalled();
  });
});
