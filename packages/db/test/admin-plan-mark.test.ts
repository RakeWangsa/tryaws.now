import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer, newResource } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPA-P2. The plan change of a container service or a CDN, as an admin sees it, and the audited action
// that clears the failure mark. The mark is cleared by an operation (`clear_plan_change_mark`) that the
// provisioner applies to the config: the admin role has no UPDATE on resources, and the action writes
// no ledger row (R1, R5, R10).
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

async function product(awsId: string, family = "container_service"): Promise<string> {
  return insertRow(t.pool, "catalog_products", {
    family,
    aws_id: awsId + "-" + uuidv7().slice(-6),
    platform: null,
    region: "ap-southeast-1",
    specs: JSON.stringify({}),
    aws_price_usd: "10",
    billing_unit: "month",
    feature_flag: family,
    active: true,
    synced_at: AT.toISOString(),
  });
}

async function seed(config: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const resourceId = await newResource(t.pool, await newCustomer(t.pool), {
    family: "container_service",
    state: "active",
    config: JSON.stringify(config),
    ...over,
  });
  return resourceId;
}
const failed = (productId: string) => ({
  code: "conflict",
  productId,
  period: "2026-11-01T00:00:00.000Z",
});
const opsOf = async (resourceId: string) =>
  (
    await t.pool.query(
      "select kind, state, needs_approval, idempotency_key, payload from operations where resource_id = $1 order by created_at, id",
      [resourceId],
    )
  ).rows;
const count = async (table: string) =>
  Number((await t.pool.query(`select count(*)::int as n from ${table}`)).rows[0]?.n);

describe("planChange: what the admin sees", () => {
  it("gives the applied plan, the pending plan, the failure mark and the apply operations", async () => {
    const a = await actorOf("ops");
    const applied = await product("nano_1_0");
    const pending = await product("micro_1_0");
    const resourceId = await seed({
      appliedPlan: { productId: applied },
      pendingPlan: { productId: pending },
      pendingPlanFailed: failed(pending),
    });
    await insertRow(t.pool, "operations", {
      resource_id: resourceId,
      kind: "scale_container",
      state: "needs_attention",
      idempotency_key: "k-" + uuidv7(),
      payload: JSON.stringify({ productId: pending }),
      last_error: "conflict",
    });
    await insertRow(t.pool, "operations", {
      resource_id: resourceId,
      kind: "reboot",
      state: "succeeded",
      idempotency_key: "k-" + uuidv7(),
      payload: JSON.stringify({}),
    });
    const out = await asAdmin(a, (r) => r.operations.planChange(resourceId));
    if (!out.ok) throw new Error(`refused: ${out.error}`);
    const v = out.value;
    expect(v).toMatchObject({ resourceId, family: "container_service", state: "active" });
    expect(v.config.appliedPlan).toEqual({ productId: applied });
    expect(v.config.pendingPlan).toEqual({ productId: pending });
    expect(v.config.pendingPlanFailed).toEqual(failed(pending));
    expect(v.plans.map((p) => p.productId).sort()).toEqual([applied, pending].sort());
    expect(v.plans.find((p) => p.productId === pending)?.awsId).toMatch(/^micro_1_0/);
    // only the operations that apply or clear a plan, not the reboot
    expect(v.operations.map((o) => o.kind)).toEqual(["scale_container"]);
    expect(v.operations[0]).toMatchObject({ state: "needs_attention", lastError: "conflict" });
  });

  it("a resource with no plan change reads as empty, not as an error", async () => {
    const a = await actorOf("superadmin");
    const resourceId = await seed({});
    const out = await asAdmin(a, (r) => r.operations.planChange(resourceId));
    if (!out.ok) throw new Error("refused");
    expect(out.value.config).toEqual({
      appliedPlan: null,
      pendingPlan: null,
      pendingPlanFailed: null,
    });
    expect(out.value.plans).toEqual([]);
    expect(out.value.operations).toEqual([]);
  });

  it("is not_found for a missing resource and for a family that has no plan change", async () => {
    const a = await actorOf("ops");
    expect(await asAdmin(a, (r) => r.operations.planChange(uuidv7()))).toMatchObject({
      ok: false,
      error: "not_found",
    });
    const server = await seed({}, { family: "linux_instance" });
    expect(await asAdmin(a, (r) => r.operations.planChange(server))).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await asAdmin(a, (r) => r.operations.planChange("nope"))).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it.each(["finance", "support"] as const)("is refused for the %s role", async (role) => {
    const a = await actorOf(role);
    const resourceId = await seed({});
    expect(await asAdmin(a, (r) => r.operations.planChange(resourceId))).toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});

describe("clearPlanChangeMark", () => {
  const input = (resourceId: string, requestId = uuidv7()) => ({ resourceId, requestId, at: AT });

  it("queues the clear operation, audits actor, reason, IP and target, and touches no ledger row", async () => {
    const a = await actorOf("ops");
    const p = await product("micro_1_0");
    const resourceId = await seed({ pendingPlan: { productId: p }, pendingPlanFailed: failed(p) });
    const before = {
      tx: await count("ledger_transactions"),
      entries: await count("ledger_entries"),
    };
    const requestId = uuidv7();
    const out = await asAdmin(a, (r) =>
      r.operations.clearPlanChangeMark(input(resourceId, requestId), "customer fixed the cause"),
    );
    if (!out.ok) throw new Error(`refused: ${out.error}`);
    expect(out.replayed).toBe(false);
    expect(out.value.resourceId).toBe(resourceId);
    expect(out.value.message).toMatchObject({ resourceId, operationId: out.value.operationId });
    const ops = await opsOf(resourceId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "clear_plan_change_mark",
      state: "queued",
      needs_approval: false,
    });
    expect(String(ops[0]?.idempotency_key)).toContain(requestId);
    // The repository does not patch the config: the provisioner does, through the adapter.
    const cfg = (await t.pool.query("select config from resources where id = $1", [resourceId]))
      .rows[0]?.config as Record<string, unknown>;
    expect(cfg["pendingPlanFailed"]).toEqual(failed(p));
    const audit = await auditRowsOf(t.pool, a.adminId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "plan_change.clear_mark",
      target_type: "resource",
      target_id: resourceId,
      ip: "203.0.113.9",
    });
    expect(audit[0]?.metadata).toMatchObject({
      reason: "customer fixed the cause",
      before: { pendingPlanFailed: failed(p) },
    });
    expect(await count("ledger_transactions")).toBe(before.tx);
    expect(await count("ledger_entries")).toBe(before.entries);
  });

  it("the same request is a replay: one operation, no second message (R7)", async () => {
    const a = await actorOf("superadmin");
    const p = await product("micro_1_0");
    const resourceId = await seed({ pendingPlanFailed: failed(p) });
    const requestId = uuidv7();
    const first = await asAdmin(a, (r) =>
      r.operations.clearPlanChangeMark(input(resourceId, requestId), "why"),
    );
    const again = await asAdmin(a, (r) =>
      r.operations.clearPlanChangeMark(input(resourceId, requestId), "why"),
    );
    if (!first.ok || !again.ok) throw new Error("refused");
    expect(again.replayed).toBe(true);
    expect(again.value.operationId).toBe(first.value.operationId);
    expect(again.value.message).toBeNull();
    expect(await opsOf(resourceId)).toHaveLength(1);
  });

  it("refuses when there is no mark, when the family has none, and when the resource is destroyed; nothing is written", async () => {
    const a = await actorOf("ops");
    const clean = await seed({});
    const server = await seed(
      { pendingPlanFailed: failed(uuidv7()) },
      { family: "linux_instance" },
    );
    const dead = await seed(
      { pendingPlanFailed: failed(uuidv7()) },
      { state: "destroyed", deleted_at: AT.toISOString() },
    );
    for (const [id, error] of [
      [clean, "conflict"],
      [server, "not_found"],
      [dead, "conflict"],
      [uuidv7(), "not_found"],
    ] as const) {
      const out = await asAdmin(a, (r) => r.operations.clearPlanChangeMark(input(id), "why"));
      expect(out, id).toEqual({ ok: false, error });
      expect(await opsOf(id)).toEqual([]);
    }
    expect(await auditRowsOf(t.pool, a.adminId)).toHaveLength(0);
  });

  it("needs a reason, a well-formed request and the ops or superadmin role", async () => {
    const a = await actorOf("ops");
    const resourceId = await seed({ pendingPlanFailed: failed(uuidv7()) });
    for (const reason of ["", "   ", "x".repeat(501)]) {
      expect(
        await asAdmin(a, (r) => r.operations.clearPlanChangeMark(input(resourceId), reason)),
      ).toEqual({ ok: false, error: "validation" });
    }
    for (const bad of [
      { resourceId: "nope", requestId: uuidv7(), at: AT },
      { resourceId, requestId: "nope", at: AT },
      { resourceId, requestId: uuidv7(), at: new Date(Number.NaN) },
    ]) {
      expect(await asAdmin(a, (r) => r.operations.clearPlanChangeMark(bad, "why"))).toEqual({
        ok: false,
        error: "validation",
      });
    }
    for (const role of ["finance", "support"] as const) {
      const other = await actorOf(role);
      expect(
        await asAdmin(other, (r) => r.operations.clearPlanChangeMark(input(resourceId), "why")),
      ).toEqual({ ok: false, error: "forbidden" });
    }
    expect(await opsOf(resourceId)).toEqual([]);
    expect(await auditRowsOf(t.pool, a.adminId)).toHaveLength(0);
  });
});
