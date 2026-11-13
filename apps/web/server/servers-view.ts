import type { CustomerSession } from "@tc/auth";
import {
  DEFAULT_BLUEPRINT_ID,
  EMPTY_ALLOW_LIST,
  imageLogoOf,
  isBlueprintId,
  loginUserOf,
  storedLoginUserOf,
  minPowerOf,
  offeredImages,
  optionOf,
  priceCatalog,
  type BlueprintKind,
} from "@tc/core";
import type { SshKey } from "@tc/db";
import {
  customerRepos,
  listActiveImages,
  listCatalogProducts,
  readCatalogProduct,
  readFeatureFlag,
  readImage,
  readImageSwitches,
  withTx,
} from "@tc/db";
import type { ResourceSummary } from "@tc/db";

// What the server screens show, read through the repositories of the session's customer (R8). A
// database error is thrown, never answered with an empty list (R16). Nothing here returns an AWS
// account id, an ARN, a generated AWS name or an error text of AWS (U6, R11): the resource config is
// read field by field.

const FLAG = "linux_instance";
const FAMILY = "linux_instance";
const WINDOWS_FAMILY = "windows_instance";

export interface PlanSpecs {
  vcpus?: number;
  ramGb?: string;
  diskGb?: number;
  transferGb?: number;
}

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The sizes of a plan from the catalog specs; a value that is not a plain size is dropped. */
export function planSpecsOf(specs: unknown): PlanSpecs {
  const out: PlanSpecs = {};
  if (typeof specs !== "object" || specs === null) return out;
  const raw = specs as Record<string, unknown>;
  if (isCount(raw["vcpus"]) && raw["vcpus"] > 0) out.vcpus = raw["vcpus"];
  if (typeof raw["ramGb"] === "string" && /^\d{1,4}(\.\d{1,2})?$/.test(raw["ramGb"])) {
    out.ramGb = raw["ramGb"];
  }
  if (isCount(raw["diskGb"])) out.diskGb = raw["diskGb"];
  if (isCount(raw["transferGb"])) out.transferGb = raw["transferGb"];
  return out;
}

/** The bundle power of a plan from the catalog specs; null when it is not a whole number (WPU-G10). */
export function powerOf(specs: unknown): number | null {
  const power =
    typeof specs === "object" && specs !== null
      ? (specs as Record<string, unknown>)["power"]
      : undefined;
  return isCount(power) ? power : null;
}

export interface ServerConfig {
  displayName: string;
  keyPairId: string | null;
  publicIp: string | null;
  /** WPU-G3: the image the server was ordered with; null for an older server (the default image). */
  blueprintId: string | null;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function serverConfigOf(config: unknown): ServerConfig {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const name = raw["displayName"];
  const key = raw["keyPairId"];
  const ip = raw["publicIpv4"];
  const blueprint = raw["blueprintId"];
  return {
    blueprintId: isBlueprintId(blueprint) ? blueprint : null,
    displayName: typeof name === "string" ? name.slice(0, 60) : "",
    keyPairId: typeof key === "string" && key !== "" ? key : null,
    publicIp: typeof ip === "string" && IPV4.test(ip) ? ip : null,
  };
}

export type OrderProgress = "paid" | "creating" | "ready" | "delayed" | "failed";

/** 16.11 step 6: the state of the create operation, as words for the customer. */
export function orderProgress(operationState: string | null): OrderProgress {
  switch (operationState) {
    case null:
      return "paid";
    case "queued":
    case "running":
    case "waiting":
      return "creating";
    case "succeeded":
      return "ready";
    case "failed":
      return "failed";
    default:
      // needs_attention, needs_approval and any state this screen does not know: "delayed".
      return "delayed";
  }
}

/** 16.11 step 4: the shortfall rounded up to whole taka (integers only, R4); null when covered. */
export function shortfallTopUpTaka(totalMinor: bigint, balanceMinor: bigint): bigint | null {
  if (balanceMinor >= totalMinor) return null;
  return (totalMinor - balanceMinor + 99n) / 100n;
}

export interface PlanOption {
  id: string;
  region: string;
  priceMinor: bigint;
  specs: PlanSpecs;
  /** WPU-G10: the bundle power (the unit of an image's minimum); absent or null when unknown. */
  power?: number | null;
}
export interface KeyOption {
  id: string;
  name: string;
  fingerprint: string;
}

/** An image the customer can pick in a Region (WPU-G3), with the logo file of the theme or null. */
export interface ImageOption {
  id: string;
  name: string;
  kind: BlueprintKind;
  version: string | null;
  loginUser: string | null;
  logo: string | null;
  /** WPU-G10: the least bundle power the image needs (admin override, AWS value or the default); absent is 0. */
  minPower?: number;
}

export type ConfiguratorScreen =
  | { state: "flag_off" }
  | { state: "kyc_required" }
  | {
      state: "ready";
      plans: PlanOption[];
      regions: string[];
      keys: KeyOption[];
      /** The offered images of each Region of `regions` (active at AWS and switched on by an admin). */
      images: Record<string, ImageOption[]>;
    };

export async function loadConfigurator(
  session: CustomerSession,
  now: () => Date,
): Promise<ConfiguratorScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("servers: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    if (profile.kycStatus !== "verified") return { state: "kyc_required" };

    const rows = (await listCatalogProducts(tx, FAMILY)).filter((r) => r.platform === "linux");
    const priced = await priceCatalog(tx, rows, { market: profile.market }, { now });
    // No rate or rule in force: nothing is priced and nothing is offered (R16).
    if (!priced.ok) throw new Error("servers: the catalog could not be priced");
    const plans: PlanOption[] = priced.value.map((row) => ({
      id: row.id,
      region: row.region,
      priceMinor: row.priceBdt.totalMinor,
      specs: planSpecsOf(row.specs),
      power: powerOf(row.specs),
    }));
    const keys = await repos.sshKeys.list();
    const regions = [...new Set(plans.map((plan) => plan.region))];
    // WPU-G3. A stored allow-list that does not parse offers nothing (R16); one that was never saved
    // follows the default list.
    const stored = await readImageSwitches(tx, profile.market);
    const switches =
      stored.state === "ok" ? stored.switches : stored.state === "none" ? EMPTY_ALLOW_LIST : null;
    const images: Record<string, ImageOption[]> = {};
    for (const region of regions) {
      const rows = switches === null ? [] : await listActiveImages(tx, region);
      images[region] = (switches === null ? [] : offeredImages(rows, switches)).map((o) => ({
        id: o.id,
        name: o.name,
        kind: o.kind,
        version: o.version,
        loginUser: o.loginUser,
        logo: imageLogoOf(o.id),
        minPower: switches === null ? 0 : minPowerOf(o, switches),
      }));
    }
    return {
      state: "ready",
      plans,
      regions,
      keys: keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint })),
      images,
    };
  });
}

export interface ServerRow {
  id: string;
  name: string;
  region: string | null;
  state: ResourceSummary["state"];
  publicIp: string | null;
  specs: PlanSpecs;
}

export type ServersScreen = { state: "flag_off" } | { state: "ready"; servers: ServerRow[] };

export async function loadServers(session: CustomerSession): Promise<ServersScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("servers: no customer row");
    const linuxOn = (await readFeatureFlag(tx, FLAG, profile.market)) === true;
    const windowsOn = (await readFeatureFlag(tx, WINDOWS_FAMILY, profile.market)) === true;
    if (!linuxOn && !windowsOn) return { state: "flag_off" };
    const [resources, linuxCatalog, windowsCatalog] = await Promise.all([
      repos.resources.list(),
      listCatalogProducts(tx, FAMILY),
      listCatalogProducts(tx, WINDOWS_FAMILY),
    ]);
    const specsOf = new Map(
      [...linuxCatalog, ...windowsCatalog].map((row) => [row.id, planSpecsOf(row.specs)]),
    );
    // Each family is listed only while its own flag is on (R12).
    const shown = (family: string): boolean =>
      (family === FAMILY && linuxOn) || (family === WINDOWS_FAMILY && windowsOn);
    const servers = resources
      .filter((r) => shown(r.family) && r.state !== "destroyed")
      .map((r): ServerRow => {
        const config = serverConfigOf(r.config);
        return {
          id: r.id,
          name: config.displayName,
          region: r.region,
          state: r.state,
          publicIp: config.publicIp,
          specs: (r.productId !== null ? specsOf.get(r.productId) : undefined) ?? {},
        };
      });
    return { state: "ready", servers };
  });
}

export interface ServerDetail extends ServerRow {
  family: "linux_instance" | "windows_instance";
  keyName: string | null;
  /** WPU-G13: the image the server runs and the user to log in with (null for Windows or unknown). */
  imageName: string | null;
  loginUser: string | null;
  createdAt: Date;
}

export async function loadServerDetail(
  session: CustomerSession,
  id: string,
): Promise<ServerDetail | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null) return null;
    const family = resource.family;
    if (family !== FAMILY && family !== WINDOWS_FAMILY) return null;
    if (family === WINDOWS_FAMILY) {
      // R12, R16: a Windows server is shown only while its family flag is on; else it answers
      // like a missing one.
      const profile = await repos.profile.get();
      if (profile === null) throw new Error("servers: no customer row");
      if ((await readFeatureFlag(tx, WINDOWS_FAMILY, profile.market)) !== true) return null;
    }
    const config = serverConfigOf(resource.config);
    const [product, key] = await Promise.all([
      resource.productId !== null ? readCatalogProduct(tx, resource.productId) : null,
      config.keyPairId !== null ? repos.sshKeys.get(config.keyPairId) : null,
    ]);
    // The image of the server: the one ordered, else the default one. Its row (any switch) gives the
    // name and the login user; the table of user names covers a row that is gone. Public catalog data.
    const imageId = family === WINDOWS_FAMILY ? null : (config.blueprintId ?? DEFAULT_BLUEPRINT_ID);
    const imageRow =
      imageId === null || resource.region === null
        ? null
        : await readImage(tx, resource.region, imageId);
    const option = imageRow === null ? null : optionOf(imageRow);
    return {
      id: resource.id,
      family,
      name: config.displayName,
      region: resource.region,
      state: resource.state,
      publicIp: config.publicIp,
      specs: product === null ? {} : planSpecsOf(product.specs),
      keyName: family === WINDOWS_FAMILY ? null : (key?.name ?? null),
      imageName: option?.name ?? null,
      // WPU-Z19: the user GetInstance reported (stored at create) first, then the synced row, then the table.
      loginUser:
        imageId === null
          ? null
          : (storedLoginUserOf(resource.config) ?? option?.loginUser ?? loginUserOf(imageId)),
      createdAt: resource.createdAt,
    };
  });
}

export interface OrderScreen {
  id: string;
  totalMinor: bigint;
  createdAt: Date;
  progress: OrderProgress;
  resourceId: string | null;
  serverName: string;
  /** The product family of the first item, so a page can link to the right screen (WP7-T2). */
  family?: string;
  /** WPU-B3: the automatic reversal of a failed create is posted (the order is `reversed`). */
  refunded?: boolean;
}

export async function loadOrder(session: CustomerSession, id: string): Promise<OrderScreen | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const order = await repos.orders.get(id);
    if (order === null) return null;
    const first = Array.isArray(order.items) ? (order.items[0] as unknown) : undefined;
    const family =
      typeof first === "object" &&
      first !== null &&
      typeof (first as { family?: unknown }).family === "string"
        ? (first as { family: string }).family
        : undefined;
    const resourceId =
      typeof first === "object" &&
      first !== null &&
      typeof (first as { resourceId?: unknown }).resourceId === "string"
        ? (first as { resourceId: string }).resourceId
        : null;
    const resource = resourceId === null ? null : await repos.resources.get(resourceId);
    const operations = resource === null ? [] : await repos.operations.listForResource(resource.id);
    const create = operations.filter((op) => op.kind === "create").at(-1) ?? null;
    return {
      id: order.id,
      totalMinor: order.totalMinor,
      createdAt: order.createdAt,
      progress: orderProgress(create?.state ?? null),
      resourceId: resource?.id ?? null,
      serverName: resource === null ? "" : serverConfigOf(resource.config).displayName,
      refunded: order.status === "reversed",
      ...(family !== undefined ? { family } : {}),
    };
  });
}

export type SshKeysScreen = { state: "flag_off" } | { state: "ready"; keys: SshKey[] };

export async function loadSshKeys(session: CustomerSession): Promise<SshKeysScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("servers: no customer row");
    // Keys are only used by servers: the flag of the family decides (R12).
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    return { state: "ready", keys: await repos.sshKeys.list() };
  });
}
