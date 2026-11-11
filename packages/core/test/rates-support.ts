import type { Tx } from "@tc/db";
import { runTransaction, type DatabaseRole, type TempDatabaseHandle } from "@tc/db/testing";
import type { Clock } from "../types";

// adminActor lives in admin-support.ts (WP1-T4 Task 11); this re-export keeps the older imports.
export { adminActor } from "./admin-support";

/** A clock that always reads the given instant. */
export const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

/** One transaction as a database role, with the grants of migration 0006 in force. */
export const asRole = <T>(t: TempDatabaseHandle, role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });

/** One transaction as the table owner: seeds and fixtures that no application role may write. */
export const asOwner = <T>(t: TempDatabaseHandle, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn);
