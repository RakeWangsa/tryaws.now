import { loginUserOf } from "./connect";

// WPU-G3. The images (Amazon Lightsail blueprints) a customer can pick for a Linux server. Pure: the
// mapping of one `GetBlueprints` item to a catalog row, the admin allow-list rule, and the grouping the
// create wizard shows ("Apps + OS" and "OS only", as the Lightsail console does).
//
// Where the data lives (spec 07, no new table): the synced images are rows of `catalog_products` with
// the family `blueprint` (one per Region; specs hold the name, kind, group, version and login user), and
// the admin's switches are the market setting `image_allowlist` (spec 07 names it; spec 13 "Products:
// blueprint allow-list"). An image is OFFERED when AWS lists it as active in the Region and the
// allow-list says yes. A blueprint is sold only after its bootstrap passes the isolation test
// (spec 10.4): switching one on is that decision, made by a person.

export const BLUEPRINT_FAMILY = "blueprint";

export interface RawBlueprint {
  readonly blueprintId: string;
  readonly name: string;
  /** `os` or `app` as AWS writes it; anything else is refused. */
  readonly type: string | null;
  readonly group: string | null;
  readonly version: string | null;
  /** `LINUX_UNIX` or `WINDOWS`. */
  readonly platform: string | null;
  readonly isActive: boolean;
  /**
   * WPU-G10: `minPower` of GetBlueprints, the least bundle power the image runs on (the unit of
   * GetBundles `power`; 298 is the 512 MB plan, 500 the 1 GB plan, 1000 the 2 GB plan, 0 every plan: the AWS CLI
   * get-bundles example, WPU-Z19). Absent or not a whole number: unknown.
   */
  readonly minPower?: number | null;
}

export type BlueprintKind = "app" | "os";

/** The catalog row of one image in one Region (family `blueprint`, no price). */
export interface BlueprintRow {
  readonly family: typeof BLUEPRINT_FAMILY;
  readonly awsId: string;
  readonly platform: "linux";
  readonly region: string;
  readonly specs: {
    readonly name: string;
    readonly kind: BlueprintKind;
    readonly group: string | null;
    readonly version: string | null;
    readonly loginUser: string | null;
    /** What AWS reported as the least bundle power; null when it said nothing usable. */
    readonly minPower: number | null;
  };
  readonly awsPriceUsd: "0";
  readonly billingUnit: "none";
  readonly featureFlag: "linux_instance";
  readonly active: boolean;
}

/**
 * The images switched on until an admin decides otherwise: OS-only images with a known login user and
 * a few popular apps. VERIFY (JOURNEY WPU-G3): the ids against `GetBlueprints` in tc-pool-dev and the
 * bootstrap of every app image against the isolation test before production; an id that AWS does not
 * list never appears. Production sells nothing until the family flag is on (R12).
 */
export const DEFAULT_ENABLED_BLUEPRINTS: readonly string[] = Object.freeze([
  "ubuntu_24_04",
  "ubuntu_22_04",
  "amazon_linux_2023",
  "debian_12",
  "wordpress",
  "lamp_8_bitnami",
  "nodejs",
  "nginx",
]);

const BLUEPRINT_ID = /^[a-z0-9_]{1,64}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const SHORT_TEXT = 80;

export function isBlueprintId(value: unknown): value is string {
  return typeof value === "string" && BLUEPRINT_ID.test(value);
}

/** Text from AWS shown to a customer: no control characters, at most 80 characters. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = [...value]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("")
    .trim()
    .slice(0, SHORT_TEXT);
  return text === "" ? null : text;
}

/**
 * One `GetBlueprints` item of a Region to a catalog row, or null for what is not offered: a Windows
 * image (Windows has its own flow), an id that is not a plain word, a type that is not `os` or `app`.
 * Fail closed (R16).
 */
export function mapBlueprint(item: unknown, region: string): BlueprintRow | null {
  if (typeof region !== "string" || !REGION.test(region)) return null;
  if (typeof item !== "object" || item === null) return null;
  const raw = item as Partial<RawBlueprint>;
  if (raw.platform !== "LINUX_UNIX") return null;
  if (!isBlueprintId(raw.blueprintId)) return null;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  if (type !== "os" && type !== "app") return null;
  return {
    family: BLUEPRINT_FAMILY,
    awsId: raw.blueprintId,
    platform: "linux",
    region,
    specs: {
      name: cleanText(raw.name) ?? raw.blueprintId,
      kind: type,
      group: cleanText(raw.group),
      version: cleanText(raw.version),
      loginUser: loginUserOf(raw.blueprintId),
      minPower: powerOrNull(raw.minPower),
    },
    awsPriceUsd: "0",
    billingUnit: "none",
    featureFlag: "linux_instance",
    active: raw.isActive === true,
  };
}

/**
 * WPU-G10. The minimum bundle power of an app image whose minimum nobody knows (AWS did not report one
 * and no admin set one). WPU-Z19 (verify review 2026-11-13, owner ruling 2026-11-14): 500, the 1 GB plan. The AWS
 * CLI get-bundles example gives nano_3_0 power 298 with 0.5 GB, micro_3_0 power 500 with 1.0 GB and small_3_0 power
 * 1000 with 2.0 GB (the old value 1000 was the 2 GB plan, one plan off). The get-blueprints example reports minPower
 * 0 for wordpress, lamp_8_bitnami and nodejs ("0 indicates that the blueprint runs on all instance sizes"), so the
 * floor is the platform's own margin against the 512 MB plan, which an admin can lower per image; a minPower that
 * AWS reports wins over it. An OS-only image has no default minimum: it runs on every plan. Still to check:
 * `GetBlueprints.minPower` for each enabled blueprint in tc-pool-dev.
 */
export const DEFAULT_APP_MIN_POWER = 500;
/** The largest minimum that is believed (matches the admin editor); anything above is "unknown". */
const MIN_POWER_MAX = 100000;

function powerOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MIN_POWER_MAX
    ? value
    : null;
}

/** The explicit switches of an admin. An id in neither list follows DEFAULT_ENABLED_BLUEPRINTS. */
export interface ImageAllowList {
  readonly on: readonly string[];
  readonly off: readonly string[];
  /** The admin's own minimum bundle power for an image (WPU-G10); it replaces what AWS reported. */
  readonly minPower?: Readonly<Record<string, number>>;
}

export const EMPTY_ALLOW_LIST: ImageAllowList = Object.freeze({ on: [], off: [] });

export function isImageOn(list: ImageAllowList, blueprintId: string): boolean {
  if (list.on.includes(blueprintId)) return true;
  if (list.off.includes(blueprintId)) return false;
  return DEFAULT_ENABLED_BLUEPRINTS.includes(blueprintId);
}

/** An image as the wizard, the order path and the Connect help read it. */
export interface BlueprintOption {
  readonly id: string;
  readonly name: string;
  readonly kind: BlueprintKind;
  readonly version: string | null;
  readonly loginUser: string | null;
  /** What AWS reported as the least bundle power; null when unknown (see minPowerOf). */
  readonly minPower: number | null;
}

/**
 * The least bundle power an image needs: the admin's override, else what AWS reported, else the default
 * (an app: DEFAULT_APP_MIN_POWER, an OS-only image: 0).
 */
export function minPowerOf(
  option: Pick<BlueprintOption, "id" | "kind" | "minPower">,
  list: ImageAllowList,
): number {
  const override = list.minPower !== undefined ? list.minPower[option.id] : undefined;
  if (override !== undefined) return powerOrNull(override) ?? DEFAULT_APP_MIN_POWER;
  if (option.minPower !== null) return option.minPower;
  return option.kind === "app" ? DEFAULT_APP_MIN_POWER : 0;
}

/**
 * True when a plan can run the image. A minimum of 0 fits every plan; a plan whose power is unknown
 * does not fit an image that has a minimum (R16).
 */
export function planFitsImage(minPower: number, planPower: number | null): boolean {
  if (minPower <= 0) return true;
  return planPower !== null && planPower >= minPower;
}

/** A synced row (family `blueprint`) as the repositories hand it over. */
export interface BlueprintCatalogRow {
  readonly awsId: string;
  readonly specs: unknown;
}

/** The option of a synced row, or null when its specs are not what the sync writes (fail closed). */
export function optionOf(row: BlueprintCatalogRow): BlueprintOption | null {
  if (!isBlueprintId(row.awsId)) return null;
  const s = row.specs;
  if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
  const specs = s as Record<string, unknown>;
  if (specs.kind !== "app" && specs.kind !== "os") return null;
  return {
    id: row.awsId,
    name: typeof specs.name === "string" && specs.name !== "" ? specs.name : row.awsId,
    kind: specs.kind,
    version: typeof specs.version === "string" ? specs.version : null,
    loginUser: typeof specs.loginUser === "string" ? specs.loginUser : loginUserOf(row.awsId),
    minPower: powerOrNull(specs.minPower),
  };
}

/** The images to offer: active rows whose switch is on, as options. */
export function offeredImages(
  rows: readonly BlueprintCatalogRow[],
  list: ImageAllowList,
): BlueprintOption[] {
  const out: BlueprintOption[] = [];
  for (const row of rows) {
    const option = optionOf(row);
    if (option !== null && isImageOn(list, option.id)) out.push(option);
  }
  return out;
}

// The logos the theme ships under /theme/assets/apps/ (16.3). An image without one gets the generic icon.
const LOGOS: readonly (readonly [string, string])[] = [
  ["ubuntu", "ubuntu"],
  ["debian", "debian"],
  ["centos", "centos"],
  ["freebsd", "freebsd"],
  ["openbsd", "openbsd"],
  ["fedora", "fedora"],
  ["wordpress", "wordpress"],
  ["lamp", "lamp"],
  ["lemp", "lemp"],
  ["joomla", "joomla"],
  ["magento", "magento"],
  ["drupal", "drupal"],
  ["gitlab", "gitlab"],
  ["prestashop", "prestashop"],
  ["plesk", "plesk"],
  ["cpanel", "cpanel"],
  ["nextcloud", "nextcloud"],
  ["owncloud", "owncloud"],
  ["openvpn", "openvpn"],
  ["mediawiki", "mediawiki"],
  ["docker", "docker"],
  ["webmin", "webmin"],
];

/** The file name (without .svg) of the logo of an image, or null for the generic icon. */
export function imageLogoOf(blueprintId: unknown): string | null {
  if (!isBlueprintId(blueprintId)) return null;
  for (const [prefix, logo] of LOGOS) if (blueprintId.startsWith(prefix)) return logo;
  return null;
}

export interface BlueprintGroups {
  readonly apps: readonly BlueprintOption[];
  readonly os: readonly BlueprintOption[];
}

const byName = (a: BlueprintOption, b: BlueprintOption): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** "Apps + OS" and "OS only", each sorted by name. */
export function groupBlueprints(options: readonly BlueprintOption[]): BlueprintGroups {
  return {
    apps: options.filter((o) => o.kind === "app").sort(byName),
    os: options.filter((o) => o.kind === "os").sort(byName),
  };
}
