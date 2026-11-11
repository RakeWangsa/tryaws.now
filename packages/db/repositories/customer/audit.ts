import { insertAudit } from "../audit-log";
import { created, refused, type Written } from "../result";
import type { TenantScope } from "../scope";

// What a customer action tells the audit log. There is no actor here: the actor is the session
// customer, always (R8). An admin action is audited through `audited` (R10), not through this.
export interface CustomerAuditInput {
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRepo {
  record(input: CustomerAuditInput): Promise<Written<{ id: string }>>;
}

// "area.verb", with more dotted parts allowed: ssh_key.add, profile.update.
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_ACTION_LENGTH = 64;

export function auditRepo(scope: TenantScope): AuditRepo {
  return {
    // The last step of every customer action (R9). It has no key: each call records one attempt, and a
    // replay that commits records a second row (open point 14). The row is written in the action's
    // transaction, so a failure rolls it back with everything else.
    record: async (input) => {
      // R16: an action name that does not have the form is refused before any query.
      if (
        typeof input.action !== "string" ||
        input.action.length > MAX_ACTION_LENGTH ||
        !ACTION.test(input.action)
      ) {
        return refused("validation");
      }
      // The entry is built field by field: an input that carries more (a cast, an actorId of someone
      // else) cannot choose the actor.
      const id = await insertAudit(scope.tx, {
        actorType: "customer",
        actorId: scope.customerId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        ip: input.ip,
        userAgent: input.userAgent,
        metadata: input.metadata,
      });
      return created({ id });
    },
  };
}
