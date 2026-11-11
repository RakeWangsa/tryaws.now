import { afterEach, beforeEach, describe, expect, it } from "vitest";

const POOL = {
  COGNITO_CUSTOMER_POOL_ID: "ap-southeast-1_AbCdEf123",
  COGNITO_CUSTOMER_CLIENT_ID: "abcdefghij1234567890",
};
const REAL = {
  TC_STAGE: "staging",
  APP_ORIGIN: "https://cloud.example.com",
  NODE_ENV: "production",
};
const FAKE = {
  TC_STAGE: "test",
  APP_ORIGIN: "http://localhost:3000",
  NODE_ENV: "test",
  TC_IDP: "fake",
};

async function load() {
  return import("./proxy-auth.ts");
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)["__tcProxyAuthRuntime"];
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)["__tcProxyAuthRuntime"];
});

describe("proxyAuthRuntime", () => {
  it("builds the config of the environment and no override outside fakes", async () => {
    const { proxyAuthRuntime } = await load();
    const runtime = await proxyAuthRuntime({ ...REAL, ...POOL });
    expect(runtime?.config.customer).toEqual({
      region: "ap-southeast-1",
      userPoolId: POOL.COGNITO_CUSTOMER_POOL_ID,
      clientId: POOL.COGNITO_CUSTOMER_CLIENT_ID,
    });
    expect(runtime?.verifier).toBeUndefined();
    expect(runtime?.port).toBeUndefined();
  });

  it("is memoised", async () => {
    const { proxyAuthRuntime } = await load();
    const a = proxyAuthRuntime({ ...REAL, ...POOL });
    const b = proxyAuthRuntime({ ...REAL, ...POOL });
    expect(a).toBe(b);
  });

  it("uses the fake verifier and the fake refresh port only when the identity switch is on", async () => {
    const { proxyAuthRuntime } = await load();
    const runtime = await proxyAuthRuntime({ ...FAKE, ...POOL });
    expect(runtime?.verifier).toBeDefined();
    expect(runtime?.port).toBeDefined();
  });

  it("is null when the pool variables are missing or the config is refused (R16)", async () => {
    const { proxyAuthRuntime } = await load();
    expect(await proxyAuthRuntime({ ...REAL })).toBeNull();
    delete (globalThis as Record<string, unknown>)["__tcProxyAuthRuntime"];
    expect(await proxyAuthRuntime({ ...REAL, ...POOL, TC_IDP: "fake" })).toBeNull();
  });
});
