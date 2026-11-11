import type { AdminActor, AdminRole } from "@tc/db";
import { newAdmin, type TempDatabaseHandle } from "@tc/db/testing";

/** An admin row in the temporary database, as the actor of an admin write (IP and agent are fixed). */
export async function adminActor(
  t: TempDatabaseHandle,
  role: AdminRole = "finance",
): Promise<AdminActor> {
  return { adminId: await newAdmin(t.pool, role), role, ip: "203.0.113.9", userAgent: "test" };
}
