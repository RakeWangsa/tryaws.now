import { sql } from "drizzle-orm";
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

// One answer per scope (one transaction): the check holds a share lock on the admin row until the
// transaction ends, so a disable that commits meanwhile waits and the answer cannot go stale.
const checked = new WeakMap<AdminScope, Promise<boolean>>();

// HARDENING H1. True only when the actor is an admin that exists, is `active` and has the role the
// actor claims (R10, R16). Anything else, including a failing read, is false: the write is refused.
// `for share` needs UPDATE on a column: admin_rw has UPDATE (role, status) on admin_users.
export function isActiveAdmin(scope: AdminScope): Promise<boolean> {
  const known = checked.get(scope);
  if (known !== undefined) return known;
  // A failing statement rejects (and aborts the transaction): a database error is an error, not a refusal.
  const answer = (async () => {
    const { rows } = await scope.tx.execute<{ role: string; status: string }>(
      sql`select role, status from admin_users where id = ${scope.actor.adminId} for share`,
    );
    const row = rows[0];
    return row !== undefined && row.status === "active" && row.role === scope.actor.role;
  })();
  checked.set(scope, answer);
  return answer;
}

// Every admin write goes through here (R10): it checks that the actor is an active admin (H1), checks
// the reason, runs the write, and appends the audit row with actor, reason, IP, target and the before
// and after values in the same transaction, so the write and its row commit or roll back together.
// This is the only caller that writes an admin actor into audit_log: insertAudit itself would let a
// web_rw transaction name one. A refusal writes nothing and appends no row.
export async function audited<T>(
  scope: AdminScope,
  entry: AuditedEntry,
  write: () => Promise<{ value: T; replayed: boolean; before: unknown; after: unknown }>,
): Promise<Written<T>> {
  // Read once into locals, so a getter cannot answer differently on the second read.
  const { action, targetType, targetId, reason } = entry;
  // Authorize before validating (R9): a disabled admin gets the same fixed code whatever it sends.
  if (!(await isActiveAdmin(scope))) return refused("forbidden");
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
