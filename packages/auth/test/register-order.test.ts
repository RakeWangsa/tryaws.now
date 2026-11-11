import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@tc/db";
import type { IdentityProvider, IdpResult, SignUpOutcome } from "../identity";
import { registerAccount, type RegisterDeps } from "../register";

// No database: the two @tc/db functions that register.ts calls are stand-ins, so the ORDER of the
// calls and the mapping of the answers are proved here. The rows are proved in register.test.ts.
const stub = vi.hoisted(() => ({
  market: { active: true } as { active: boolean } | null,
  calls: [] as string[],
  registered: { ok: true as boolean, replayed: false },
  throwOnRegister: false,
}));
vi.mock("@tc/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tc/db")>();
  return {
    ...actual,
    readMarket: vi.fn(async () => {
      stub.calls.push("readMarket");
      return stub.market;
    }),
    registerCustomer: vi.fn<typeof actual.registerCustomer>(async () => {
      stub.calls.push("registerCustomer");
      if (stub.throwOnRegister) throw new Error("PLANTED-DB-TEXT");
      return stub.registered.ok
        ? { ok: true, customerId: "id", replayed: stub.registered.replayed }
        : { ok: false, error: "market_unavailable" };
    }),
  };
});

import * as db from "@tc/db";

const PASSWORD = "Xk9#mQ2$vL7p-PLANTED";
const tx = {} as Tx;

function setup(answer: () => IdpResult<SignUpOutcome> | Promise<IdpResult<SignUpOutcome>>) {
  const signUp = vi.fn<IdentityProvider["signUp"]>(async () => {
    stub.calls.push("signUp");
    return answer();
  });
  const deps: RegisterDeps = {
    idp: { signUp } as unknown as IdentityProvider,
    run: (fn) => fn(tx),
  };
  return { deps, signUp };
}

const input = (over: Record<string, unknown> = {}) => ({
  email: "rahim@example.test",
  phone: "+8801712345678",
  name: "Rahim Uddin",
  market: "BD",
  locale: "bn" as const,
  acceptances: [
    { document: "terms" as const, version: "v" },
    { document: "acceptable_use" as const, version: "v" },
    { document: "privacy" as const, version: "v" },
  ],
  ip: "203.0.113.7",
  userAgent: "ua",
  password: PASSWORD,
  ...over,
});
const created: IdpResult<SignUpOutcome> = { ok: true, value: { kind: "created", sub: "sub-1" } };

beforeEach(() => {
  stub.market = { active: true };
  stub.calls = [];
  stub.registered = { ok: true, replayed: false };
  stub.throwOnRegister = false;
  vi.mocked(db.registerCustomer).mockClear();
});

describe("registerAccount order", () => {
  it("reads the market, then the provider, then registers: in that order", async () => {
    const { deps } = setup(() => created);
    expect(await registerAccount(deps, input())).toEqual({ ok: true, status: "created" });
    expect(stub.calls).toEqual(["readMarket", "signUp", "registerCustomer"]);
  });

  it("registers under the sub the provider returned, with no password and no extra field", async () => {
    const { deps } = setup(() => created);
    await registerAccount(deps, input());
    const arg = vi.mocked(db.registerCustomer).mock.calls[0]![1];
    expect(arg).toEqual({
      cognitoSub: "sub-1",
      email: "rahim@example.test",
      phone: "+8801712345678",
      name: "Rahim Uddin",
      market: "BD",
      locale: "bn",
      acceptances: input().acceptances,
      ip: "203.0.113.7",
      userAgent: "ua",
    });
    expect(JSON.stringify(arg)).not.toContain("PLANTED");
  });

  it("exists: no registerCustomer", async () => {
    const { deps } = setup(() => ({ ok: true, value: { kind: "exists" } }));
    expect(await registerAccount(deps, input())).toEqual({ ok: true, status: "exists" });
    expect(stub.calls).toEqual(["readMarket", "signUp"]);
  });

  it("a closed or missing market: the provider is never called", async () => {
    for (const market of [{ active: false }, null]) {
      stub.market = market;
      stub.calls = [];
      const { deps, signUp } = setup(() => created);
      expect(await registerAccount(deps, input())).toEqual({
        ok: false,
        error: "market_unavailable",
      });
      expect(signUp).not.toHaveBeenCalled();
      expect(stub.calls).toEqual(["readMarket"]);
    }
  });

  it.each([
    ["a phone that is not canonical", { phone: "017" }],
    ["an ip that is not an address", { ip: "x" }],
    ["no acceptances", { acceptances: [] }],
    ["a one-letter name", { name: "A" }],
    ["a missing password", { password: undefined }],
  ])("%s: validation, before any call", async (_n, over) => {
    const { deps, signUp } = setup(() => created);
    expect(await registerAccount(deps, input(over))).toEqual({ ok: false, error: "validation" });
    expect(signUp).not.toHaveBeenCalled();
    expect(stub.calls).toEqual([]);
  });

  it.each([
    ["unavailable", "upstream_unavailable"],
    ["denied", "upstream_unavailable"],
    ["not_confirmed", "upstream_unavailable"],
    ["rate_limited", "rate_limited"],
    ["invalid_password", "validation"],
  ] as const)("a provider failure %s is %s and registers nothing", async (kind, error) => {
    const { deps } = setup(() => ({ ok: false, kind }));
    expect(await registerAccount(deps, input())).toEqual({ ok: false, error });
    expect(stub.calls).not.toContain("registerCustomer");
  });

  it("a throwing provider is upstream_unavailable and shows no text", async () => {
    const { deps } = setup(() => Promise.reject(new Error(`boom ${PASSWORD}`)));
    const out = await registerAccount(deps, input());
    expect(out).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(JSON.stringify(out)).not.toContain("PLANTED");
  });

  it("a failure of registerCustomer after created (a throw, or a refusal) is internal", async () => {
    stub.throwOnRegister = true;
    expect(await registerAccount(setup(() => created).deps, input())).toEqual({
      ok: false,
      error: "internal",
    });
    stub.throwOnRegister = false;
    stub.registered = { ok: false, replayed: false };
    expect(await registerAccount(setup(() => created).deps, input())).toEqual({
      ok: false,
      error: "internal",
    });
  });
});
