import type { AdminActor, AdminRole } from "@tc/db";
import {
  cleanReason,
  cleanUuid,
  failureCode,
  type CaseActionAnswer,
  type CaseFlowDeps,
} from "./case-flow-common.ts";

// resolveDiscrepancy of /reconciliation (16.12) in the order of R9: authorize, validate, rate limit,
// execute (payments.resolveDiscrepancy of WP8-T3: one transaction through `audited`), answer. ops,
// finance and superadmin. Resolving marks the row; it moves no money and touches no AWS resource.

export type ReconciliationActionKind = "resolveDiscrepancy";
export const RECONCILIATION_ROLES: readonly AdminRole[] = ["ops", "finance", "superadmin"];

export interface ReconciliationActionRequest {
  readonly kind: ReconciliationActionKind;
  readonly id: unknown;
  readonly reason: unknown;
}

export function makeReconciliationAction(
  deps: CaseFlowDeps,
): (request: ReconciliationActionRequest) => Promise<CaseActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const { kind, id, reason } = request;
    // 1 and 2. Authenticate and authorize.
    let actor: AdminActor;
    try {
      actor = await deps.authorize(RECONCILIATION_ROLES);
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      if (kind !== "resolveDiscrepancy") return { ok: false, code: "invalid" };
      const discrepancyId = cleanUuid(id);
      const why = cleanReason(reason);
      if (discrepancyId === null || why === null) return { ok: false, code: "invalid" };
      // 4. Rate limit.
      if (!(await deps.limiter(actor, deps.clock.now())))
        return { ok: false, code: "rate_limited" };
      // 5 and 6. Execute and audit, in one transaction.
      const written = await deps.run(actor, (repos) =>
        repos.payments.resolveDiscrepancy({ id: discrepancyId }, why),
      );
      if (!written.ok) return { ok: false, code: failureCode(written) };
      return { ok: true, replayed: written.replayed, targetId: discrepancyId, sent: true };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}
