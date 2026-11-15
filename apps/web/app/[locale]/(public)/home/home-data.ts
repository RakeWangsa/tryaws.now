import type { PlanType } from "@tc/core";
import type { PublicCatalog, PublicOffer } from "../../../../server/public/catalog.ts";
import type { PublicImage, PublicImages } from "../../../../server/public/images.ts";

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

/**
 * The platforms of the chooser (WPU-X22, the steps of the Lightsail console): Linux apps and Linux
 * operating system exist where the image allow-list offers images of that kind in the Region, Microsoft
 * Windows where Windows plans exist (its image is fixed by the plan family; the allow-list has no Windows
 * images). When the images cannot be read the page falls back to the plain "linux" of WPU-X18 and
 * shows no image step (R16). The key is the `platform` of the query.
 */
export const HOME_PLATFORMS = [
  { key: "apps", family: "linux_instance", kind: "app" },
  { key: "os", family: "linux_instance", kind: "os" },
  { key: "linux", family: "linux_instance", kind: null },
  { key: "windows", family: "windows_instance", kind: null },
] as const;
export type HomePlatform = (typeof HOME_PLATFORMS)[number]["key"];

/**
 * WPU-X24: the plan types of the console, in the order of its row. The key is the `type` of the query and
 * the key of the messages (`Public.home.types`).
 */
export const HOME_PLAN_TYPES: readonly PlanType[] = Object.freeze([
  "general_purpose",
  "memory_optimized",
  "compute_optimized",
]);

export type HomeChooser =
  | { readonly state: "unavailable" }
  /** The catalog is readable but no instance family is open (R12). */
  | { readonly state: "closed" }
  | {
      readonly state: "ok";
      /** The platforms that have plans at the chosen location, in the order of the console. */
      readonly platforms: readonly HomePlatform[];
      readonly platform: HomePlatform;
      /** The locations that have plans for the chosen platform. */
      readonly regions: readonly string[];
      readonly region: string;
      /** The images of the chosen platform at the chosen location; empty for `linux` and `windows`. */
      readonly blueprints: readonly PublicImage[];
      /** The chosen image (the query's, else the first); null when there are none. */
      readonly blueprint: PublicImage | null;
      /** The plan types that have at least one plan here, in the order of the console. */
      readonly types: readonly PlanType[];
      /** The chosen type (the query's, else the first that has plans); null when no type has plans. */
      readonly planType: PlanType | null;
      /** Plans of the platform that have no type and are hidden because other plans have one (R16). */
      readonly hiddenUntyped: number;
      /** At most HOME_CARD_LIMIT plans of the chosen type, platform and location, cheapest first. */
      readonly offers: readonly PublicOffer[];
      /** How many plans there are in all; the rest is on /pricing. */
      readonly total: number;
    };

/**
 * The read-only preview of the create screen: location, platform, image and the plans with their
 * prices. An unknown or missing value of the query falls back to the first one that exists, never to a
 * plan or image that is not in the catalog. Every plan shown is an offer of the live catalog.
 */
export function homeChooser(
  catalog: PublicCatalog,
  images: PublicImages,
  query: {
    readonly region?: string | undefined;
    readonly platform?: string | undefined;
    readonly blueprint?: string | undefined;
    readonly type?: string | undefined;
  },
): HomeChooser {
  if (catalog.state !== "ok") return { state: "unavailable" };
  const offersOf = (family: string): readonly PublicOffer[] =>
    catalog.families.find((f) => f.family === family)?.offers ?? [];
  const imagesAt = (region: string, kind: "app" | "os"): readonly PublicImage[] =>
    images.state === "ok" ? (images.byRegion[region] ?? []).filter((i) => i.kind === kind) : [];
  // Which platforms exist at a location: plans of the family and, for apps and os, images of the kind.
  const availableAt = (region: string): readonly (typeof HOME_PLATFORMS)[number][] =>
    HOME_PLATFORMS.filter((p) => {
      if (!offersOf(p.family).some((offer) => offer.region === region)) return false;
      if (p.key === "linux") return images.state !== "ok";
      if (p.kind !== null) return imagesAt(region, p.kind).length > 0;
      return true;
    });
  const regionsWith = HOME_REGIONS.filter((code) => availableAt(code).length > 0);
  const firstRegion = regionsWith[0];
  if (firstRegion === undefined) return { state: "closed" };
  // The platform comes first: the query's (the old `linux` of WPU-X18 means the first Linux step when
  // images are known), else the first platform of the first location. The location is then the query's
  // if the platform exists there.
  const everywhere = new Set(regionsWith.flatMap((code) => availableAt(code).map((p) => p.key)));
  const wanted = query.platform === "linux" && images.state === "ok" ? "apps" : query.platform;
  const chosen =
    HOME_PLATFORMS.find((p) => p.key === wanted && everywhere.has(p.key)) ??
    availableAt(firstRegion)[0];
  if (chosen === undefined) return { state: "closed" };
  const regions = regionsWith.filter((code) => availableAt(code).some((p) => p.key === chosen.key));
  const region = regions.find((code) => code === query.region) ?? regions[0];
  if (region === undefined) return { state: "closed" };
  // WPU-X24. A plan without a type counts as general purpose only while no plan of the whole instance
  // catalog has a type (the sync has not been rerun); after that it is hidden, never guessed (R16).
  const anyTyped = ["linux_instance", "windows_instance"].some((family) =>
    offersOf(family).some((offer) => (offer.planType ?? null) !== null),
  );
  const typeOf = (offer: PublicOffer): PlanType | null =>
    offer.planType ?? (anyTyped ? null : "general_purpose");
  const ofPlatform = offersOf(chosen.family).filter((offer) => offer.region === region);
  const types = HOME_PLAN_TYPES.filter((type) =>
    ofPlatform.some((offer) => typeOf(offer) === type),
  );
  const planType = types.find((type) => type === query.type) ?? types[0] ?? null;
  const atRegion =
    planType === null ? [] : ofPlatform.filter((offer) => typeOf(offer) === planType);
  const hiddenUntyped = offersOf(chosen.family).filter((offer) => typeOf(offer) === null).length;
  const blueprints = chosen.kind === null ? [] : imagesAt(region, chosen.kind);
  return {
    state: "ok",
    platforms: availableAt(region).map((p) => p.key),
    platform: chosen.key,
    regions,
    region,
    blueprints,
    blueprint: blueprints.find((b) => b.id === query.blueprint) ?? blueprints[0] ?? null,
    types,
    planType,
    hiddenUntyped,
    offers: atRegion.slice(0, HOME_CARD_LIMIT),
    total: atRegion.length,
  };
}
