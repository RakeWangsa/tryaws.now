import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import { DOMAIN_STATUSES } from "../schema/service";

// WPU-B2: what the provisioner reads and writes on the `domains` row when the operations of a domain end
// (worker_rw has SELECT on domains and UPDATE on route53_operation_id, status, expires_at and
// hosted_zone_id, migration 0006). Both run inside the transaction of the state change, by resource id; a
// resource that is no domain matches no row. @tc/db sits below @tc/core, so the choice of the next status
// (the state machine) is made by the caller; this file only checks the words and writes them with a
// compare-and-set on the status that the caller read (R16: a row that changed in between is not touched).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZONE = /^[A-Z0-9]{1,32}$/;
const OPERATION = /^[A-Za-z0-9-]{1,128}$/;

function requireResource(resourceId: string, who: string): void {
  if (typeof resourceId !== "string" || !UUID.test(resourceId)) {
    throw new TypeError(`${who}: resourceId is not a UUID`);
  }
}

function isStatus(value: unknown): value is (typeof DOMAIN_STATUSES)[number] {
  return typeof value === "string" && (DOMAIN_STATUSES as readonly string[]).includes(value);
}

export interface DomainSyncView {
  readonly status: string;
  /** `resources.config` as the adapter left it. Untrusted shape: the caller reads it field by field. */
  readonly config: unknown;
}

/** The status of the domain row and the config of its resource, or null when the resource is no domain. */
export async function readDomainSyncView(
  tx: Tx,
  resourceId: string,
): Promise<DomainSyncView | null> {
  requireResource(resourceId, "readDomainSyncView");
  const found = await tx.execute(sql`
    select d.status as "status", r.config as "config"
    from domains d join resources r on r.id = d.resource_id
    where d.resource_id = ${resourceId}`);
  const row = found.rows[0] as { status?: unknown; config?: unknown } | undefined;
  if (row === undefined || typeof row.status !== "string") return null;
  return { status: row.status, config: row.config };
}

export interface DomainFacts {
  /** The status the caller read; the update happens only if the row still has it. */
  readonly from: string;
  readonly to: string;
  readonly expiresAt?: Date | null;
  readonly hostedZoneId?: string | null;
  readonly route53OperationId?: string | null;
}

/**
 * Moves the row from `from` to `to` and saves the facts that came with it. A status outside the closed
 * list, a malformed zone id or operation id throws (a programming error, nothing is written); a row that
 * no longer has `from` changes nothing and returns false. A fact that is `undefined` keeps the column.
 */
export async function applyDomainFacts(
  tx: Tx,
  resourceId: string,
  facts: DomainFacts,
): Promise<boolean> {
  requireResource(resourceId, "applyDomainFacts");
  if (!isStatus(facts.from) || !isStatus(facts.to)) {
    throw new TypeError("applyDomainFacts: not a domain status");
  }
  if (facts.expiresAt instanceof Date && Number.isNaN(facts.expiresAt.getTime())) {
    throw new TypeError("applyDomainFacts: expiresAt is not a date");
  }
  if (typeof facts.hostedZoneId === "string" && !ZONE.test(facts.hostedZoneId)) {
    throw new TypeError("applyDomainFacts: hostedZoneId is malformed");
  }
  if (typeof facts.route53OperationId === "string" && !OPERATION.test(facts.route53OperationId)) {
    throw new TypeError("applyDomainFacts: route53OperationId is malformed");
  }
  const expires =
    facts.expiresAt === undefined
      ? sql`expires_at`
      : facts.expiresAt === null
        ? sql`null`
        : sql`${facts.expiresAt.toISOString()}::timestamptz`;
  const zone = facts.hostedZoneId === undefined ? sql`hosted_zone_id` : sql`${facts.hostedZoneId}`;
  const operation =
    facts.route53OperationId === undefined
      ? sql`route53_operation_id`
      : sql`${facts.route53OperationId}`;
  const done = await tx.execute(sql`
    update domains set status = ${facts.to}, expires_at = ${expires},
      hosted_zone_id = ${zone}, route53_operation_id = ${operation}
    where resource_id = ${resourceId} and status = ${facts.from}`);
  return done.rowCount === 1;
}
