import type { PublicCatalog, PublicOffer } from "../../../../server/public/catalog.ts";

// WPU-X18: what the home page takes from the catalog. Nothing here prices anything: an offer is the
// engine's output (catalog.ts) and the home page only chooses which offers to show (R4).

/** The two locations of the start, in the order of the messages. */
export const HOME_REGIONS = ["ap-southeast-1", "ap-south-1"] as const;

/** Never more plan cards than this on the home page: two rows of four. The rest is on /pricing. */
export const HOME_CARD_LIMIT = 8;

/** One part of a service: the feature flag that opens it and its public page, when it has one. */
interface ServicePart {
  readonly flag: string;
  /** The page without the locale prefix; null when the part is only a part of a server. */
  readonly path: string | null;
}

export type HomeServiceKey =
  "instances" | "containers" | "databases" | "networking" | "storage" | "domains" | "snapshots";

/**
 * The simple list of services, in the order of the owner's request (2026-11-15, WPU-X18). A service is
 * open when one of its parts has its flag on (R12); the flags are those of `server/families.ts`.
 */
export const HOME_SERVICES: readonly {
  readonly key: HomeServiceKey;
  readonly parts: readonly ServicePart[];
}[] = Object.freeze([
  {
    key: "instances",
    parts: [
      { flag: "linux_instance", path: "/products/cloud-servers" },
      { flag: "windows_instance", path: "/products/cloud-servers" },
    ],
  },
  { key: "containers", parts: [{ flag: "container_service", path: "/products/containers" }] },
  { key: "databases", parts: [{ flag: "database", path: "/products/databases" }] },
  {
    key: "networking",
    parts: [
      { flag: "load_balancer", path: "/products/load-balancers" },
      { flag: "cdn", path: "/products/cdn" },
      { flag: "static_ip", path: null },
    ],
  },
  {
    key: "storage",
    parts: [
      { flag: "bucket", path: "/products/object-storage" },
      { flag: "disk", path: null },
    ],
  },
  {
    key: "domains",
    parts: [
      { flag: "dns_zone", path: "/products/dns" },
      { flag: "domain", path: "/products/domains" },
    ],
  },
  { key: "snapshots", parts: [{ flag: "backup", path: null }] },
]);

export interface HomeServiceState {
  readonly key: HomeServiceKey;
  readonly open: boolean;
  /** The page of the first open part that has one; null when the service is not open or has none. */
  readonly path: string | null;
}

/**
 * Open or coming soon, from the feature flag of the market (R12). An unreadable catalog gives none:
 * a page that cannot tell must not promise a service (R16).
 */
export function homeServices(catalog: PublicCatalog): readonly HomeServiceState[] {
  if (catalog.state !== "ok") return [];
  return HOME_SERVICES.map((service) => {
    const open = service.parts.filter((part) => catalog.flagOn(part.flag));
    return {
      key: service.key,
      open: open.length > 0,
      path: open.find((part) => part.path !== null)?.path ?? null,
    };
  });
}

/** The platforms of the chooser and the catalog family that holds the plans of each. */
export const HOME_PLATFORMS = [
  { key: "linux", family: "linux_instance" },
  { key: "windows", family: "windows_instance" },
] as const;
export type HomePlatform = (typeof HOME_PLATFORMS)[number]["key"];

export type HomeChooser =
  | { readonly state: "unavailable" }
  /** The catalog is readable but no instance family is open (R12). */
  | { readonly state: "closed" }
  | {
      readonly state: "ok";
      /** The platforms that have plans, in the order of the console. */
      readonly platforms: readonly HomePlatform[];
      readonly platform: HomePlatform;
      /** The locations that have plans for the chosen platform. */
      readonly regions: readonly string[];
      readonly region: string;
      /** At most HOME_CARD_LIMIT plans of the chosen platform at the chosen location, cheapest first. */
      readonly offers: readonly PublicOffer[];
      /** How many plans there are in all; the rest is on /pricing. */
      readonly total: number;
    };

/**
 * The read-only preview of the create screen: platform, location and the plans with their prices. An
 * unknown or missing value of the query falls back to the first one that exists, never to a plan that
 * is not in the catalog. Every plan shown is an offer of the live catalog.
 */
export function homeChooser(
  catalog: PublicCatalog,
  query: { readonly region?: string | undefined; readonly platform?: string | undefined },
): HomeChooser {
  if (catalog.state !== "ok") return { state: "unavailable" };
  const offersOf = (family: string): readonly PublicOffer[] =>
    catalog.families.find((f) => f.family === family)?.offers ?? [];
  const platforms = HOME_PLATFORMS.filter((p) => offersOf(p.family).length > 0);
  const chosen = platforms.find((p) => p.key === query.platform) ?? platforms[0];
  if (chosen === undefined) return { state: "closed" };
  const all = offersOf(chosen.family);
  const regions = HOME_REGIONS.filter((code) => all.some((offer) => offer.region === code));
  const region = regions.find((code) => code === query.region) ?? regions[0];
  if (region === undefined) return { state: "closed" };
  const atRegion = all.filter((offer) => offer.region === region);
  return {
    state: "ok",
    platforms: platforms.map((p) => p.key),
    platform: chosen.key,
    regions,
    region,
    offers: atRegion.slice(0, HOME_CARD_LIMIT),
    total: atRegion.length,
  };
}
