import type { PublicCatalog, PublicOffer } from "../../../../server/public/catalog.ts";

// WPU-X13: what the home page takes from the catalog. Nothing here prices anything: an offer is the
// engine's output (catalog.ts) and the home page only chooses which offers to show (R4).

/** At most this many plan cards on the home page. */
export const HOME_PLAN_LIMIT = 4;

/**
 * The plans of the home page: the Cloud Server (Linux) plans, one for each memory size at its
 * cheapest location, cheapest first. A catalog without a Linux Cloud Server shows the first family
 * that has offers; an unreadable or empty catalog shows none.
 */
export function homePlans(catalog: PublicCatalog): readonly PublicOffer[] {
  if (catalog.state !== "ok") return [];
  const family =
    catalog.families.find((f) => f.family === "linux_instance" && f.offers.length > 0) ??
    catalog.families.find((f) => f.offers.length > 0);
  if (family === undefined) return [];
  const seen = new Set<string>();
  const picked: PublicOffer[] = [];
  for (const offer of family.offers) {
    const size = String(offer.specs.ramGb ?? offer.id);
    if (seen.has(size)) continue;
    seen.add(size);
    picked.push(offer);
    if (picked.length === HOME_PLAN_LIMIT) break;
  }
  return picked;
}

/** The products of the grid: the message key, the feature flag that opens it, its page, its icon. */
export interface HomeProduct {
  readonly key: "server" | "disk" | "staticIp" | "backup" | "cdn" | "dns" | "domain";
  readonly flag: string;
  /** The page of the product without the locale prefix; null when it is a part of a server. */
  readonly path: string | null;
  readonly icon: string;
}

export const HOME_PRODUCTS: readonly HomeProduct[] = Object.freeze([
  { key: "server", flag: "linux_instance", path: "/products/cloud-servers", icon: "fas fa-server" },
  { key: "disk", flag: "disk", path: null, icon: "fas fa-hdd" },
  { key: "staticIp", flag: "static_ip", path: null, icon: "fas fa-network-wired" },
  { key: "backup", flag: "backup", path: null, icon: "fas fa-camera" },
  { key: "cdn", flag: "cdn", path: "/products/cdn", icon: "fas fa-cloud" },
  { key: "dns", flag: "dns_zone", path: "/products/dns", icon: "fas fa-sitemap" },
  { key: "domain", flag: "domain", path: "/products/domains", icon: "fas fa-globe" },
]);

export interface HomeProductState extends HomeProduct {
  readonly open: boolean;
}

/**
 * Open or coming soon, from the feature flag of the market (R12). An unreadable catalog gives none:
 * a page that cannot tell must not promise a product (R16).
 */
export function homeProducts(catalog: PublicCatalog): readonly HomeProductState[] {
  if (catalog.state !== "ok") return [];
  return HOME_PRODUCTS.map((product) => ({ ...product, open: catalog.flagOn(product.flag) }));
}

/** The two locations of the start, in the order of the messages. */
export const HOME_REGIONS = ["ap-southeast-1", "ap-south-1"] as const;

/** The questions of the home page, from `Public.help.items` (the same text as /help). */
export const HOME_FAQ_KEYS = [
  "realAws",
  "noAccount",
  "payment",
  "priceIncludes",
  "identity",
  "locations",
  "support",
  "refunds",
] as const;
