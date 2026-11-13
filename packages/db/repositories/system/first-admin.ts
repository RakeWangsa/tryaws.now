import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../../client";
import { insertAudit } from "../audit-log";

// WPU-Z18: the first superadmin after the first deploy. The go-live runbook creates the admin in the
// Cognito admin pool (with TOTP); its `admin_users` row lives in the private database (R2), which only
// the migrator reaches with the master user. The migrator reads the optional SST secret FirstAdminSub
// and calls bootstrapFirstSuperadmin once per deploy. It writes a row only while admin_users has no row
// at all, so after the first admin exists it never fires again (R7), whatever the secret holds.

/** The value an optional secret holds when nothing was set (the placeholder of scripts/golive). */
export const FIRST_ADMIN_NOT_CONFIGURED = "not-configured";
export const FIRST_ADMIN_ACTION = "admin_user.bootstrap";
export const FIRST_ADMIN_REASON = "first superadmin bootstrap";

// The canonical 8-4-4-4-12 form of a Cognito `sub`; nothing around it (no braces, prefix or spaces).
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sub in lowercase when it is a canonical UUID; undefined for anything else. */
export function canonicalCognitoSub(value: unknown): string | undefined {
  return typeof value === "string" && CANONICAL_UUID.test(value) ? value.toLowerCase() : undefined;
}

/** At most the first 8 characters of a sub: the only part a log may hold (R14). */
export function subPrefix(sub: string): string {
  return sub.slice(0, 8);
}

export type FirstAdminDecision =
  "inserted" | "skipped: admins exist" | "skipped: no secret" | "skipped: malformed";

export type FirstAdminPlan =
  | { readonly kind: "skip"; readonly decision: "skipped: no secret" | "skipped: malformed" }
  | { readonly kind: "run"; readonly sub: string };

// The decision before the database: unset, empty and the placeholder are "no secret"; any other value
// that is not a canonical UUID is "malformed". Both write nothing (R16).
export function firstAdminDecision(raw: string | undefined): FirstAdminPlan {
  if (raw === undefined || raw === "" || raw === FIRST_ADMIN_NOT_CONFIGURED) {
    return { kind: "skip", decision: "skipped: no secret" };
  }
  const sub = canonicalCognitoSub(raw);
  return sub === undefined
    ? { kind: "skip", decision: "skipped: malformed" }
    : { kind: "run", sub };
}

export type FirstAdminOutcome =
  { readonly outcome: "inserted"; readonly adminId: string } | { readonly outcome: "admins_exist" };

/**
 * In the caller's transaction, as the table owner: takes the advisory lock that every change of
 * admin_users takes (repositories/admin/admin-users.ts), counts the rows of the whole table regardless
 * of role or status, and only when there is none inserts one active superadmin and its audit row
 * (actor `system`, the reason, before and after, as the audited admin writes do). The lock serialises
 * two concurrent runs, so the second one sees the first one's row. The thrown message is fixed text.
 */
export async function bootstrapFirstSuperadmin(tx: Tx, sub: string): Promise<FirstAdminOutcome> {
  const cognitoSub = canonicalCognitoSub(sub);
  if (cognitoSub === undefined) throw new TypeError("first admin: the sub is not valid");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('admin_users:changes', 0))`);
  const { rows } = await tx.execute<{ present: boolean }>(
    sql`select exists (select 1 from admin_users) as present`,
  );
  if (rows[0]?.present !== false) return { outcome: "admins_exist" };
  const id = uuidv7();
  const after = { role: "superadmin", status: "active" } as const;
  await tx.execute(
    sql`insert into admin_users (id, cognito_sub, role, status) values (${id}, ${cognitoSub}, ${after.role}, ${after.status})`,
  );
  await insertAudit(tx, {
    actorType: "system",
    actorId: null,
    action: FIRST_ADMIN_ACTION,
    targetType: "admin_user",
    targetId: id,
    metadata: { reason: FIRST_ADMIN_REASON, before: null, after },
  });
  return { outcome: "inserted", adminId: id };
}
