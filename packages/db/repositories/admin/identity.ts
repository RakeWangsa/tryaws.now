import { eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { adminUsers } from "../../schema/index";
import type { AdminRole } from "./index";

// The admin of a verified Cognito sub: the step that creates the admin scope, so it has no actor yet.
// Only packages/auth calls it. Three columns and nothing else (R14).
export interface AdminIdentity {
  readonly id: string;
  readonly role: AdminRole;
  readonly status: "active" | "disabled";
}

const MAX_SUB_LENGTH = 128;

// A sub that is not a non-empty string of at most 128 characters returns null without a query (R16).
// A disabled admin is returned as it is: the caller refuses it (6.1: tokens are checked against
// admin_users.status).
export async function lookupAdminBySub(tx: Tx, sub: string): Promise<AdminIdentity | null> {
  if (typeof sub !== "string" || sub.length === 0 || sub.length > MAX_SUB_LENGTH) return null;
  const [row] = await tx
    .select({ id: adminUsers.id, role: adminUsers.role, status: adminUsers.status })
    .from(adminUsers)
    .where(eq(adminUsers.cognitoSub, sub))
    .limit(1);
  return row === undefined ? null : (row as AdminIdentity);
}
