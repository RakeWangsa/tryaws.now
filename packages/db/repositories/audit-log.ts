import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";
import type { AUDIT_ACTOR_TYPES } from "../schema/service";

// One row of audit_log, as a caller gives it. The actor is "customer" or "admin" with an id, or
// "system" with none (the CHECK audit_log_actor_check). Metadata holds ids, reasons and the before and
// after values of settings, never a document number, token, password, full phone number or email
// (R14 applies to logs; this keeps the audit table free of them too).
export interface AuditEntry {
  actorType: (typeof AUDIT_ACTOR_TYPES)[number];
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

// Appends one row to audit_log inside the caller's transaction and returns the id of the new row.
// The id is made here and not read back: web_rw and worker_rw have no SELECT on audit_log, so a
// RETURNING would fail with 42501. For the same reason the statement is not a Drizzle insert(), which
// names created_at (granted to no role) and fails with 42501 too: it names exactly the nine columns
// that web_rw, admin_rw and worker_rw may insert. A bad ip fails in the database (22P02) and takes the
// whole transaction with it (R16).
export async function insertAudit(tx: Tx, entry: AuditEntry): Promise<string> {
  const id = uuidv7();
  await tx.execute(
    sql`insert into audit_log (id, actor_type, actor_id, action, target_type, target_id, ip, user_agent, metadata) values (${id}, ${entry.actorType}, ${entry.actorId}, ${entry.action}, ${entry.targetType ?? null}, ${entry.targetId ?? null}, ${entry.ip ?? null}::inet, ${entry.userAgent ?? null}, ${JSON.stringify(entry.metadata ?? {})}::jsonb)`,
  );
  return id;
}
