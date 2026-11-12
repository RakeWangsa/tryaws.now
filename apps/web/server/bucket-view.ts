import type { CustomerSession } from "@tc/auth";
import { awsResourceName, decideDestructive, priceCatalog } from "@tc/core";
import { customerRepos, listCatalogProducts, readFeatureFlag, withTx } from "@tc/db";
import type { CustomerOperation, ResourceSummary } from "@tc/db";

// What the object storage screens show, read through the repositories of the session's customer (R8).
// A database error is thrown, never answered with an empty list (R16). The resource config is read
// field by field. Nothing here returns an AWS account id, an ARN or an error text of AWS (U6). One
// name is shown on purpose: the bucket name, because it is part of the bucket address (U6); it is
// the generated name of R11, a pure function of the resource id, never the text the customer typed.

import { bucketVersioningOf } from "./console-view.ts";
const FLAG = "bucket";
const FAMILY = "bucket";
const REGION = /^[a-z]{2}-[a-z]+-\d$/;

export type AccessMode = "private" | "public";

export interface BucketFacts {
  name: string;
  /** The generated bucket name (U6 exception). null when the id is not a platform id. */
  bucketName: string | null;
  /** https://<bucket name>.s3.<region>.amazonaws.com, built from the two checked parts. VERIFY. */
  address: string | null;
  /** null: the current mode is not stored where the web tier can read it (JOURNEY, WP6-T4s). */
  accessMode: AccessMode | null;
}

export function bucketNameOf(id: string): string | null {
  try {
    return awsResourceName("bucket", id);
  } catch {
    return null;
  }
}

export function bucketConfigOf(id: string, region: string | null, config: unknown): BucketFacts {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const name = raw["displayName"];
  const bucketName = bucketNameOf(id);
  const mode = raw["accessMode"];
  return {
    name: typeof name === "string" ? name.slice(0, 60) : "",
    bucketName,
    address:
      bucketName !== null && region !== null && REGION.test(region)
        ? `https://${bucketName}.s3.${region}.amazonaws.com`
        : null,
    accessMode: mode === "public" ? "public" : mode === "private" ? "private" : null,
  };
}

export interface BucketPlanOption {
  id: string;
  region: string;
  priceMinor: bigint;
  storageGb?: number;
  transferGb?: number;
}

export type BucketConfiguratorScreen =
  { state: "flag_off" } | { state: "kyc_required" } | { state: "ready"; plans: BucketPlanOption[] };

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export async function loadBucketConfigurator(
  session: CustomerSession,
  now: () => Date,
): Promise<BucketConfiguratorScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("bucket: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    if (profile.kycStatus !== "verified") return { state: "kyc_required" };

    const rows = await listCatalogProducts(tx, FAMILY);
    const priced = await priceCatalog(tx, rows, { market: profile.market }, { now });
    // No rate or rule in force: nothing is priced and nothing is offered (R16).
    if (!priced.ok) throw new Error("bucket: the catalog could not be priced");
    const plans: BucketPlanOption[] = priced.value.map((row) => {
      const specs =
        typeof row.specs === "object" && row.specs !== null
          ? (row.specs as Record<string, unknown>)
          : {};
      const storageGb = positiveInt(specs["storageGb"]);
      const transferGb = positiveInt(specs["transferGb"]);
      return {
        id: row.id,
        region: row.region,
        priceMinor: row.priceBdt.totalMinor,
        ...(storageGb !== undefined ? { storageGb } : {}),
        ...(transferGb !== undefined ? { transferGb } : {}),
      };
    });
    return { state: "ready", plans };
  });
}

export interface BucketRow {
  id: string;
  name: string;
  bucketName: string | null;
  region: string | null;
  state: ResourceSummary["state"];
}

export type BucketListScreen = { state: "flag_off" } | { state: "ready"; items: BucketRow[] };

export async function loadBucketList(session: CustomerSession): Promise<BucketListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("bucket: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return { state: "flag_off" };
    const resources = await repos.resources.list();
    const items = resources
      .filter((r) => r.family === FAMILY && r.state !== "destroyed")
      .map((r): BucketRow => {
        const facts = bucketConfigOf(r.id, r.region, r.config);
        return {
          id: r.id,
          name: facts.name,
          bucketName: facts.bucketName,
          region: r.region,
          state: r.state,
        };
      });
    return { state: "ready", items };
  });
}

export interface BucketDetail extends BucketRow {
  /** Versioning as the adapter last set it; null while unknown (WPU-G7). */
  versioning?: "Enabled" | "Suspended" | null;
  address: string | null;
  accessMode: AccessMode | null;
  createdAt: Date;
  /** What the lifecycle guard says about a destroy of this family today (R13); false: not open. */
  destroyOpen: boolean;
  /** The last access and key requests, newest first: state and date only. */
  requests: { id: string; kind: "access" | "key"; state: string; createdAt: Date }[];
}

const REQUEST_KIND: Readonly<Record<string, "access" | "key" | undefined>> = {
  set_bucket_access: "access",
  delete_access_key: "key",
};

export function requestsOf(operations: readonly CustomerOperation[]): BucketDetail["requests"] {
  const out: BucketDetail["requests"] = [];
  for (const op of operations) {
    const kind = REQUEST_KIND[op.kind];
    if (kind === undefined) continue;
    out.push({ id: op.id, kind, state: op.state, createdAt: op.createdAt });
    if (out.length === 5) break;
  }
  return out;
}

/** The destroy rule of the guard for this family, today (pure; the page asks instead of guessing). */
export function bucketDestroyOpen(): boolean {
  return decideDestructive("destroy", {
    subscriptionStatus: "retained",
    family: FAMILY,
    hasFinalSnapshot: false,
    isFinalBackup: false,
  });
}

export async function loadBucketDetail(
  session: CustomerSession,
  id: string,
): Promise<BucketDetail | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    // null for a missing row and for another customer's row alike (R8).
    const resource = await repos.resources.get(id);
    if (resource === null || resource.family !== FAMILY) return null;
    // R12, R16: with the flag off the page answers like a missing one.
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("bucket: no customer row");
    if ((await readFeatureFlag(tx, FLAG, profile.market)) !== true) return null;
    const facts = bucketConfigOf(resource.id, resource.region, resource.config);
    const operations = await repos.operations.listForResource(resource.id);
    return {
      id: resource.id,
      name: facts.name,
      bucketName: facts.bucketName,
      region: resource.region,
      state: resource.state,
      address: facts.address,
      accessMode: facts.accessMode,
      versioning: bucketVersioningOf(resource.config),
      createdAt: resource.createdAt,
      destroyOpen: bucketDestroyOpen(),
      requests: requestsOf(operations),
    };
  });
}
