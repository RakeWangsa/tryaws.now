import { describe, expect, it } from "vitest";
import nextConfig, { PANEL_NOINDEX_SOURCES } from "./next.config.ts";
import { NEXT_PREFIXES } from "./server/request.ts";

describe("next.config: the signed-in panel is not indexed", () => {
  it("sets X-Robots-Tag on every panel prefix in both locales", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.length).toBe(NEXT_PREFIXES.length * 2);
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
