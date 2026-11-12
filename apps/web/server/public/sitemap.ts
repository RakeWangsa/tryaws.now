import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import type { PublicCatalog } from "./catalog.ts";
import { DISALLOWED_PREFIXES, FAMILY_PAGES, LEGAL_DOCS, PUBLIC_PATHS } from "./indexing.ts";

// sitemap.xml and robots.txt of the public site (16.8). Both are built from the one list of public
// paths of indexing.ts. A product family appears only while its flag is on (R12): a coming soon
// page is not offered to search engines. Every entry names its other language (`hreflang`).

export interface SitemapEntry {
  url: string;
  alternates: { languages: Record<Locale | "x-default", string> };
}

/** The paths (without a locale) that belong in the sitemap for this catalog. */
export function sitemapPaths(catalog: PublicCatalog): string[] {
  const paths = [...PUBLIC_PATHS];
  if (catalog.state === "ok") {
    for (const page of FAMILY_PAGES) {
      if (catalog.flagOn(page.flag)) paths.push(`/products/${page.slug}`);
    }
  }
  // Every legal document is a public page, listed once (the first two are in PUBLIC_PATHS already).
  for (const doc of LEGAL_DOCS) {
    const path = `/legal/${doc}`;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function sitemapEntries(origin: string, catalog: PublicCatalog): SitemapEntry[] {
  const url = (locale: Locale, path: string): string => origin + localePath(locale, path);
  return sitemapPaths(catalog).flatMap((path) =>
    (["bn", "en"] as const).map((locale): SitemapEntry => ({
      url: url(locale, path),
      alternates: {
        languages: { bn: url("bn", path), en: url("en", path), "x-default": url("bn", path) },
      },
    })),
  );
}

export interface RobotsFile {
  rules: { userAgent: string; allow: string[]; disallow: string[] };
  sitemap: string;
}

export function robotsFile(origin: string): RobotsFile {
  return {
    rules: {
      userAgent: "*",
      allow: ["/"],
      disallow: DISALLOWED_PREFIXES.flatMap((prefix) => [prefix, `/en${prefix}`]),
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
