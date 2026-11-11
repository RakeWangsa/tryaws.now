import type { Database } from "../client";
import { customerRepos, type CustomerRepos } from "../repositories/customer/index";
import type { Queryable } from "../test/sql";
import { runTransaction } from "../tx";

// Runs fn with the repositories of one customer in one transaction as web_rw, so the column grants
// of migration 0006 apply. Every repository test and every endpoint test that drives customerRepos
// directly uses it. (Not named asCustomer: that is the session stub of WP2-T1.)
export function withCustomerRepos<T>(
  db: Database,
  customerId: string,
  fn: (r: CustomerRepos) => Promise<T>,
): Promise<T> {
  return runTransaction(db, (tx) => fn(customerRepos(tx, customerId)), { role: "web_rw" });
}

// One audit_log row as a test compares it: the column names of the table, the ip as text.
export interface AuditRow {
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

// The audit rows of one actor, oldest first, read as the owner: give it the owner's pool (t.pool),
// never a connection that took web_rw or worker_rw, which have no SELECT on audit_log. Used by the
// tests of audit.record, of audited and of every endpoint that checks the audit step of R9.
export async function auditRowsOf(q: Queryable, actorId: string): Promise<AuditRow[]> {
  const { rows } = await q.query<AuditRow>(
    `select actor_type, action, target_type, target_id, host(ip) as ip, user_agent, metadata
       from audit_log
      where actor_id = $1
      order by created_at, id`,
    [actorId],
  );
  return rows;
}
