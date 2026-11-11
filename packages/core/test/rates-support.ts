import type { AdminActor, AdminRole, Tx } from "@tc/db";
import {
  newAdmin,
  runTransaction,
  type DatabaseRole,
  type TempDatabaseHandle,
} from "@tc/db/testing";
import type { Clock } from "../types";

/** A clock that always reads the given instant. */
export const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

export async function adminActor(
  t: TempDatabaseHandle,
  role: AdminRole = "finance",
): Promise<AdminActor> {
  return { adminId: await newAdmin(t.pool, role), role, ip: "203.0.113.9", userAgent: "test" };
}

/** One transaction as a database role, with the grants of migration 0006 in force. */
export const asRole = <T>(t: TempDatabaseHandle, role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });

/** One transaction as the table owner: seeds and fixtures that no application role may write. */
export const asOwner = <T>(t: TempDatabaseHandle, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn);
