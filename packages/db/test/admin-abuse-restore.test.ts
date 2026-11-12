import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer, newResource } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-B5 item 22: the admin restore lifts the suspension that the provisioner marked with
// config.adminSuspended. It writes one `resume` operation (R1) whose payload clears the mark.
const t = useTempDatabase();
const AT = new Date("2030-01-01T00:00:00.000Z");
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"] = "ops"): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
  userAgent: "test",
});
async function seedResource(over: Record<string, unknown> = {}): Promise<string> {
  return newResource(t.pool, await newCustomer(t.pool), { state: "active", ...over });
}
async function seedCase(over: Record<string, unknown> = {}): Promise<{ id: string; res: string }> {
  const res = (over["resource_id"] as string | undefined) ?? (await seedResource());
  const id = await insertRow(t.pool, "abuse_cases", {
    resource_id: res,
    source: "third_party_report",
    ...over,
  });
  return { id, res };
}
const opsOf = async (resourceId: string) =>
  (
    await t.pool.query(
      "select kind, state, needs_approval, idempotency_key, payload from operations where resource_id = $1 order by created_at",
      [resourceId],
    )
  ).rows;
const suspendedByAdmin = () =>
  seedResource({ state: "suspended", config: JSON.stringify({ adminSuspended: true }) });

it("restoreResource writes one resume operation that clears the admin mark, keyed by the case (R1, R7, R10)", async () => {
  const a = await actorOf("ops");
  const res = await suspendedByAdmin();
  // A closed case can still be restored: closing it never resumed the resource.
  const { id } = await seedCase({ resource_id: res, status: "closed" });
  const out = await asAdmin(a, (r) =>
    r.abuse.restoreResource({ caseId: id, at: AT }, "false alarm"),
  );
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.replayed).toBe(false);
  const rows = await opsOf(res);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "resume",
    state: "queued",
    needs_approval: false,
    idempotency_key: `abuse-restore:${id}`,
  });
  expect(rows[0].payload).toMatchObject({ adminSuspended: false, abuseCaseId: id });
  expect(out.value.message).toMatchObject({ resourceId: res });
  const audit = await auditRowsOf(t.pool, a.adminId);
  expect(audit[0]).toMatchObject({
    action: "abuse.restore_resource",
    target_type: "abuse_case",
    target_id: id,
  });
  expect(audit[0]?.metadata.reason).toBe("false alarm");
  const again = await asAdmin(a, (r) => r.abuse.restoreResource({ caseId: id, at: AT }, "x"));
  expect(again).toMatchObject({ ok: true, replayed: true, value: { message: null } });
  expect(await opsOf(res)).toHaveLength(1);
});

it("restoreResource is refused for support and finance, for a resource no admin suspended, for a resource that is not suspended, and for bad input", async () => {
  const res = await suspendedByAdmin();
  const { id } = await seedCase({ resource_id: res });
  for (const role of ["support", "finance"] as const) {
    const a = await actorOf(role);
    expect(await asAdmin(a, (r) => r.abuse.restoreResource({ caseId: id, at: AT }, "x"))).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await auditRowsOf(t.pool, a.adminId)).toEqual([]);
  }
  const ops = await actorOf("ops");
  // Suspended by the lifecycle (grace), not by an admin: a renewal resumes it, not this action.
  const grace = await seedCase({ resource_id: await seedResource({ state: "suspended" }) });
  expect(
    await asAdmin(ops, (r) => r.abuse.restoreResource({ caseId: grace.id, at: AT }, "x")),
  ).toEqual({ ok: false, error: "conflict" });
  const live = await seedCase({
    resource_id: await seedResource({ config: JSON.stringify({ adminSuspended: true }) }),
  });
  expect(
    await asAdmin(ops, (r) => r.abuse.restoreResource({ caseId: live.id, at: AT }, "x")),
  ).toEqual({ ok: false, error: "conflict" });
  expect(
    await asAdmin(ops, (r) => r.abuse.restoreResource({ caseId: id, at: new Date("x") }, "x")),
  ).toEqual({ ok: false, error: "validation" });
  expect(
    await asAdmin(ops, (r) => r.abuse.restoreResource({ caseId: uuidv7(), at: AT }, "x")),
  ).toEqual({ ok: false, error: "not_found" });
  expect(await opsOf(res)).toEqual([]);
  expect(await auditRowsOf(t.pool, ops.adminId)).toEqual([]);
});
