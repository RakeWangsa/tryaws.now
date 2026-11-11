import { describe, expect, it } from "vitest";
import nextConfig, { AUTH_NOINDEX_SOURCES, PANEL_NOINDEX_SOURCES } from "./next.config.ts";
import { NEXT_PREFIXES } from "./server/request.ts";

describe("next.config: the signed-in panel is not indexed", () => {
  it("sets X-Robots-Tag on every panel prefix in both locales", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const prefix of NEXT_PREFIXES) {
      for (const source of [`${prefix}/:path*`, `/en${prefix}/:path*`]) {
        const rule = rules.find((candidate) => candidate.source === source);
        expect(rule, source).toBeDefined();
        expect(rule?.headers).toEqual([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]);
      }
    }
    expect(PANEL_NOINDEX_SOURCES).toContain("/wallet/:path*");
    expect(PANEL_NOINDEX_SOURCES).toContain("/en/wallet/:path*");
  });
});

describe("next.config: the five sign-in screens are not cached and not indexed", () => {
  it("sets Cache-Control no-store and X-Robots-Tag on each path in both locales", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.length).toBe(NEXT_PREFIXES.length * 2 + 10);
    for (const path of ["/signup", "/verify", "/login", "/forgot-password", "/reset-password"]) {
      for (const source of [path, `/en${path}`]) {
        const rule = rules.find((candidate) => candidate.source === source);
        expect(rule, source).toBeDefined();
        expect(rule?.headers).toEqual([
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ]);
      }
    }
    expect(AUTH_NOINDEX_SOURCES).toHaveLength(10);
  });
});
