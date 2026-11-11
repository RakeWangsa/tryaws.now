import {
  approveOperation,
  rejectOperation,
  retryOperation,
  type AdminMessage,
  type AdminOutcome,
} from "../../operations/admin";
import { refused, type RepoErrorCode, type Written } from "../result";
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

export interface OperationsAdminRepo {
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
