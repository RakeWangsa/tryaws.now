import type pg from "pg";

// Waits until `waiting` statements of the database are blocked on a lock (default 1). It throws when
// that does not happen in time, so a race that never took place fails at the call and not later for
// another reason. A test helper, exported from @tc/db/testing only.
export async function waitForLockWait(
  pool: Pick<pg.Pool, "query">,
  databaseName: string,
  options: { timeoutMs?: number; waiting?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const waiting = options.waiting ?? 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await pool.query(
      "select count(*)::int as n from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and state = 'active'",
      [databaseName],
    );
    if (res.rows[0]?.n === waiting) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForLockWait: no statement waited for a lock in ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
