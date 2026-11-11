import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WP8-T4: a large FX change waits as a pending change that one admin requests and ANOTHER admin
// approves. The pending change is stored in `settings` (key fx_change_pending), no new table.
const t = useTempDatabase();
const T0 = new Date("2026-11-12T06:00:00.000Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

let a: AdminActor;
let b: AdminActor;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  a = { adminId: await newAdmin(t.pool, "finance"), role: "finance", ip: "203.0.113.9" };
  b = { adminId: await newAdmin(t.pool, "superadmin"), role: "superadmin", ip: "203.0.113.10" };
});
const as = <T>(who: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, who)), { role: "admin_rw" });
const ask = (rate = "140", at = T0) =>
  as(a, (r) =>
    r.fxChanges.request(
      { market: "BD", rate, effectiveFrom: null, at, expiresAt: hours(24) },
      "bank rate moved",
    ),
  );

it("a request stores a pending change with its author and one audit row; the rate table is untouched", async () => {
  const made = await ask();
  expect(made).toMatchObject({
    ok: true,
    replayed: false,
    value: {
      market: "BD",
      rate: "140",
      status: "pending",
      requestedBy: a.adminId,
      approvedBy: null,
    },
  });
  expect((await t.pool.query("select count(*)::int as n from fx_rates")).rows[0].n).toBe(0);
  const rows = await auditRowsOf(t.pool, a.adminId);
  expect(rows.map((r) => [r.action, r.target_id, r.ip])).toEqual([
    ["fx_rate.request", "BD", "203.0.113.9"],
  ]);
  expect(rows[0]?.metadata).toMatchObject({ reason: "bank rate moved" });
});

it("the same request twice is a replay; a different rate while one waits is a conflict (R7)", async () => {
  expect(await ask()).toMatchObject({ ok: true, replayed: true });
  expect(await ask("150")).toEqual({ ok: false, error: "conflict" });
});

it("the requester cannot approve their own change (the actor comes from the session)", async () => {
  const out = await as(a, (r) => r.fxChanges.approve({ market: "BD", at: hours(1) }, "me too"));
  expect(out).toEqual({ ok: false, error: "forbidden" });
  expect(await as(a, (r) => r.fxChanges.read("BD"))).toMatchObject({ status: "pending" });
});

it("another admin approves once; a second approval by the same admin is a replay; by a third, a conflict", async () => {
  const done = await as(b, (r) => r.fxChanges.approve({ market: "BD", at: hours(2) }, "checked"));
  expect(done).toMatchObject({
    ok: true,
    replayed: false,
    value: { status: "approved", approvedBy: b.adminId, requestedBy: a.adminId, rate: "140" },
  });
  expect(
    await as(b, (r) => r.fxChanges.approve({ market: "BD", at: hours(3) }, "again")),
  ).toMatchObject({ ok: true, replayed: true });
  const audits = await auditRowsOf(t.pool, b.adminId);
  // The replay is audited too (every admin call leaves a row), with the approver's own address.
  expect(audits.map((r) => [r.action, r.ip])).toEqual([
    ["fx_rate.approve", "203.0.113.10"],
    ["fx_rate.approve", "203.0.113.10"],
  ]);
});

it("an approved change does not block a new request, which replaces it", async () => {
  expect(await ask("141", hours(5))).toMatchObject({
    ok: true,
    replayed: false,
    value: { rate: "141", status: "pending" },
  });
});

it("an expired change cannot be approved", async () => {
  const out = await as(b, (r) => r.fxChanges.approve({ market: "BD", at: hours(5 + 25) }, "late"));
  expect(out).toEqual({ ok: false, error: "conflict" });
  expect(await as(b, (r) => r.fxChanges.read("BD"))).toMatchObject({ status: "pending" });
});

it("approving where nothing waits is not_found, and a bad market is validation", async () => {
  await ensureMarket(t.pool, "XX");
  expect(await as(b, (r) => r.fxChanges.approve({ market: "XX", at: T0 }, "none"))).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(await as(b, (r) => r.fxChanges.approve({ market: "bd", at: T0 }, "bad"))).toEqual({
    ok: false,
    error: "validation",
  });
});

it("a disabled admin is refused", async () => {
  const id = await newAdmin(t.pool, "finance");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
  const gone: AdminActor = { adminId: id, role: "finance", ip: "203.0.113.11" };
  expect(await as(gone, (r) => r.fxChanges.approve({ market: "BD", at: T0 }, "x"))).toEqual({
    ok: false,
    error: "forbidden",
  });
});
