import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { lifecycleRepo } from "../repositories/system/lifecycle";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-Z4: the switch of the daily unpaid-usage job is a settings row of scope market (key
// lifecycle_unpaid_enabled, value JSON true or false). The admin repository writes, as admin_rw, exactly the
// row that the job reads with lifecycleRepo(tx).readSettings as worker_rw; every write goes through
// `audited` (actor, reason, IP, target, before and after, R10). The statement-level cases without a database
// are in admin-settings-statements.test.ts.
const t = useTempDatabase();
const KEY = "lifecycle_unpaid_enabled";
const TARGET = { key: KEY, market: "BD" } as const;
const FORBIDDEN = { ok: false, error: "forbidden" };

let superadmin: AdminActor;
let ops: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  superadmin = {
    adminId: await newAdmin(t.pool, "superadmin"),
    role: "superadmin",
    ip: "203.0.113.9",
    userAgent: "test",
  };
  ops = { adminId: await newAdmin(t.pool, "ops"), role: "ops", ip: "203.0.113.10" };
});

const as = <T>(actor: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role: "admin_rw" });
// What the job reads (packages/core/metering/unpaid.ts: `=== true` turns it on).
const jobReads = async (): Promise<unknown> =>
  (
    await runTransaction(t.db, (tx) => lifecycleRepo(tx).readSettings([KEY]), {
      role: "worker_rw",
    })
  ).get(KEY);
const rows = async () =>
  (
    await t.pool.query(
      "select key, market, scope, scope_id, value, set_by from settings where key = $1",
      [KEY],
    )
  ).rows;
const switches = async (actorId: string) =>
  (await auditRowsOf(t.pool, actorId)).filter((a) => a.action === "setting.set");

it("no row: the job reads nothing (off), and the admin read says off without a stored value", async () => {
  expect(await jobReads()).toBeUndefined();
  expect(await as(superadmin, (r) => r.settings.read(KEY, "BD"))).toEqual({
    ok: true,
    replayed: false,
    value: { key: KEY, market: "BD", enabled: false, source: "none" },
  });
});

it("a superadmin turns it on: one row of scope market, scope_id null, JSON true, set_by the admin; the job reads true", async () => {
  expect(
    await as(superadmin, (r) => r.settings.setBoolean(TARGET, true, "pilot customers")),
  ).toEqual({ ok: true, replayed: false, value: { key: KEY, market: "BD", enabled: true } });
  expect(await rows()).toEqual([
    {
      key: KEY,
      market: "BD",
      scope: "market",
      scope_id: null,
      value: true,
      set_by: superadmin.adminId,
    },
  ]);
  expect(await jobReads()).toBe(true);
  expect(await as(ops, (r) => r.settings.read(KEY, "BD"))).toMatchObject({
    ok: true,
    value: { enabled: true, source: "stored" },
  });
});

it("the audit row holds actor, IP, target setting BD:<key>, the reason and before/after", async () => {
  const audits = await switches(superadmin.adminId);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    actor_type: "admin",
    target_type: "setting",
    target_id: `BD:${KEY}`,
    ip: "203.0.113.9",
    user_agent: "test",
  });
  expect(audits[0]?.metadata).toEqual({
    reason: "pilot customers",
    before: null,
    after: { value: true },
  });
});

it("turning it on again is a replay: the row does not change, the audit row has before = after", async () => {
  expect(await as(superadmin, (r) => r.settings.setBoolean(TARGET, true, "again"))).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(await rows()).toHaveLength(1);
  expect((await rows())[0]).toMatchObject({ value: true, set_by: superadmin.adminId });
  const audits = await switches(superadmin.adminId);
  expect(audits).toHaveLength(2);
  expect(audits[1]?.metadata).toEqual({
    reason: "again",
    before: { value: true },
    after: { value: true },
  });
});

it("ops turns it off: the same row is updated, set_by is ops, the job reads false, the audit row keeps true", async () => {
  expect(
    await as(ops, (r) => r.settings.setBoolean(TARGET, false, "too many suspensions")),
  ).toEqual({ ok: true, replayed: false, value: { key: KEY, market: "BD", enabled: false } });
  expect(await rows()).toEqual([
    { key: KEY, market: "BD", scope: "market", scope_id: null, value: false, set_by: ops.adminId },
  ]);
  expect(await jobReads()).toBe(false);
  const audits = await switches(ops.adminId);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ target_type: "setting", target_id: `BD:${KEY}` });
  expect(audits[0]?.metadata).toEqual({
    reason: "too many suspensions",
    before: { value: true },
    after: { value: false },
  });
});

it("ops cannot turn it on; finance and support switch nothing; every role reads; nothing is written", async () => {
  const before = await rows();
  expect(await as(ops, (r) => r.settings.setBoolean(TARGET, true, "r"))).toEqual(FORBIDDEN);
  for (const role of ["finance", "support"] as const) {
    const reader: AdminActor = { adminId: await newAdmin(t.pool, role), role, ip: "203.0.113.11" };
    for (const value of [true, false]) {
      expect(await as(reader, (r) => r.settings.setBoolean(TARGET, value, "r"))).toEqual(FORBIDDEN);
    }
    expect(await as(reader, (r) => r.settings.read(KEY, "BD"))).toMatchObject({
      ok: true,
      value: { enabled: false, source: "stored" },
    });
    expect(await switches(reader.adminId)).toEqual([]);
  }
  expect(await rows()).toEqual(before);
  expect(await switches(ops.adminId)).toHaveLength(1);
});

it("a key off the allow-list and a bad market are refused, nothing is written", async () => {
  const before = await rows();
  for (const target of [
    { key: "tier_limits", market: "BD" },
    { key: "r13_approval_until", market: "BD" },
    { key: KEY, market: "bd" },
  ]) {
    expect(await as(superadmin, (r) => r.settings.setBoolean(target as never, false, "r"))).toEqual(
      { ok: false, error: "validation" },
    );
  }
  expect(await as(superadmin, (r) => r.settings.read("r13_approval_until" as never, "BD"))).toEqual(
    { ok: false, error: "validation" },
  );
  expect(await rows()).toEqual(before);
  expect(await switches(superadmin.adminId)).toHaveLength(2);
});

it("a stored value that is not a boolean is off for the job and invalid for the admin; a switch replaces it", async () => {
  await t.pool.query(`update settings set value = '"true"'::jsonb where key = $1`, [KEY]);
  expect(await jobReads()).toBe("true");
  expect(await as(ops, (r) => r.settings.read(KEY, "BD"))).toMatchObject({
    ok: true,
    value: { enabled: false, source: "invalid" },
  });
  expect(await as(ops, (r) => r.settings.setBoolean(TARGET, false, "clean up"))).toMatchObject({
    ok: true,
    replayed: false,
  });
  expect(await jobReads()).toBe(false);
  const last = (await switches(ops.adminId)).at(-1);
  expect(last?.metadata).toMatchObject({ before: { value: "true" }, after: { value: false } });
});
