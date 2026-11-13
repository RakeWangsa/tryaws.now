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

/** Without an origin there are no absolute URLs, so there is no sitemap (R16). */
export function sitemapEntries(origin: string | null, catalog: PublicCatalog): SitemapEntry[] {
  if (origin === null) return [];
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

/**
 * WPU-Z16: the crawlers of the answer engines, each named in its own group so the allowance is explicit
 * (checked 2026-11-14 against each vendor's page; JOURNEY records the VERIFY):
 * - OpenAI: GPTBot (training), OAI-SearchBot (ChatGPT search), ChatGPT-User (fetches for a user);
 * - Anthropic: ClaudeBot (training), Claude-User (fetches for a user), Claude-SearchBot (search);
 * - Perplexity: PerplexityBot (search), Perplexity-User (fetches for a user);
 * - Google: Google-Extended (a robots.txt token only: Gemini training and grounding; no crawler of its own);
 * - Microsoft: bingbot (Bing, and through it Copilot);
 * - Apple: Applebot-Extended (a robots.txt token only, for Apple's generative models).
 * A crawler that matches a group of its own ignores the `*` group, so each group repeats the same
 * disallowed prefixes: the panel, the sign-in pages, the API, the payment return and the dev pages.
 */
export const AI_CRAWLERS: readonly string[] = Object.freeze([
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "bingbot",
  "Applebot-Extended",
]);

export interface RobotsRule {
  userAgent: string | string[];
  allow: string[];
  disallow: string[];
}

export interface RobotsFile {
  rules: RobotsRule[];
  /** Absent without an origin. */
  sitemap?: string;
}

/** The disallowed prefixes in both locales (bn has no prefix, en is under /en). */
export function disallowedPaths(): string[] {
  return DISALLOWED_PREFIXES.flatMap((prefix) => [prefix, `/en${prefix}`]);
}

export function robotsFile(origin: string | null): RobotsFile {
  const disallow = disallowedPaths();
  return {
    rules: [
      { userAgent: "*", allow: ["/"], disallow },
      { userAgent: [...AI_CRAWLERS], allow: ["/"], disallow },
    ],
    ...(origin !== null ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
