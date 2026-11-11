import { insertAudit } from "../audit-log";
import { refused, type Written } from "../result";
import type { AdminScope } from "./index";

const MAX_REASON = 500;

export interface AuditedEntry {
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
}

// Every admin write goes through here (R10): it checks the reason, runs the write, and appends the
// audit row with actor, reason, IP, target and the before and after values in the same transaction,
// so the write and its row commit or roll back together. This is the only caller that writes an
// admin actor into audit_log: insertAudit itself would let a web_rw transaction name one.
export async function audited<T>(
  scope: AdminScope,
  entry: AuditedEntry,
  write: () => Promise<{ value: T; replayed: boolean; before: unknown; after: unknown }>,
): Promise<Written<T>> {
  // Read once into locals, so a getter cannot answer differently on the second read.
  const { action, targetType, targetId, reason } = entry;
  if (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON) {
    return refused("validation");
  }
  const { value, replayed, before, after } = await write();
  await insertAudit(scope.tx, {
    actorType: "admin",
    actorId: scope.actor.adminId,
    action,
    targetType,
    targetId,
    ip: scope.actor.ip,
    userAgent: scope.actor.userAgent,
    metadata: { reason, before, after },
  });
  return { ok: true, value, replayed };
}
