import type { Tx } from "../client";
import type { Queryable } from "./sql";

/** A promise that the test opens by hand. */
export function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * Waits until a backend of the database waits for a lock (`pg_stat_activity.wait_event_type =
 * 'Lock'`), polling every 10 ms; throws "no backend waits for a lock" after `timeoutMs`.
 */
export async function waitForLockWaiter(pool: Queryable, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      "select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' limit 1",
    );
    if (rows.length > 0) return;
    if (Date.now() >= deadline) throw new Error("no backend waits for a lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Runs `body` in a transaction opened by `open` and keeps that transaction open until
 * `release()`. `reached` resolves when `body` has finished, also when it threw, so that a test
 * never hangs on a failed set-up; `result` then rejects.
 */
export function holdOpen<T>(
  open: (fn: (tx: Tx) => Promise<T>) => Promise<T>,
  body: (tx: Tx) => Promise<T>,
): { result: Promise<T>; reached: Promise<void>; release(): void } {
  const reached = gate();
  const release = gate();
  const result = open(async (tx) => {
    let value: T;
    try {
      value = await body(tx);
    } catch (error) {
      reached.open(); // a failed body ends the transaction at once; nothing is held
      throw error;
    }
    reached.open();
    await release.wait;
    return value;
  });
  // A failed set-up must not leave an unhandled rejection before the test awaits `result`.
  result.catch(() => {});
  return { result, reached: reached.wait, release: release.open };
}
