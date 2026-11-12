import { sql } from "drizzle-orm";
import {
  approveOperation,
  rejectOperation,
  retryOperation,
  type AdminMessage,
  type AdminOutcome,
} from "../../operations/admin";
import { insertOperation } from "../../operations/insert";
import { isOperationKind, OPERATION_KIND_INFO, type OperationKind } from "../../operations/kinds";
import { OPERATION_STATES } from "../../schema/provisioning";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminScope } from "./index";

// 16.12 /operations: the decisions of an admin on the queue, each one through `audited` (R10). The
// database part is operations/admin.ts; this wrapper adds the active-admin check (H1) and the audit
// row. The message for the queue is returned to the Server Action, which sends it after the commit.
export interface OperationDecisionInput {
  operationId: string;
  at: Date;
}

export interface OperationDecision {
  // null when nothing is to be sent (a reject of a waiting operation, or a replay of one).
  message: AdminMessage | null;
}

export type OperationStateName = (typeof OPERATION_STATES)[number];

export interface OperationQueueFilter {
  state?: OperationStateName;
  kind?: OperationKind;
  limit?: number;
  // The id of the last row of the page before.
  after?: string;
}

// last_error is the code the engine wrote (policy.ts keeps AWS text out of it); the screen still maps
// it to a fixed message before it shows anything (R14).
export interface OperationQueueRow {
  id: string;
  resourceId: string;
  kind: string;
  state: OperationStateName;
  step: string | null;
  attempts: number;
  destructive: boolean;
  needsApproval: boolean;
  approvedBy: string | null;
  nextRunAt: Date;
  createdAt: Date;
  lastError: string | null;
  family: string | null;
  region: string | null;
}

export interface OperationQueuePage {
  rows: OperationQueueRow[];
  nextAfter: string | null;
}

export interface OperationTrailEntry {
  action: string;
  actorId: string | null;
  at: Date;
  reason: string | null;
}

export interface OperationDetail extends OperationQueueRow {
  trail: OperationTrailEntry[];
}

export type OperationStateCounts = Record<OperationStateName, number>;

// WPA-P2. The plan change of a container service or a CDN as an admin sees it. The three config values
// are the stored JSON (the app parses them with the readers of the lifecycle); the plans are the catalog
// rows they name (the AWS plan id is a plan name, never an account id).
export interface PlanChangeConfig {
  appliedPlan: unknown;
  pendingPlan: unknown;
  pendingPlanFailed: unknown;
}

export interface PlanChangePlan {
  productId: string;
  awsId: string;
  active: boolean;
}

export interface PlanChangeOperation {
  id: string;
  kind: string;
  state: OperationStateName;
  lastError: string | null;
  createdAt: Date;
}

export interface PlanChangeView {
  resourceId: string;
  family: string;
  state: string;
  region: string | null;
  config: PlanChangeConfig;
  plans: PlanChangePlan[];
  // The apply operations of the plan (and the clears of the mark), newest first.
  operations: PlanChangeOperation[];
}

export interface ClearPlanChangeMarkInput {
  resourceId: string;
  // The id of the form the admin submitted: a repeat of the same form is the same operation (R7).
  requestId: string;
  at: Date;
}

export interface ClearPlanChangeMarkResult {
  resourceId: string;
  operationId: string;
  // null when nothing is to be sent (a replay).
  message: AdminMessage | null;
}

export interface OperationsAdminRepo {
  planChange(resourceId: string): Promise<Written<PlanChangeView>>;
  clearPlanChangeMark(
    input: ClearPlanChangeMarkInput,
    reason: string,
  ): Promise<Written<ClearPlanChangeMarkResult>>;
  queue(filter?: OperationQueueFilter): Promise<Written<OperationQueuePage>>;
  counts(): Promise<Written<OperationStateCounts>>;
  detail(operationId: string): Promise<Written<OperationDetail>>;
  approve(input: OperationDecisionInput, reason: string): Promise<Written<OperationDecision>>;
  retry(input: OperationDecisionInput, reason: string): Promise<Written<OperationDecision>>;
  reject(input: OperationDecisionInput, reason: string): Promise<Written<OperationDecision>>;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: RepoErrorCode) {
    super("operation refused");
  }
}

const REFUSALS: Record<Extract<AdminOutcome, { ok: false }>["error"], RepoErrorCode> = {
  not_found: "not_found",
  conflict: "conflict",
  forbidden: "forbidden",
};

// The reads show every customer's operations: only an active ops or superadmin admin may run them (R16).
const READ_ROLES: readonly string[] = ["ops", "superadmin"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TRAIL_LIMIT = 50;

// WPA-P2. The families that have a plan change (core lifecycle/plan-change.ts PLAN_CHANGE_FAMILIES) and
// the operations that belong to it. db cannot import core, so the lists are repeated here and pinned by
// a test in packages/core.
export const PLAN_CHANGE_FAMILIES = ["container_service", "cdn"] as const;
const PLAN_OPERATION_KINDS = ["scale_container", "change_cdn_bundle", "clear_plan_change_mark"];
const PLAN_OPERATIONS_LIMIT = 10;
export const CLEAR_MARK_KEY = "admin:clear-plan-mark:";

function productIdOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).productId;
  return typeof id === "string" && isUuid(id) ? id : null;
}

interface QueueSqlRow {
  id: string;
  resourceId: string;
  kind: string;
  state: OperationStateName;
  step: string | null;
  attempts: number;
  needsApproval: boolean;
  approvedBy: string | null;
  nextRunAt: string | Date;
  createdAt: string | Date;
  lastError: string | null;
  family: string | null;
  region: string | null;
}

const toRow = (row: QueueSqlRow): OperationQueueRow => ({
  ...row,
  destructive: isOperationKind(row.kind) && OPERATION_KIND_INFO[row.kind].destructive,
  nextRunAt: new Date(row.nextRunAt),
  createdAt: new Date(row.createdAt),
});

const QUEUE_COLUMNS = sql`o.id, o.resource_id as "resourceId", o.kind, o.state, o.step, o.attempts,
       o.needs_approval as "needsApproval", o.approved_by as "approvedBy",
       o.next_run_at as "nextRunAt", o.created_at as "createdAt", o.last_error as "lastError",
       r.family, r.region`;

export function operationsAdminRepo(scope: AdminScope): OperationsAdminRepo {
  const decide = async (
    action: "operation.approve" | "operation.retry" | "operation.reject",
    run: (operationId: string, at: Date) => Promise<AdminOutcome>,
    input: OperationDecisionInput,
    reason: string,
  ): Promise<Written<OperationDecision>> => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const { operationId, at } = input;
    // The decision is for ops and superadmin at this layer too, not only in the admin app (R10, R16).
    if (!READ_ROLES.includes(scope.actor.role) || !(await isActiveAdmin(scope))) {
      return refused("forbidden");
    }
    if (typeof operationId !== "string" || !(at instanceof Date) || Number.isNaN(at.getTime())) {
      return refused("validation");
    }
    try {
      return await audited(
        scope,
        { action, targetType: "operation", targetId: operationId, reason },
        async () => {
          const outcome = await run(operationId, at);
          if (!outcome.ok) throw new Refusal(REFUSALS[outcome.error]);
          return {
            value: { message: outcome.message },
            replayed: outcome.replayed,
            before: null,
            after: { replayed: outcome.replayed },
          };
        },
      );
    } catch (error) {
      if (error instanceof Refusal) return refused(error.code);
      throw error;
    }
  };

  const mayRead = async (): Promise<boolean> =>
    READ_ROLES.includes(scope.actor.role) && (await isActiveAdmin(scope));

  return {
    async planChange(resourceId) {
      if (!(await mayRead())) return refused("forbidden");
      if (typeof resourceId !== "string" || !isUuid(resourceId)) return refused("not_found");
      const found = await scope.tx.execute<{
        id: string;
        family: string;
        state: string;
        region: string | null;
        applied: unknown;
        pending: unknown;
        failed: unknown;
      }>(
        sql`select id, family, state, region, config -> 'appliedPlan' as applied,
                   config -> 'pendingPlan' as pending, config -> 'pendingPlanFailed' as failed
              from resources where id = ${resourceId}`,
      );
      const row = found.rows[0];
      if (row === undefined || !(PLAN_CHANGE_FAMILIES as readonly string[]).includes(row.family)) {
        return refused("not_found");
      }
      const wanted = new Set<string>();
      for (const value of [row.applied, row.pending, row.failed]) {
        const id = productIdOf(value);
        if (id !== null) wanted.add(id);
      }
      const plans: PlanChangePlan[] = [];
      for (const productId of wanted) {
        const product = await scope.tx.execute<{ awsId: string; active: boolean }>(
          sql`select aws_id as "awsId", active from catalog_products where id = ${productId}`,
        );
        const p = product.rows[0];
        if (p !== undefined) plans.push({ productId, awsId: p.awsId, active: p.active });
      }
      const ops = await scope.tx.execute<
        {
          id: string;
          kind: string;
          state: OperationStateName;
          lastError: string | null;
          createdAt: string | Date;
        } & Record<string, unknown>
      >(
        sql`select id, kind, state, last_error as "lastError", created_at as "createdAt"
              from operations
             where resource_id = ${resourceId}
               and kind in (${sql.join(
                 PLAN_OPERATION_KINDS.map((k) => sql`${k}`),
                 sql`, `,
               )})
             order by created_at desc, id desc
             limit ${PLAN_OPERATIONS_LIMIT}`,
      );
      return {
        ok: true,
        replayed: false,
        value: {
          resourceId: row.id,
          family: row.family,
          state: row.state,
          region: row.region,
          config: {
            appliedPlan: row.applied ?? null,
            pendingPlan: row.pending ?? null,
            pendingPlanFailed: row.failed ?? null,
          },
          plans,
          operations: ops.rows.map((o) => ({
            id: o.id,
            kind: o.kind,
            state: o.state,
            lastError: o.lastError,
            createdAt: new Date(o.createdAt),
          })),
        },
      };
    },

    async clearPlanChangeMark(input, reason) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { resourceId, requestId, at } = input;
      // Authorize before validating (R9): ops and superadmin, as the rest of the operations area.
      if (!READ_ROLES.includes(scope.actor.role) || !(await isActiveAdmin(scope))) {
        return refused("forbidden");
      }
      if (
        typeof resourceId !== "string" ||
        !isUuid(resourceId) ||
        typeof requestId !== "string" ||
        !isUuid(requestId) ||
        !(at instanceof Date) ||
        Number.isNaN(at.getTime())
      ) {
        return refused("validation");
      }
      const key = `${CLEAR_MARK_KEY}${resourceId}:${requestId}`;
      try {
        return await audited(
          scope,
          {
            action: "plan_change.clear_mark",
            targetType: "resource",
            targetId: resourceId,
            reason,
          },
          async () => {
            const found = await scope.tx.execute<{
              family: string;
              state: string;
              failed: unknown;
            }>(
              sql`select family, state, config -> 'pendingPlanFailed' as failed
                    from resources where id = ${resourceId}`,
            );
            const row = found.rows[0];
            if (
              row === undefined ||
              !(PLAN_CHANGE_FAMILIES as readonly string[]).includes(row.family)
            ) {
              throw new Refusal("not_found");
            }
            // The same form again finds the first operation, even after it has cleared the mark (R7).
            const known = await scope.tx.execute<{ id: string }>(
              sql`select id from operations where idempotency_key = ${key} and resource_id = ${resourceId}`,
            );
            const prior = known.rows[0];
            if (prior !== undefined) {
              return {
                value: { resourceId, operationId: prior.id, message: null },
                replayed: true,
                before: { pendingPlanFailed: row.failed ?? null },
                after: { operationId: prior.id, kind: "clear_plan_change_mark" },
              };
            }
            if (row.state === "destroyed") throw new Refusal("conflict");
            // Nothing to clear: the mark is absent or not an object.
            if (
              typeof row.failed !== "object" ||
              row.failed === null ||
              Array.isArray(row.failed)
            ) {
              throw new Refusal("conflict");
            }
            const op = await insertOperation(
              scope.tx,
              {
                resourceId,
                kind: "clear_plan_change_mark",
                payload: { requestId },
                idempotencyKey: key,
              },
              at,
            );
            return {
              value: {
                resourceId,
                operationId: op.operationId,
                message: op.created
                  ? { operationId: op.operationId, resourceId, enqueueSeq: op.enqueueSeq }
                  : null,
              },
              replayed: !op.created,
              before: { pendingPlanFailed: row.failed },
              after: { operationId: op.operationId, kind: "clear_plan_change_mark" },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },

    async queue(filter = {}) {
      if (!(await mayRead())) return refused("forbidden");
      const { state, kind, limit = DEFAULT_LIMIT, after } = filter;
      if (
        (state !== undefined && !(OPERATION_STATES as readonly unknown[]).includes(state)) ||
        (kind !== undefined && !isOperationKind(kind)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_LIMIT ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      const stateFilter = state ?? null;
      const kindFilter = kind ?? null;
      const cursor = after ?? null;
      const { rows } = await scope.tx.execute<QueueSqlRow & Record<string, unknown>>(
        sql`select ${QUEUE_COLUMNS}
              from operations o join resources r on r.id = o.resource_id
             where (${stateFilter}::text is null or o.state = ${stateFilter})
               and (${kindFilter}::text is null or o.kind = ${kindFilter})
               and (${cursor}::uuid is null
                    or (o.created_at, o.id) > (select c.created_at, c.id from operations c where c.id = ${cursor}::uuid))
             order by o.created_at, o.id
             limit ${limit + 1}`,
      );
      const page = rows.slice(0, limit).map(toRow);
      const last = page[page.length - 1];
      return {
        ok: true,
        replayed: false,
        value: {
          rows: page,
          nextAfter: rows.length > limit && last !== undefined ? last.id : null,
        },
      };
    },

    async counts() {
      if (!(await mayRead())) return refused("forbidden");
      const { rows } = await scope.tx.execute<{ state: OperationStateName; n: number }>(
        sql`select state, count(*)::int as n from operations group by state`,
      );
      const out = Object.fromEntries(OPERATION_STATES.map((s) => [s, 0])) as OperationStateCounts;
      for (const row of rows) if (row.state in out) out[row.state] = row.n;
      return { ok: true, replayed: false, value: out };
    },

    async detail(operationId) {
      if (!(await mayRead())) return refused("forbidden");
      if (typeof operationId !== "string" || !isUuid(operationId)) return refused("not_found");
      const found = await scope.tx.execute<QueueSqlRow & Record<string, unknown>>(
        sql`select ${QUEUE_COLUMNS}
              from operations o join resources r on r.id = o.resource_id
             where o.id = ${operationId}`,
      );
      const row = found.rows[0];
      if (row === undefined) return refused("not_found");
      const trail = await scope.tx.execute<
        {
          action: string;
          actorId: string | null;
          at: string | Date;
          reason: string | null;
        } & Record<string, unknown>
      >(
        sql`select action, actor_id as "actorId", created_at as "at", metadata ->> 'reason' as reason
              from audit_log
             where target_type = 'operation' and target_id = ${operationId}
             order by created_at, id
             limit ${TRAIL_LIMIT}`,
      );
      return {
        ok: true,
        replayed: false,
        value: {
          ...toRow(row),
          trail: trail.rows.map((e) => ({ ...e, at: new Date(e.at) })),
        },
      };
    },

    approve: (input, reason) =>
      decide(
        "operation.approve",
        (operationId, at) =>
          approveOperation(scope.tx, { operationId, adminId: scope.actor.adminId, at }),
        input,
        reason,
      ),
    retry: (input, reason) =>
      decide(
        "operation.retry",
        (operationId, at) => retryOperation(scope.tx, { operationId, at }),
        input,
        reason,
      ),
    reject: (input, reason) =>
      decide(
        "operation.reject",
        (operationId, at) => rejectOperation(scope.tx, { operationId, at }),
        input,
        reason,
      ),
  };
}
