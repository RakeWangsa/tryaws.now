import { describe, expect, it } from "vitest";
import { isPublicPath } from "./indexing.ts";
import { robotsFile, sitemapEntries, sitemapPaths } from "./sitemap.ts";
import type { PublicCatalog } from "./catalog.ts";

const ORIGIN = "https://cloud.example.test";
const catalog = (on: string[]): PublicCatalog => ({
  state: "ok",
  families: [],
  open: [],
  domainsOpen: false,
  flagOn: (key) => on.includes(key),
});

describe("sitemap.xml", () => {
  it("lists the public pages in both locales, each with hreflang alternates and an x-default", () => {
    const entries = sitemapEntries(ORIGIN, catalog([]));
    const pricingBn = entries.find((e) => e.url === `${ORIGIN}/pricing`);
    const pricingEn = entries.find((e) => e.url === `${ORIGIN}/en/pricing`);
    expect(pricingBn?.alternates.languages).toEqual({
      bn: `${ORIGIN}/pricing`,
      en: `${ORIGIN}/en/pricing`,
      "x-default": `${ORIGIN}/pricing`,
    });
    expect(pricingEn?.alternates).toEqual(pricingBn?.alternates);
    expect(entries.find((e) => e.url === `${ORIGIN}/`)).toBeDefined();
    expect(entries.find((e) => e.url === `${ORIGIN}/en`)).toBeDefined();
  });

  it("holds public pages only, no duplicate and every legal document", () => {
    const paths = sitemapPaths(catalog(["database"]));
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(isPublicPath(path), path).toBe(true);
    for (const doc of ["terms", "privacy", "acceptable-use", "refund"]) {
      expect(paths).toContain(`/legal/${doc}`);
    }
  });

  it("lists a product family only while its flag is on (R12), and none when the flags cannot be read", () => {
    expect(sitemapPaths(catalog([]))).not.toContain("/products/databases");
    expect(sitemapPaths(catalog(["database"]))).toContain("/products/databases");
    expect(sitemapPaths(catalog(["database"]))).not.toContain("/products/cdn");
    expect(sitemapPaths({ state: "unavailable" })).not.toContain("/products/databases");
  });

  it("never lists the panel, the sign-in pages or the dev pages", () => {
    const text = JSON.stringify(sitemapEntries(ORIGIN, catalog(["database", "bucket", "cdn"])));
    for (const hidden of ["/dashboard", "/login", "/signup", "/servers", "/wallet", "/dev/"]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });
});

describe("robots.txt", () => {
  it("allows the site, names the sitemap and keeps crawlers out of the panel and the sign-in pages, in both locales", () => {
    const file = robotsFile(ORIGIN);
    const all = file.rules[0]!;
    expect(all.userAgent).toBe("*");
    expect(file.sitemap).toBe(`${ORIGIN}/sitemap.xml`);
    expect(all.allow).toEqual(["/"]);
    for (const path of ["/login", "/en/login", "/dashboard", "/en/wallet", "/api/", "/dev/"]) {
      expect(all.disallow, path).toContain(path);
    }
    // Nothing public is disallowed.
    for (const path of [
      "/",
      "/pricing",
      "/help",
      "/support",
      "/legal/terms",
      "/products/cloud-servers",
    ]) {
      expect(
        all.disallow.some((p) => p !== "/" && path.startsWith(p)),
        path,
      ).toBe(false);
    }
  });
});
