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

/**
 * WPU-Y9. The database stamps the entry time of an exchange rate itself (admin_rw may not write created_at, so an
 * admin cannot backdate). A test that sets a rate through the admin flow on a FIXED fake clock gets the real time of
 * the run, which is ahead of that clock, and the rate then counts as not yet entered. This aligns every entry time
 * with the rate's own start (never later than it), as the table owner and with the append-only trigger off for the
 * statement. Test databases only.
 */
export async function settleFxEntries(t: TempDatabaseHandle): Promise<void> {
  await t.pool.query("alter table fx_rates disable trigger user");
  try {
    await t.pool.query(
      "update fx_rates set created_at = effective_from where created_at > effective_from",
    );
  } finally {
    await t.pool.query("alter table fx_rates enable trigger user");
  }
}
