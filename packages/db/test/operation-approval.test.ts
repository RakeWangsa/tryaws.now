import { beforeEach, expect, it } from "vitest";
import { APPROVAL_SETTING, readApprovalUntil } from "../operations/approval";
import { APPROVAL_UNTIL } from "../operations/kinds";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const read = (role: DatabaseRole) => runTransaction(t.db, (tx) => readApprovalUntil(tx), { role });
const put = async (value: unknown) => {
  await ensureMarket(t.pool, "BD");
  await t.pool.query("delete from settings where key = $1", [APPROVAL_SETTING.key]);
  if (value !== undefined) {
    await t.pool.query(
      "insert into settings (id, key, market, scope, scope_id, value) values (gen_random_uuid(), $1, $2, $3, null, $4::jsonb)",
      [
        APPROVAL_SETTING.key,
        APPROVAL_SETTING.market,
        APPROVAL_SETTING.scope,
        JSON.stringify(value),
      ],
    );
  }
};
beforeEach(async () => {
  await put(undefined);
});

it("reads the end date from the settings row, as web_rw, worker_rw and admin_rw, and the date can move", async () => {
  await put(APPROVAL_UNTIL);
  for (const role of ["web_rw", "worker_rw", "admin_rw"] as const) {
    expect(await read(role), role).toEqual(new Date(APPROVAL_UNTIL));
  }
  await put("2027-01-31T00:00:00.000Z");
  expect(await read("worker_rw")).toEqual(new Date("2027-01-31T00:00:00.000Z"));
});

it("a missing row, a value that is not a string and an unparsable string give null (R16)", async () => {
  expect(await read("worker_rw")).toBeNull();
  for (const bad of [42, null, { until: APPROVAL_UNTIL }, "tomorrow", ""]) {
    await put(bad);
    expect(await read("worker_rw"), JSON.stringify(bad)).toBeNull();
  }
});
