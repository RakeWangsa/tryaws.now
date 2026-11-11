import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// 16.12 /reconciliation: the discrepancies by kind (reads here); resolveDiscrepancy is the one write of
// payments.resolveDiscrepancy (WP8-T3), which this screen reuses for ops and finance. WP8-T7.
const t = useTempDatabase();
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "ops"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
const seed = (kind: string, details: unknown, over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "discrepancies", { kind, details, ...over });

it("overview counts the open discrepancies of each kind", async () => {
  const a = await actorOf();
  const before = await asAdmin(a, (r) => r.reconciliation.overview());
  expect(before.ok).toBe(true);
  if (!before.ok) return;
  await seed("orphan", { resourceId: uuidv7() });
  await seed("orphan", { resourceId: uuidv7() });
  await seed("cost", { note: "above the plan" });
  await seed("missing", {}, { status: "resolved" });
  const after = await asAdmin(a, (r) => r.reconciliation.overview());
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(Object.keys(after.value).sort()).toEqual(["cost", "missing", "orphan", "payment"]);
  expect(after.value.orphan - before.value.orphan).toBe(2);
  expect(after.value.cost - before.value.cost).toBe(1);
  expect(after.value.missing).toBe(before.value.missing);
});

it("list filters by kind and state and shows only allow-listed, safe values (16.13, R14)", async () => {
  const a = await actorOf("finance");
  const id = await seed("orphan", {
    resourceId: "0191a000-0000-7000-8000-0000000000aa",
    region: "ap-southeast-1",
    expectedMinor: 1200,
    accountId: "123456789012",
    arn: "arn:aws:lightsail:ap-southeast-1:123456789012:Instance/x",
    note: "see arn:aws:iam::123456789012:role/x",
    other: "123456789012",
    nested: { deep: 1 },
    password: "secret",
  });
  const out = await asAdmin(a, (r) => r.reconciliation.list({ kind: "orphan", limit: 100 }));
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  const row = out.value.rows.find((x) => x.id === id);
  expect(row?.kind).toBe("orphan");
  expect(row?.status).toBe("open");
  expect(row?.details).toEqual([
    { key: "resourceId", value: "0191a000-0000-7000-8000-0000000000aa" },
    { key: "region", value: "ap-southeast-1" },
    { key: "expectedMinor", value: "1200" },
  ]);
  const text = JSON.stringify(out.value);
  expect(text).not.toMatch(/arn:aws|123456789012|secret/);
  const resolved = await seed("orphan", {}, { status: "resolved" });
  const open = await asAdmin(a, (r) => r.reconciliation.list({ status: "open", limit: 100 }));
  expect(open.ok && open.value.rows.map((x) => x.id)).not.toContain(resolved);
});

it("list pages with the id of the last row and validates its input", async () => {
  const a = await actorOf();
  for (let i = 0; i < 3; i++) await seed("payment", { paymentId: uuidv7() });
  const first = await asAdmin(a, (r) => r.reconciliation.list({ kind: "payment", limit: 2 }));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.rows).toHaveLength(2);
  expect(first.value.nextAfter).toBe(first.value.rows[1]?.id);
  const next = await asAdmin(a, (r) =>
    r.reconciliation.list({ kind: "payment", limit: 2, after: first.value.nextAfter ?? "" }),
  );
  expect(next.ok && next.value.rows.length).toBeGreaterThanOrEqual(1);
  for (const bad of [
    { kind: "x" as never },
    { status: "x" as never },
    { limit: 0 },
    { limit: 1000 },
    { after: "x" },
  ]) {
    expect(await asAdmin(a, (r) => r.reconciliation.list(bad))).toEqual({
      ok: false,
      error: "validation",
    });
  }
});

it("support is refused on reads, a disabled admin too; ops, finance and superadmin read", async () => {
  const support = await actorOf("support");
  expect(await asAdmin(support, (r) => r.reconciliation.list({}))).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(await asAdmin(support, (r) => r.reconciliation.overview())).toEqual({
    ok: false,
    error: "forbidden",
  });
  for (const role of ["ops", "finance", "superadmin"] as const) {
    const a = await actorOf(role);
    expect((await asAdmin(a, (r) => r.reconciliation.overview())).ok).toBe(true);
  }
  const gone = await actorOf("ops");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [gone.adminId]);
  expect(await asAdmin(gone, (r) => r.reconciliation.list({}))).toEqual({
    ok: false,
    error: "forbidden",
  });
});

it("ops and finance resolve a discrepancy once through payments.resolveDiscrepancy: one audit row each, a replay for the second", async () => {
  const id = await seed("cost", { note: "above the plan" });
  const ops = await actorOf("ops");
  const finance = await actorOf("finance");
  expect(
    await asAdmin(ops, (r) => r.payments.resolveDiscrepancy({ id }, "checked the invoice")),
  ).toMatchObject({ ok: true, replayed: false });
  expect(
    await asAdmin(finance, (r) => r.payments.resolveDiscrepancy({ id }, "already done")),
  ).toMatchObject({ ok: true, replayed: true });
  const rows = await auditRowsOf(t.pool, ops.adminId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "discrepancy.resolve",
    target_type: "discrepancy",
    target_id: id,
    ip: "203.0.113.9",
  });
  const support = await actorOf("support");
  expect(await asAdmin(support, (r) => r.payments.resolveDiscrepancy({ id }, "no"))).toEqual({
    ok: false,
    error: "forbidden",
  });
});
