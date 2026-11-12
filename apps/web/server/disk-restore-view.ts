import type { CustomerSession } from "@tc/auth";
import {
  DISK_ANCHOR_AWS_ID,
  MAX_DISK_GB,
  MIN_DISK_GB,
  isPositiveDecimal,
  priceCatalog,
} from "@tc/core";
import {
  customerRepos,
  listCatalogProducts,
  readConfigPrices,
  readFeatureFlag,
  withTx,
} from "@tc/db";
import type { CatalogProduct, ResourceSummary } from "@tc/db";
import { resourceFacts } from "./extras-actions.ts";

// What /servers/disk-restore shows: the snapshots of the customer's own disks that a NEW disk can be
// made from (WPU-X2, the form of restoreDiskAction). Read through the repositories of the session's
// customer only (R8); behind the flag `disk` (R12, R16: a flag that is off or unreadable shows the
// flag-off state). The price is the per-GB price from the pricing engine in paisa as bigint (R4); the
// total for a size is shown on the review page. Nothing here returns an AWS account id, an ARN or a
// generated AWS name, and the name the customer typed is only text (R11, U6).

const FLAG = "disk";

export interface DiskRestoreOption {
  /** The id of the snapshot row (the form posts it as restoreFromBackupId). */
  snapshotId: string;
  /** The name the customer gave it (text); empty when the snapshot has none. */
  name: string;
  /** The name of the disk it was taken from; empty when unknown. */
  sourceName: string;
  /** The source disk is destroyed (a final snapshot): the snapshot still restores. */
  sourceDestroyed: boolean;
  region: string;
  /** The new disk may not be smaller than the source disk (Lightsail refuses a smaller one). */
  minGb: number;
  maxGb: number;
  /** The anchor row of the Region (the product of the order). */
  productId: string;
  /** Paisa for one GB-month. */
  perGbMinor: bigint;
  createdAt: Date;
}

export type DiskRestoreScreen =
  { state: "flag_off" } | { state: "ready"; options: DiskRestoreOption[] };

/**
 * The options: an `active` snapshot that is the child of a disk of the customer (the disk may be
 * destroyed already) with a known size, in a Region where the disk anchor row is on sale and priced.
 * Anything else is left out (R16), as the order code would refuse it anyway.
 */
export function diskRestoreOptionsOf(input: {
  rows: readonly ResourceSummary[];
  anchors: ReadonlyMap<string, { productId: string; perGbMinor: bigint }>;
}): DiskRestoreOption[] {
  const disks = new Map(input.rows.filter((r) => r.family === "disk").map((r) => [r.id, r]));
  const out: DiskRestoreOption[] = [];
  for (const row of input.rows) {
    if (row.family !== "backup" || row.state !== "active" || row.parentResourceId === null)
      continue;
    const source = disks.get(row.parentResourceId);
    if (source === undefined || row.region === null || source.region !== row.region) continue;
    const anchor = input.anchors.get(row.region);
    const sourceFacts = resourceFacts(source);
    const minGb = sourceFacts.sizeGb ?? 0;
    if (anchor === undefined || minGb < MIN_DISK_GB || minGb > MAX_DISK_GB) continue;
    out.push({
      snapshotId: row.id,
      name: resourceFacts(row).name,
      sourceName: sourceFacts.name,
      sourceDestroyed: source.state === "destroyed",
      region: row.region,
      minGb,
      maxGb: MAX_DISK_GB,
      productId: anchor.productId,
      perGbMinor: anchor.perGbMinor,
      createdAt: row.createdAt,
    });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The anchor rows of the disk family that are on sale (the same test as resolveDisk). */
export function diskAnchorRows(rows: readonly CatalogProduct[]): CatalogProduct[] {
  return rows.filter(
    (r) =>
      r.family === "disk" &&
      r.awsId === DISK_ANCHOR_AWS_ID &&
      r.active &&
      r.billingUnit === "gb_month" &&
      isPositiveDecimal(r.awsPriceUsd),
  );
}

export async function loadDiskRestore(
  session: CustomerSession,
  now: () => Date = () => new Date(),
): Promise<DiskRestoreScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("disk restore: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    const rows = await repos.resources.list();
    const anchorRows = diskAnchorRows(await listCatalogProducts(tx, FLAG));
    // The config price of the market, when it has a usable one, prices a new disk like the order does.
    const instant = now();
    const config = (await readConfigPrices(tx, profile.market, instant))[
      "config_price.block_storage_gb_month"
    ];
    const configUsd =
      config !== undefined && config.unit === "gb_month" && isPositiveDecimal(config.usd)
        ? config.usd
        : undefined;
    const anchors = new Map<string, { productId: string; perGbMinor: bigint }>();
    if (anchorRows.length > 0) {
      const priced = await priceCatalog(
        tx,
        anchorRows.map((r) => (configUsd === undefined ? r : { ...r, awsPriceUsd: configUsd })),
        { market: profile.market },
        { now: () => instant },
      );
      // No rate or rule in force: nothing is priced and nothing is offered (R16).
      if (priced.ok) {
        for (const row of priced.value) {
          if (row.priceBdt.totalMinor > 0n) {
            anchors.set(row.region, { productId: row.id, perGbMinor: row.priceBdt.totalMinor });
          }
        }
      }
    }
    return { state: "ready", options: diskRestoreOptionsOf({ rows, anchors }) };
  });
}
