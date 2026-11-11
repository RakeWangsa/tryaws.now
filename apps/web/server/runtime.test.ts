import { inspect } from "node:util";
import type { InitializeRequest } from "@tc/eps";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  bridgeLoaded: 0,
  authLoaded: 0,
  configureAuth: vi.fn(),
  cookie: "a=b" as string | null,
}));

// The factory runs only when the module is really imported: it is the spy on the dynamic import.
vi.mock("./fakes/eps-bridge.ts", async (importOriginal) => {
  state.bridgeLoaded += 1;
  return importOriginal();
});
vi.mock("./fakes/dev-auth.ts", async (importOriginal) => {
  state.authLoaded += 1;
  return importOriginal();
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.cookie === null ? {} : { cookie: state.cookie }),
}));
vi.mock("@tc/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tc/auth")>()),
  configureAuth: state.configureAuth,
}));

const SECRETS = {
  SST_RESOURCE_EpsMerchantId: '{"type":"sst.sst.Secret","value":"planted-merchant-1111"}',
  SST_RESOURCE_EpsStoreId: '{"type":"sst.sst.Secret","value":"planted-store-2222"}',
  SST_RESOURCE_EpsUsername: '{"type":"sst.sst.Secret","value":"planted-user-3333"}',
  SST_RESOURCE_EpsPassword: '{"type":"sst.sst.Secret","value":"planted-password-4444"}',
  SST_RESOURCE_EpsHashKey: '{"type":"sst.sst.Secret","value":"planted-hashkey-5555"}',
  SST_RESOURCE_EpsLimitKey: '{"type":"sst.sst.Secret","value":"planted-limitkey-6666"}',
};
const PLANTED = ["1111", "2222", "3333", "4444", "5555", "6666"].map((n) => `-${n}`);

const STAGING = {
  TC_STAGE: "staging",
  APP_ORIGIN: "https://cloud.example.com",
  NODE_ENV: "production",
};
const FAKE = {
  TC_STAGE: "test",
  APP_ORIGIN: "http://localhost:3000",
  NODE_ENV: "test",
  TC_EPS: "fake",
};

async function load() {
  vi.resetModules();
  return import("./runtime.ts");
}

beforeEach(() => {
  state.bridgeLoaded = 0;
  state.authLoaded = 0;
  state.configureAuth.mockReset();
  state.cookie = "a=b";
  delete (globalThis as Record<string, unknown>)["__tcWebRuntime"];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("assembleRuntime: the real gateway", () => {
  it("five secrets and no sixth give no EPS (fail closed)", async () => {
    const { assembleRuntime } = await load();
    const five: Record<string, string | undefined> = { ...SECRETS };
    delete five["SST_RESOURCE_EpsLimitKey"];
    const built = await assembleRuntime({ ...STAGING, ...five });
    expect(built.runtime.eps).toBeNull();
    expect(built.deps).toBeNull();
    expect(state.bridgeLoaded).toBe(0);
  });

  it("any one missing secret gives no EPS", async () => {
    const { assembleRuntime } = await load();
    for (const name of Object.keys(SECRETS)) {
      const env: Record<string, string | undefined> = { ...STAGING, ...SECRETS };
      delete env[name];
      expect((await assembleRuntime(env)).runtime.eps, name).toBeNull();
    }
  });

  it("all six secrets give an EPS, and the runtime shows none of them", async () => {
    const { assembleRuntime } = await load();
    const { runtime } = await assembleRuntime({ ...STAGING, ...SECRETS });
    expect(runtime.eps).not.toBeNull();
    expect(typeof runtime.eps?.startTopUp).toBe("function");
    expect(runtime.config).toEqual({
      stage: "staging",
      appOrigin: "https://cloud.example.com",
      epsMode: "sandbox",
      fakes: false,
    });
    const shown = [
      JSON.stringify(runtime),
      inspect(runtime, { depth: 10, showHidden: true }),
      String(runtime),
    ].join("\n");
    for (const planted of PLANTED) expect(shown).not.toContain(planted);
  });

  it("builds EpsDeps exactly: return urls from the origin, the clock, the transaction and the id", async () => {
    const { assembleRuntime } = await load();
    const { deps } = await assembleRuntime({ ...STAGING, ...SECRETS });
    expect(deps?.urls).toEqual({
      successUrl: "https://cloud.example.com/pay/eps/success",
      failUrl: "https://cloud.example.com/pay/eps/fail",
      cancelUrl: "https://cloud.example.com/pay/eps/cancel",
    });
    expect(Math.abs((deps?.clock.now().getTime() ?? 0) - Date.now())).toBeLessThan(1000);
    expect(deps?.newPaymentId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(deps?.randomBytes(16)).toHaveLength(16);
    expect(typeof deps?.run).toBe("function");
    expect(deps?.limitKey).toBe("planted-limitkey-6666");
  });

  it("a production config with TC_EPS=fake throws and never reaches the dynamic import", async () => {
    const { assembleRuntime } = await load();
    await expect(
      assembleRuntime({ ...STAGING, TC_STAGE: "production", TC_EPS: "fake", ...SECRETS }),
    ).rejects.toThrow();
    await expect(assembleRuntime({ ...STAGING, TC_EPS: "fake" })).rejects.toThrow();
    expect(state.bridgeLoaded).toBe(0);
    expect(state.authLoaded).toBe(0);
  });

  it("a production config without fakes never loads the fakes either", async () => {
    const { assembleRuntime } = await load();
    await assembleRuntime({ ...STAGING, TC_STAGE: "production", ...SECRETS });
    expect(state.bridgeLoaded).toBe(0);
    expect(state.authLoaded).toBe(0);
  });
});

describe("assembleRuntime: fake mode", () => {
  it("builds an EPS without secrets, over the dev bridge, with hand-built http return urls", async () => {
    const { assembleRuntime } = await load();
    const { runtime, deps, verifier } = await assembleRuntime(FAKE);
    expect(runtime.config.fakes).toBe(true);
    expect(runtime.eps).not.toBeNull();
    expect(state.bridgeLoaded).toBe(1);
    expect(verifier).toBeDefined();
    expect(deps?.urls.successUrl).toBe("http://localhost:3000/pay/eps/success");
    const request: InitializeRequest = {
      merchantTransactionId: "0123456789abcdef0123456789abcdef",
      customerOrderId: "o1",
      totalAmountMinor: 50_000n,
      ipAddress: "127.0.0.1",
      productName: "Wallet top-up",
      ...(deps?.urls as { successUrl: string; failUrl: string; cancelUrl: string }),
    };
    const answer = await deps?.gateway.initialize(request);
    expect(answer?.ok).toBe(true);
    if (answer?.ok) expect(answer.redirectUrl).toMatch(/^\/dev\/eps\/checkout\?data=\d+$/);
  });
});

describe("assembleRuntime: log and alert (R14)", () => {
  it("log writes one JSON line and drops keys it does not know", async () => {
    const { assembleRuntime } = await load();
    const { deps } = await assembleRuntime({ ...STAGING, ...SECRETS });
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    deps?.log("eps.return", {
      state: "credited",
      reason: "success",
      phone: "01712345678",
      token: "t",
    } as Record<string, string>);
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ event: "eps.return", state: "credited", reason: "success" });
  });

  it("alert writes one payment_review line with decimal text amounts and no other field", async () => {
    const { assembleRuntime } = await load();
    const { deps } = await assembleRuntime({ ...STAGING, ...SECRETS });
    const write = vi.spyOn(console, "log").mockImplementation(() => {});
    await deps?.alert.raise({
      kind: "payment_review",
      paymentId: "p1",
      reason: "amount_mismatch",
      expectedMinor: 50_000n,
      gotMinor: null,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      event: "payment_review",
      severity: "alert",
      paymentId: "p1",
      reason: "amount_mismatch",
      expectedMinor: "50000",
      gotMinor: null,
    });
  });

  it("a failing sink never breaks the caller", async () => {
    const { assembleRuntime } = await load();
    const { deps } = await assembleRuntime({ ...STAGING, ...SECRETS });
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(() => deps?.log("x", { state: "a" })).not.toThrow();
    await expect(
      deps?.alert.raise({
        kind: "payment_review",
        paymentId: "p",
        reason: "r",
        expectedMinor: 1n,
        gotMinor: 2n,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("getRuntime", () => {
  function stub(env: Record<string, string>) {
    for (const [k, v] of Object.entries({
      COGNITO_CUSTOMER_POOL_ID: "eu-west-1_Abc123XyZ",
      COGNITO_CUSTOMER_CLIENT_ID: "abcdefghij1234567890",
      ...env,
    })) {
      vi.stubEnv(k, v);
    }
  }

  it("is cached: two calls give one object and configure auth once", async () => {
    stub(FAKE);
    const { getRuntime } = await load();
    const [a, b] = await Promise.all([getRuntime(), getRuntime()]);
    expect(a).toBe(b);
    expect(await getRuntime()).toBe(a);
    expect(state.configureAuth).toHaveBeenCalledTimes(1);
  });

  it("configures auth with the dev verifier in fake mode and reads the cookie header", async () => {
    stub(FAKE);
    const { getRuntime } = await load();
    await getRuntime();
    const arg = state.configureAuth.mock.calls[0]?.[0] as {
      deps?: { verifier?: { verify: (t: string) => Promise<{ ok: boolean }> } };
      readCookieHeader: () => Promise<string | null>;
      config: { customer: { userPoolId: string } };
    };
    expect(arg.config.customer.userPoolId).toBe("eu-west-1_Abc123XyZ");
    expect(await arg.readCookieHeader()).toBe("a=b");
    expect((await arg.deps?.verifier?.verify("dev.someone"))?.ok).toBe(true);
  });

  it("configures auth with the real verifier outside fake mode", async () => {
    stub({ ...STAGING, ...SECRETS });
    const { getRuntime } = await load();
    await getRuntime();
    const arg = state.configureAuth.mock.calls[0]?.[0] as { deps?: unknown };
    expect(arg.deps).toBeUndefined();
    expect(state.bridgeLoaded).toBe(0);
    expect(state.authLoaded).toBe(0);
  });

  it("a failure is not cached: the next call tries again", async () => {
    stub({ ...FAKE, TC_STAGE: "nonsense" });
    const { getRuntime } = await load();
    await expect(getRuntime()).rejects.toThrow();
    vi.stubEnv("TC_STAGE", "test");
    await expect(getRuntime()).resolves.toBeDefined();
  });
});
