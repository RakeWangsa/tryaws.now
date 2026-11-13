import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// As in proxy.test.ts: the refresh runtime is "not configurable", which is what a header test wants.
vi.mock("./server/proxy-auth.ts", () => ({ proxyAuthRuntime: async () => null }));

import proxy from "./proxy.ts";

const run = async (path: string) => await proxy(new NextRequest(`http://localhost:3000${path}`));

describe("proxy: X-Robots-Tag (WPP-T3, 16.8)", () => {
  // Production is the only indexable stage (WPU-Z16); these cases are those of production.
  beforeEach(() => vi.stubEnv("TC_STAGE", "production"));
  afterEach(() => vi.unstubAllEnvs());

  it("leaves the public pages indexable, in both locales", async () => {
    for (const path of [
      "/",
      "/en",
      "/pricing",
      "/en/pricing",
      "/products/cloud-servers",
      "/help",
      "/en/support",
      "/legal/terms",
      "/products/databases",
    ]) {
      expect((await run(path)).headers.get("x-robots-tag"), path).toBeNull();
    }
  });

  it("puts noindex, nofollow on the panel, the sign-in pages and the dev pages", async () => {
    for (const path of [
      "/dashboard",
      "/servers",
      "/en/servers/new",
      "/wallet/topup",
      "/login",
      "/en/signup",
      "/verify",
      "/forgot-password",
      "/reset-password",
      "/settings/profile",
      "/kyc",
      "/orders/review",
      "/dev/ui",
      "/en/dev/sign-in",
    ]) {
      expect((await run(path)).headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
    }
  });

  it("keeps the other headers when it adds the tag", async () => {
    const response = await run("/login");
    expect(response.headers.get("content-security-policy-report-only")).toContain("nonce-");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("proxy: X-Robots-Tag on a stage that is not production (WPU-Z16)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["staging", "local", "test", ""])(
    "TC_STAGE=%j: every path, public pages too, is noindex",
    async (stage) => {
      vi.stubEnv("TC_STAGE", stage);
      for (const path of [
        "/",
        "/en",
        "/pricing",
        "/en/help",
        "/legal/terms",
        "/dashboard",
        "/login",
      ]) {
        expect((await run(path)).headers.get("x-robots-tag"), `${stage} ${path}`).toBe(
          "noindex, nofollow",
        );
      }
    },
  );
});
