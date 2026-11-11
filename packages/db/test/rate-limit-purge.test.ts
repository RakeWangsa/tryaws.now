import { expect, it } from "vitest";
import type { Tx } from "../client";
import { purgeRateLimits } from "../repositories/rate-limit";
import { runTransaction } from "../tx";
import { asRole, expectSqlError } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const asWorker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const at = (iso: string) => new Date(iso);

async function seed(key: string, windowStart: string): Promise<void> {
  await t.pool.query(
    "insert into rate_limits (id, scope_key, window_start, count) values (gen_random_uuid(), $1, $2, 1)",
    [key, windowStart],
  );
}
const keys = async (): Promise<string[]> =>
  (
    await t.pool.query<{ scope_key: string }>("select scope_key from rate_limits order by 1")
  ).rows.map((r) => r.scope_key);

it("deletes the windows that started before the cutoff and nothing else, as worker_rw", async () => {
  await seed("ip:old", "2026-11-09T00:00:00Z");
  await seed("ip:edge", "2026-11-10T00:00:00Z");
  await seed("ip:new", "2026-11-11T09:00:00Z");
  const removed = await asWorker((tx) => purgeRateLimits(tx, at("2026-11-10T00:00:00Z")));
  expect(removed).toBe(1);
  expect(await keys()).toEqual(["ip:edge", "ip:new"]);
  // A second run with the same cutoff removes nothing (R7).
  expect(await asWorker((tx) => purgeRateLimits(tx, at("2026-11-10T00:00:00Z")))).toBe(0);
});

it("refuses a cutoff that is not a date (R16)", async () => {
  await expect(asWorker((tx) => purgeRateLimits(tx, new Date(Number.NaN)))).rejects.toThrow(
    "rate limit purge: before is not a valid Date",
  );
});

it("worker_rw reads window_start only and cannot insert or update; the others still cannot delete", async () => {
  const refused = (role: "worker_rw" | "web_rw" | "admin_rw" | "report_ro", sql: string) =>
    expectSqlError(
      asRole(t.pool, role, (c) => c.query(sql)),
      "42501",
    );
  await refused("worker_rw", "select scope_key from rate_limits");
  await refused("worker_rw", "update rate_limits set count = 0");
  await refused(
    "worker_rw",
    "insert into rate_limits (id, scope_key, window_start) values (gen_random_uuid(), 'x', now())",
  );
  await refused("web_rw", "delete from rate_limits");
  await refused("admin_rw", "delete from rate_limits");
  await refused("report_ro", "delete from rate_limits");
});
