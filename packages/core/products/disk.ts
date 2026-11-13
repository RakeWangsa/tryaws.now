import type { CatalogProduct } from "@tc/db";
import type { CapacityNeed } from "../capacity/types";
import type { ProductFacts } from "../orders/gates";
import { isPositiveDecimal } from "../pricing/index";
import type { Result } from "../types";
import type { ResolvedProduct } from "./instance";

// 16.10 Storage: `addDisk`. A disk is sold by the GB: the catalog holds one `disk` anchor row per
// Region (migration 0008) whose price is the AWS price of one GB-month, and the order's size is the
// quantity. The price of the order is the pricing engine's `quote` of that price times the size
// (R4); nothing here multiplies money.

/**
 * Lightsail block storage: 8 GB to 16,000 GB per disk (the Lightsail quotas page,
 * https://docs.aws.amazon.com/general/latest/gr/lightsail.html; the limits of the disk adapter in packages/aws).
 */
export const MIN_DISK_GB = 8;
export const MAX_DISK_GB = 16_000;

/** The only `aws_id` of the anchor row. The catalog sync never writes the family `disk`. */
export const DISK_ANCHOR_AWS_ID = "block-storage-gb";

/** The states of a server a disk can be added for: the ones the attach step accepts. */
const SERVER_STATES: readonly string[] = ["active", "stopped"];

export interface DiskOrderConfig {
  readonly productId: string;
  readonly region: string;
  /** Stored and shown only. It never becomes an AWS name, a tag or markup (R11). */
  readonly displayName: string;
  readonly sizeGb: number;
  /** The customer's Linux server the disk is added for; checked by checkDiskServer before it counts. */
  readonly serverId?: string;
  /**
   * WPU-B5: start from a snapshot (a backup row) of a disk of the customer. A restored disk is made
   * unattached and has no `serverId`; attaching it is the existing attach_disk action. Checked by
   * checkDiskSnapshotRestore before it counts.
   */
  readonly restoreFromBackupId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const DISPLAY_NAME = /^[A-Za-z0-9 ._-]{1,60}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hand-written, collects every invalid field. Unknown keys, `capacityReservation` and `awsName` are
 * dropped, never copied: the result holds the five known fields only. The size is an integer number;
 * the form's text is turned into one by the action before it gets here.
 */
export function parseDiskConfig(raw: unknown): Result<DiskOrderConfig> {
  const input = isRecord(raw) ? raw : {};
  const fields: Record<string, string> = {};
  const { productId, region, displayName, sizeGb, serverId, restoreFromBackupId } = input;
  const restoring = restoreFromBackupId !== undefined && restoreFromBackupId !== null;
  if (typeof productId !== "string" || !UUID.test(productId)) fields.productId = "invalid";
  if (typeof region !== "string" || !REGION.test(region)) fields.region = "invalid";
  if (typeof displayName !== "string" || !DISPLAY_NAME.test(displayName)) {
    fields.displayName = "invalid";
  }
  if (
    typeof sizeGb !== "number" ||
    !Number.isInteger(sizeGb) ||
    sizeGb < MIN_DISK_GB ||
    sizeGb > MAX_DISK_GB
  ) {
    fields.sizeGb = "invalid";
  }
  if (restoring) {
    // A restored disk is not made for a server: both at once is a mistake of the caller (R16).
    if (typeof restoreFromBackupId !== "string" || !UUID.test(restoreFromBackupId)) {
      fields.restoreFromBackupId = "invalid";
    }
    if (serverId !== undefined && serverId !== null) fields.serverId = "invalid";
  } else if (typeof serverId !== "string" || !UUID.test(serverId)) {
    fields.serverId = "invalid";
  }
  if (Object.keys(fields).length > 0) return { ok: false, error: "validation", fields };
  return {
    ok: true,
    value: {
      productId: productId as string,
      region: region as string,
      displayName: displayName as string,
      sizeGb: sizeGb as number,
      ...(restoring
        ? { restoreFromBackupId: restoreFromBackupId as string }
        : { serverId: serverId as string }),
    },
  };
}

function unavailable(): Result<never> {
  return { ok: false, error: "validation", fields: { productId: "unavailable" } };
}

export interface ResolvedDisk extends ResolvedProduct {
  readonly family: "disk";
  readonly quantity: string;
  /** Set for a disk from a snapshot; the `create` operation carries it to the adapter. */
  readonly restoreFromBackupId?: string;
}

/**
 * Turns a validated config and the anchor row of its Region into what the purchase needs. The row
 * must be the active `disk` anchor of the Region, priced per GB-month and above zero: any other row,
 * and any surprise, is `unavailable` (R16). Capacity is the size in GB of the quota `disk_gb`.
 */
export function resolveDisk(
  config: DiskOrderConfig,
  product: CatalogProduct,
): Result<ResolvedDisk> {
  if (
    product.id !== config.productId ||
    product.family !== "disk" ||
    product.awsId !== DISK_ANCHOR_AWS_ID ||
    !product.active ||
    product.region !== config.region ||
    product.billingUnit !== "gb_month" ||
    !isPositiveDecimal(product.awsPriceUsd)
  ) {
    return unavailable();
  }
  const facts: ProductFacts = { bundleUsd: product.awsPriceUsd, windows: false, staticIps: 0 };
  const needs: readonly CapacityNeed[] = [{ quotaCode: "disk_gb", amount: config.sizeGb }];
  return {
    ok: true,
    value: {
      family: "disk",
      productId: product.id,
      region: product.region,
      featureFlag: product.featureFlag,
      awsPriceUsd: product.awsPriceUsd,
      quantity: String(config.sizeGb),
      facts,
      needs,
      resourceConfig: {
        productId: config.productId,
        region: config.region,
        displayName: config.displayName,
        sizeGb: config.sizeGb,
        ...(config.serverId === undefined ? {} : { serverId: config.serverId }),
        // The signed draft carries the resource config and the purchase parses it again.
        ...(config.restoreFromBackupId === undefined
          ? {}
          : { restoreFromBackupId: config.restoreFromBackupId }),
      },
      ...(config.restoreFromBackupId === undefined
        ? {}
        : { restoreFromBackupId: config.restoreFromBackupId }),
    },
  };
}

/** The few fields of the server row that the rule needs; the caller read it for the customer's scope. */
export interface DiskServerCandidate {
  readonly id: string;
  readonly family: string;
  readonly state: string;
  readonly region: string;
}

/**
 * Pure rule of addDisk: the server is the customer's own Linux server, `active` or `stopped`, in the
 * Region of the disk (a disk lives in the zone of its server). `null` is a missing server and another
 * customer's alike, because the tenant-scoped read answers both with `null` (R8).
 */
export function checkDiskServer(input: {
  readonly requested: string;
  readonly region: string;
  readonly server: DiskServerCandidate | null;
}): Result<string> {
  const { server } = input;
  if (
    server === null ||
    server.id !== input.requested ||
    server.family !== "linux_instance" ||
    !SERVER_STATES.includes(server.state)
  ) {
    return { ok: false, error: "validation", fields: { serverId: "invalid" } };
  }
  if (server.region !== input.region) {
    return { ok: false, error: "validation", fields: { region: "invalid" } };
  }
  return { ok: true, value: server.id };
}
