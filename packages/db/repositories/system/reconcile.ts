import { sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { DISCREPANCY_KINDS } from "../../schema/service";
import { insertAudit } from "../audit-log";
import { isUuid } from "../scope";

// The statements of the reconciler (WP7-T6), run as worker_rw. System code only: no customer id is read
// from a session, taken as an argument or returned, and every statement names columns that worker_rw
// may read or write (grants.expected.json). It logs nothing. The reconciler reports; it never changes
// `resources` or deletes anything (R5, R13). The one correction it may make, `pool_capacity.used`, goes
// through recomputeUsed (capacity-inventory.ts), and this module writes the audit row of it.

export interface PoolAccountRef {
  readonly id: string;
  readonly awsAccountId: string;
  readonly externalId: string;
}

export interface ResourceRowView {
  readonly id: string;
  readonly family: string;
  readonly region: string | null;
  readonly awsName: string;
  readonly state: string;
  readonly createdAt: Date;
}

export interface CapacityRowView {
  readonly rowId: string;
  readonly region: string;
  readonly quotaCode: string;
  readonly used: number;
  readonly quotaLimit: number;
}

export interface OpenOperationView {
  readonly id: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly nextRunAt: Date;
  readonly createdAt: Date;
}

// The keys of a discrepancy that the reconciler writes. Ids, codes, states and names the platform
// generated (R11); no customer id, no name, no e-mail (R14).
export const RECONCILE_DISCREPANCY_KEYS = [
  "reason",
  "poolAccountId",
  "region",
  "family",
  "awsName",
  "resourceId",
  "dbState",
  "awsState",
  "dayKey",
] as const;

const RECONCILE_KINDS = [
  "orphan",
  "missing",
] as const satisfies readonly (typeof DISCREPANCY_KINDS)[number][];
const VALUE_MAX = 200;
const MAX_OPEN = 1000;

export function reconcileRepo(tx: Tx) {
  return {
    // Active accounts only: a disabled account is not read and not reported.
    async activePoolAccounts(): Promise<PoolAccountRef[]> {
      const { rows } = await tx.execute<{
        id: string;
        aws_account_id: string;
        external_id: string;
      }>(sql`
        select id, aws_account_id, external_id from pool_accounts
         where status = 'active' order by id`);
      return rows.map((r) => ({
        id: r.id,
        awsAccountId: r.aws_account_id,
        externalId: r.external_id,
      }));
    },

    // Every resource of the account that has an AWS name, whatever its state (a destroyed row whose
    // resource is still in AWS is an orphan). No customer id.
    async resourcesOfAccount(poolAccountId: string): Promise<ResourceRowView[]> {
      if (!isUuid(poolAccountId)) throw new TypeError("reconcile: poolAccountId is not a UUID");
      const { rows } = await tx.execute<{
        id: string;
        family: string;
        region: string | null;
        aws_name: string;
        state: string;
        created_at: Date | string;
      }>(sql`
        select id, family, region, aws_name, state, created_at from resources
         where pool_account_id = ${poolAccountId} and aws_name is not null
         order by aws_name`);
      return rows.map((r) => ({
        id: r.id,
        family: r.family,
        region: r.region,
        awsName: r.aws_name,
        state: r.state,
        createdAt: new Date(r.created_at),
      }));
    },

    async capacityRows(poolAccountId: string): Promise<CapacityRowView[]> {
      if (!isUuid(poolAccountId)) throw new TypeError("reconcile: poolAccountId is not a UUID");
      const { rows } = await tx.execute<{
        id: string;
        region: string;
        quota_code: string;
        used: number;
        quota_limit: number;
      }>(sql`
        select id, region, quota_code, used, quota_limit from pool_capacity
         where pool_account_id = ${poolAccountId} order by region, quota_code`);
      return rows.map((r) => ({
        rowId: r.id,
        region: r.region,
        quotaCode: r.quota_code,
        used: r.used,
        quotaLimit: r.quota_limit,
      }));
    },

    // The operations a worker may still move or that wait for attention; needs_approval is a human
    // queue and finished states are not listed.
    async openOperations(limit: number): Promise<OpenOperationView[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OPEN) {
        throw new RangeError("reconcile: limit must be from 1 to 1000");
      }
      const { rows } = await tx.execute<{
        id: string;
        resource_id: string;
        kind: string;
        state: string;
        attempts: number;
        next_run_at: Date | string;
        created_at: Date | string;
      }>(sql`
        select id, resource_id, kind, state, attempts, next_run_at, created_at from operations
         where state in ('queued', 'running', 'waiting', 'needs_attention')
         order by next_run_at, id limit ${limit}`);
      return rows.map((r) => ({
        id: r.id,
        resourceId: r.resource_id,
        kind: r.kind,
        state: r.state,
        attempts: r.attempts,
        nextRunAt: new Date(r.next_run_at),
        createdAt: new Date(r.created_at),
      }));
    },

    // One discrepancy row under a caller-made id (findingId: day, kind and subject). The second write
    // of the same id adds nothing and returns false (R7). The keys are fixed and the values are short
    // scalars; anything else is a TypeError and nothing is written (R14, R16).
    async recordFinding(
      id: string,
      kind: string,
      details: Record<string, string | null>,
    ): Promise<boolean> {
      if (!isUuid(id)) throw new TypeError("reconcile: the finding id is not a UUID");
      if (!(RECONCILE_KINDS as readonly string[]).includes(kind)) {
        throw new TypeError("reconcile: the kind of a finding is orphan or missing");
      }
      const keys = Object.keys(details);
      if (
        keys.length === 0 ||
        !keys.every((k) => (RECONCILE_DISCREPANCY_KEYS as readonly string[]).includes(k))
      ) {
        throw new TypeError("reconcile: a key of details is not allowed");
      }
      for (const value of Object.values(details)) {
        if (value !== null && (typeof value !== "string" || value.length > VALUE_MAX)) {
          throw new TypeError("reconcile: a value of details is not a short string");
        }
      }
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into discrepancies (id, kind, details)
        values (${id}, ${kind}, ${JSON.stringify(details)}::jsonb)
        on conflict (id) do nothing returning id`);
      return rows.length === 1;
    },

    // The audit row of a correction of pool_capacity.used by the run (a system actor).
    async recordCapacityCorrection(input: {
      poolAccountId: string;
      region: string;
      quotaCode: string;
      previous: number;
      used: number;
    }): Promise<void> {
      if (!isUuid(input.poolAccountId))
        throw new TypeError("reconcile: poolAccountId is not a UUID");
      await insertAudit(tx, {
        actorType: "system",
        actorId: null,
        action: "capacity.corrected",
        targetType: "pool_account",
        targetId: input.poolAccountId,
        metadata: {
          region: input.region,
          quotaCode: input.quotaCode,
          previous: input.previous,
          used: input.used,
        },
      });
    },
  };
}

export type ReconcileRepo = ReturnType<typeof reconcileRepo>;
