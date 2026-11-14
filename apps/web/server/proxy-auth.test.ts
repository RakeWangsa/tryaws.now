import { envLinks } from "@tc/db/links";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // Round 4: the customer client has a secret, so the refresh of the proxy needs it. It comes from the
  // SST link CustomerAppClient (the proxy runs in the server function that holds the links); without a
  // good link there is no port of ours and the default refreshes nothing (R16).
  it("builds the refresh port from the customer client link when it is readable", async () => {
    const { proxyAuthRuntime } = await load();
    const links = envLinks({
      SST_RESOURCE_CustomerAppClient: JSON.stringify({
        id: POOL.COGNITO_CUSTOMER_CLIENT_ID,
        secret: "customer0app0client0secret0abcdef",
      }),
    });
    const runtime = await proxyAuthRuntime({ ...REAL, ...POOL }, links);
    expect(typeof runtime?.port?.refresh).toBe("function");
    expect(JSON.stringify(runtime)).not.toContain("customer0app0client0secret0abcdef");
  });

  it("without a good link or with another client's link there is no port (and no throw)", async () => {
    const { proxyAuthRuntime } = await load();
    for (const raw of [
      undefined,
      "not json",
      JSON.stringify({ id: POOL.COGNITO_CUSTOMER_CLIENT_ID }),
      JSON.stringify({ id: "zyxwvutsrq0987654321", secret: "customer0app0client0secret0abcdef" }),
    ]) {
      delete (globalThis as Record<string, unknown>)["__tcProxyAuthRuntime"];
      const links = envLinks(raw === undefined ? {} : { SST_RESOURCE_CustomerAppClient: raw });
      const runtime = await proxyAuthRuntime({ ...REAL, ...POOL }, links);
      expect(runtime?.config.customer.userPoolId, String(raw)).toBe(POOL.COGNITO_CUSTOMER_POOL_ID);
      expect(runtime?.port, String(raw)).toBeUndefined();
    }
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

  it("loads no fake in a production build, even if the env handed in asks for the identity fake (R12, R16)", async () => {
    // The env object says "test", the process says "production": the second guard of build() alone must hold.
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { proxyAuthRuntime } = await load();
      const runtime = await proxyAuthRuntime({ ...FAKE, ...POOL });
      expect(runtime?.config.customer.userPoolId).toBe(POOL.COGNITO_CUSTOMER_POOL_ID);
      expect(runtime?.verifier).toBeUndefined();
      expect(runtime?.port).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is null when the pool variables are missing or the config is refused (R16)", async () => {
    const { proxyAuthRuntime } = await load();
    expect(await proxyAuthRuntime({ ...REAL })).toBeNull();
    delete (globalThis as Record<string, unknown>)["__tcProxyAuthRuntime"];
    expect(await proxyAuthRuntime({ ...REAL, ...POOL, TC_IDP: "fake" })).toBeNull();
  });
});
