import { eq } from "drizzle-orm";
import type { Tx } from "../../client";
import { adminUsers } from "../../schema/index";
import { isUuid } from "../scope";
import type { AdminRole } from "./index";

// The second admin of a large rate change (the caller checks role and status). Reads the id, the
// role and the status and nothing else of the row (R14); admin_rw may SELECT admin_users
// (migration 0006). An id that is not a UUID is answered without a query.
export async function readAdminApprover(
  tx: Tx,
  id: string,
): Promise<{ id: string; role: AdminRole; status: string } | null> {
  if (typeof id !== "string" || !isUuid(id)) return null;
  const rows = await tx
    .select({ id: adminUsers.id, role: adminUsers.role, status: adminUsers.status })
    .from(adminUsers)
    .where(eq(adminUsers.id, id))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, role: row.role as AdminRole, status: row.status } : null;
}
