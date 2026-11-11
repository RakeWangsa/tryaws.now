import { and, eq } from "drizzle-orm";
import type { Tx } from "../client";
import { isUuid } from "../repositories/scope";
import { adminUsers } from "../schema/admins";
import { poolAccounts, resources } from "../schema/provisioning";
import { loadOwnedResource, type ResourceRow } from "./run";

// The identity of a live read (F: `{ customerId }` or `{ adminId }`). It comes from the verified
// invocation of the web or admin tier, never from a request body.
export type ReadCaller = { readonly customerId: string } | { readonly adminId: string };

// What the reader needs to call AWS for one resource: the placement, and nothing else of the pool
// account (no role ARN, no name).
export interface ReadTarget {
  readonly resource: ResourceRow;
  readonly account: { readonly awsAccountId: string; readonly externalId: string };
  readonly region: string;
}

// The reader's own tenant check (R8, R16), in the statement that finds the row. null for a missing
// resource, another customer's resource, an id that is not a UUID, a resource that is not placed in a
// pool account, a disabled or unknown admin and a caller that holds both identities or neither: the
// answers are the same, so the fact that a resource exists does not leak.
export async function loadReadTarget(
  tx: Tx,
  caller: ReadCaller,
  resourceId: string,
): Promise<ReadTarget | null> {
  if (typeof resourceId !== "string" || !isUuid(resourceId)) return null;
  const c = caller as { customerId?: unknown; adminId?: unknown } | null;
  const hasCustomer = c !== null && typeof c === "object" && c.customerId !== undefined;
  const hasAdmin = c !== null && typeof c === "object" && c.adminId !== undefined;
  if (hasCustomer === hasAdmin) return null;

  let resource: ResourceRow | null;
  if (hasCustomer) {
    if (typeof c!.customerId !== "string") return null;
    resource = await loadOwnedResource(tx, c!.customerId, resourceId);
  } else {
    const adminId = c!.adminId;
    if (typeof adminId !== "string" || !isUuid(adminId)) return null;
    const admin = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(and(eq(adminUsers.id, adminId), eq(adminUsers.status, "active")))
      .limit(1);
    if (admin[0] === undefined) return null;
    const rows = await tx.select().from(resources).where(eq(resources.id, resourceId)).limit(1);
    resource = rows[0] ?? null;
  }
  if (resource === null || resource.poolAccountId === null || resource.region === null) {
    return null;
  }

  const pool = await tx
    .select({ awsAccountId: poolAccounts.awsAccountId, externalId: poolAccounts.externalId })
    .from(poolAccounts)
    .where(eq(poolAccounts.id, resource.poolAccountId))
    .limit(1);
  const account = pool[0];
  if (account === undefined) return null;
  return { resource, account, region: resource.region };
}
