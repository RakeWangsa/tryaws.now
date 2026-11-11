import { sql } from "drizzle-orm";
import {
  approveOperation,
  rejectOperation,
  retryOperation,
  type AdminMessage,
  type AdminOutcome,
} from "../../operations/admin";
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

export interface OperationsAdminRepo {
  queue(filter?: OperationQueueFilter): Promise<OperationQueuePage>;
  counts(): Promise<OperationStateCounts>;
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TRAIL_LIMIT = 50;

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
    if (!(await isActiveAdmin(scope))) return refused("forbidden");
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

  return {
    async queue(filter = {}) {
      const { state, kind, limit = DEFAULT_LIMIT, after } = filter;
      if (
        (state !== undefined && !(OPERATION_STATES as readonly unknown[]).includes(state)) ||
        (kind !== undefined && !isOperationKind(kind)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_LIMIT ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        throw new TypeError("operations: the queue filter is not valid");
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
      return { rows: page, nextAfter: rows.length > limit && last !== undefined ? last.id : null };
    },

    async counts() {
      const { rows } = await scope.tx.execute<{ state: OperationStateName; n: number }>(
        sql`select state, count(*)::int as n from operations group by state`,
      );
      const out = Object.fromEntries(OPERATION_STATES.map((s) => [s, 0])) as OperationStateCounts;
      for (const row of rows) if (row.state in out) out[row.state] = row.n;
      return out;
    },

    async detail(operationId) {
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
