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

  // Re-review L1: a first read of the link that fails must not leave every session of the container
  // without a refresh port for the life of the container. A runtime built without a port is kept for at
  // most a minute, then built again; a runtime with a port is kept. Each build without a port logs a
  // fixed line, with no value.
  describe("a runtime without a refresh port", () => {
    const GOOD_LINK = JSON.stringify({
      id: POOL.COGNITO_CUSTOMER_CLIENT_ID,
      secret: "customer0app0client0secret0abcdef",
    });
    const MINUTE = 60_000;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function logs() {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      return lines;
    }

    it("is built again after a minute and then has the port; a good one is kept", async () => {
      const lines = logs();
      const { proxyAuthRuntime } = await load();
      let t = 5_000_000;
      const link: { raw: string | undefined } = { raw: undefined };
      const links = () => (link.raw === undefined ? undefined : JSON.parse(link.raw));
      const first = await proxyAuthRuntime({ ...REAL, ...POOL }, links, () => t);
      expect(first?.port).toBeUndefined();
      // within the minute: the same runtime, no new build, no new line
      t += MINUTE - 1;
      link.raw = GOOD_LINK;
      expect(await proxyAuthRuntime({ ...REAL, ...POOL }, links, () => t)).toBe(first);
      expect(lines).toEqual([JSON.stringify({ event: "auth.refresh", reason: "no_port" })]);
      // a minute after the build: built again, now with the port
      t += 1;
      const second = await proxyAuthRuntime({ ...REAL, ...POOL }, links, () => t);
      expect(second).not.toBe(first);
      expect(typeof second?.port?.refresh).toBe("function");
      // a runtime with a port is kept for good
      t += 60 * MINUTE;
      expect(await proxyAuthRuntime({ ...REAL, ...POOL }, links, () => t)).toBe(second);
      expect(lines).toHaveLength(1);
    });

    it("keeps trying once a minute while the link stays unreadable, one line per build, no value", async () => {
      const lines = logs();
      const { proxyAuthRuntime } = await load();
      let t = 9_000_000;
      const links = () => ({ id: "x", secret: "customer0app0client0secret0abcdef" });
      for (let i = 0; i < 3; i++) {
        const runtime = await proxyAuthRuntime({ ...REAL, ...POOL }, links, () => t);
        expect(runtime?.port).toBeUndefined();
        t += MINUTE;
      }
      expect(lines).toEqual(
        Array(3).fill(JSON.stringify({ event: "auth.refresh", reason: "no_port" })),
      );
      expect(lines.join("")).not.toContain("customer0app0client0secret0abcdef");
    });

    it("a runtime that was not configurable (null) logs nothing and keeps the old caching", async () => {
      const lines = logs();
      const { proxyAuthRuntime } = await load();
      expect(await proxyAuthRuntime({ ...REAL }, undefined, () => 1)).toBeNull();
      expect(lines).toEqual([]);
    });
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
