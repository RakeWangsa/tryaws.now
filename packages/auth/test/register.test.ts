import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@tc/db";
import type { Tx } from "@tc/db";
import { ensureMarket, runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import type { IdentityProvider, IdpResult, SignUpOutcome } from "../identity";
import { registerAccount, type RegisterDeps } from "../register";

// registerCustomer is replaced by a spy that calls the real one, so a test can see its arguments and
// make it fail once.
const spy = vi.hoisted(() => ({ failNext: false }));
vi.mock("@tc/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tc/db")>();
  return {
    ...actual,
    registerCustomer: vi.fn(async (...args: Parameters<typeof actual.registerCustomer>) => {
      if (spy.failNext) {
        spy.failNext = false;
        throw new Error("injected failure of registerCustomer");
      }
      return actual.registerCustomer(...args);
    }),
  };
});

const t = useTempDatabase();
const PASSWORD = "Xk9#mQ2$vL7p-PLANTED";

function fakeIdp(answer: () => IdpResult<SignUpOutcome>) {
  const signUp = vi.fn<IdentityProvider["signUp"]>(async () => answer());
  const idp = { signUp } as unknown as IdentityProvider;
  return { idp, signUp };
}

const deps = (idp: IdentityProvider): RegisterDeps => ({
  idp,
  run: (fn: (tx: Tx) => Promise<unknown>) => runTransaction(t.db, fn, { role: "web_rw" }) as never,
});

const input = (over: Record<string, unknown> = {}) => ({
  email: "rahim." + uniqueSuffix() + "@example.test",
  phone: "+8801712345678",
  name: "Rahim Uddin",
  market: "BD",
  locale: "bn" as const,
  acceptances: [
    { document: "terms" as const, version: "2026-11-draft" },
    { document: "acceptable_use" as const, version: "2026-11-draft" },
    { document: "privacy" as const, version: "2026-11-draft" },
  ],
  ip: "203.0.113.7",
  password: PASSWORD,
  ...over,
});

const count = async (table: string): Promise<number> =>
  Number((await t.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const customers = () => count("customers");
const created = (sub = "sub-" + uniqueSuffix()): IdpResult<SignUpOutcome> => ({
  ok: true,
  value: { kind: "created", sub },
});

beforeEach(async () => {
  await ensureMarket(t.pool);
  await t.pool.query("update markets set active = true where code = 'BD'");
  vi.mocked(db.registerCustomer).mockClear();
});

describe("registerAccount", () => {
  it("created: writes the customer once and returns created", async () => {
    const { idp, signUp } = fakeIdp(() => created("sub-created-1"));
    const before = await customers();
    expect(await registerAccount(deps(idp), input())).toEqual({ ok: true, status: "created" });
    expect(await customers()).toBe(before + 1);
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from customers where cognito_sub = 'sub-created-1'",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(signUp.mock.calls[0]![0]).toMatchObject({ password: PASSWORD, locale: "bn" });
  });

  it("exists: returns exists with zero rows written", async () => {
    const { idp } = fakeIdp(() => ({ ok: true, value: { kind: "exists" } }));
    const before = {
      customers: await customers(),
      wallets: await count("wallets"),
      audit: await count("audit_log"),
    };
    expect(await registerAccount(deps(idp), input())).toEqual({ ok: true, status: "exists" });
    expect({
      customers: await customers(),
      wallets: await count("wallets"),
      audit: await count("audit_log"),
    }).toEqual(before);
    expect(db.registerCustomer).not.toHaveBeenCalled();
  });

  it("a closed market and an unknown market: market_unavailable, and signUp is never called", async () => {
    await t.pool.query("update markets set active = false where code = 'BD'");
    const { idp, signUp } = fakeIdp(() => created());
    const before = await customers();
    expect(await registerAccount(deps(idp), input())).toEqual({
      ok: false,
      error: "market_unavailable",
    });
    expect(await registerAccount(deps(idp), input({ market: "ZZ" }))).toEqual({
      ok: false,
      error: "market_unavailable",
    });
    expect(signUp).not.toHaveBeenCalled();
    expect(await customers()).toBe(before);
  });

  it("an input the database would refuse is validation, and signUp is never called (no orphan)", async () => {
    const { idp, signUp } = fakeIdp(() => created());
    for (const bad of [
      { phone: "01712345678" },
      { ip: "not-an-ip" },
      { acceptances: [] },
      { name: "A" },
      { email: "nope" },
    ]) {
      expect(await registerAccount(deps(idp), input(bad))).toEqual({
        ok: false,
        error: "validation",
      });
    }
    expect(signUp).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", "upstream_unavailable"],
    ["denied", "upstream_unavailable"],
    ["rate_limited", "rate_limited"],
    ["invalid_password", "validation"],
  ] as const)("a provider failure %s is %s with zero rows", async (kind, error) => {
    const { idp } = fakeIdp(() => ({ ok: false, kind }));
    const before = await customers();
    expect(await registerAccount(deps(idp), input())).toEqual({ ok: false, error });
    expect(await customers()).toBe(before);
  });

  it("a provider that throws is upstream_unavailable", async () => {
    const idp = {
      signUp: () => Promise.reject(new Error("boom " + PASSWORD)),
    } as unknown as IdentityProvider;
    const out = await registerAccount(deps(idp), input());
    expect(out).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(JSON.stringify(out)).not.toContain("PLANTED");
  });

  it("a registerCustomer failure after created is internal, and leaves no customer row", async () => {
    const { idp } = fakeIdp(() => created("sub-orphan-1"));
    const before = await customers();
    spy.failNext = true;
    expect(await registerAccount(deps(idp), input())).toEqual({ ok: false, error: "internal" });
    expect(await customers()).toBe(before);
  });

  it("a second registerAccount after created (the provider answers exists) changes nothing", async () => {
    const first = fakeIdp(() => created("sub-twice-1"));
    const i = input();
    expect(await registerAccount(deps(first.idp), i)).toEqual({ ok: true, status: "created" });
    const rows = await customers();
    const second = fakeIdp(() => ({ ok: true, value: { kind: "exists" } }));
    expect(await registerAccount(deps(second.idp), i)).toEqual({ ok: true, status: "exists" });
    expect(await customers()).toBe(rows);
  });

  it("the password is never passed to registerCustomer", async () => {
    const { idp } = fakeIdp(() => created());
    await registerAccount(deps(idp), input());
    expect(db.registerCustomer).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(db.registerCustomer).mock.calls[0]![1];
    expect(JSON.stringify(arg)).not.toContain("PLANTED");
    expect(Object.keys(arg)).not.toContain("password");
  });
});
