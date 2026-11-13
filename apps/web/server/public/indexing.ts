import { splitLocale } from "@tc/ui/runtime";

// What search engines may index (16.8): the public pages, and nothing else. One list serves the
// sitemap, robots.txt and the `X-Robots-Tag` that the proxy puts on every other path, so the
// panel, the sign-in pages, the dev pages and the API cannot be indexed by a missing tag (R16).

/** The paths of the public pages without a locale prefix. */
export const PUBLIC_PATHS: readonly string[] = Object.freeze([
  "/",
  "/pricing",
  "/products/cloud-servers",
  "/help",
  "/support",
  "/legal/terms",
  "/legal/acceptable-use",
  "/legal/privacy",
  "/legal/refund",
]);

/**
 * The product pages of the families that are not Cloud Server (P1, 16.8): the path segment, the
 * feature flag that opens the family, and the key of its name in the messages.
 */
export interface FamilyPage {
  readonly slug: string;
  readonly flag: string;
  readonly nameKey:
    "databases" | "objectStorage" | "loadBalancers" | "containers" | "cdn" | "dns" | "domains";
}

export const FAMILY_PAGES: readonly FamilyPage[] = Object.freeze([
  { slug: "databases", flag: "database", nameKey: "databases" },
  { slug: "object-storage", flag: "bucket", nameKey: "objectStorage" },
  { slug: "load-balancers", flag: "load_balancer", nameKey: "loadBalancers" },
  { slug: "containers", flag: "container_service", nameKey: "containers" },
  { slug: "cdn", flag: "cdn", nameKey: "cdn" },
  { slug: "dns", flag: "dns_zone", nameKey: "dns" },
  { slug: "domains", flag: "domain", nameKey: "domains" },
]);

export function familyPageOf(slug: string): FamilyPage | null {
  return FAMILY_PAGES.find((page) => page.slug === slug) ?? null;
}

/** The legal documents and the order of their sidebar. */
export const LEGAL_DOCS = ["terms", "privacy", "acceptable-use", "refund"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

export function isLegalDoc(value: string): value is LegalDoc {
  return (LEGAL_DOCS as readonly string[]).includes(value);
}

const PUBLIC = new Set<string>([
  ...PUBLIC_PATHS,
  ...FAMILY_PAGES.map((page) => `/products/${page.slug}`),
]);

/** True for a path (with or without the `/en` prefix) of a page that may be indexed. */
export function isPublicPath(pathname: string): boolean {
  const { path } = splitLocale(pathname);
  const bare = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return PUBLIC.has(bare);
}

export const NOINDEX = "noindex, nofollow";

/**
 * WPU-Z16 (owner ruling 2026-11-14): only the production site may be indexed. Every other stage
 * (staging, local, test, or a TC_STAGE that is missing or unknown: fail closed, R16) is kept out of
 * every index: robots.txt disallows everything and every page carries `noindex, nofollow`. The stage
 * is TC_STAGE, the variable the web app already reads (server/config.ts, set by infra/stacks/web.ts).
 */
export function indexableStage(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["TC_STAGE"] === "production";
}

/**
 * The `X-Robots-Tag` value for a path: null for a public page of an indexable stage, `noindex,
 * nofollow` for the rest and for every path of a stage that is not production.
 */
export function robotsTagFor(pathname: string, indexable: boolean): string | null {
  return indexable && isPublicPath(pathname) ? null : NOINDEX;
}

/** The prefixes that robots.txt asks crawlers to stay out of (a hint; the header is the rule). */
export const DISALLOWED_PREFIXES: readonly string[] = Object.freeze([
  "/api/",
  "/pay/",
  "/dev/",
  "/login",
  "/signup",
  "/verify",
  "/forgot-password",
  "/reset-password",
  "/dashboard",
  "/servers",
  "/storage",
  "/containers",
  "/cdn",
  "/databases",
  "/wallet",
  "/orders",
  "/kyc",
  "/settings",
  "/notifications",
  "/maintenance",
  // WPU-Z16: the rest of the panel's routes (NEXT_PREFIXES), so no crawler group is invited in. The
  // public /support page stays open; its panel pages are under /support/.
  "/invoices",
  "/billing",
  "/dns",
  "/domains",
  "/load-balancers",
  "/snapshots",
  "/static-ips",
  "/support/",
]);
