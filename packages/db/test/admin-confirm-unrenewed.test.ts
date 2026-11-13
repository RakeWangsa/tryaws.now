import { v7 as uuidv7 } from "uuid";
import { beforeAll, describe, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { auditRowsOf } from "../testing/repos";
import { runTransaction } from "../tx";
import { newAdmin, newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-X3 (b): the admin action "registry confirmed not renewed". The admin app writes an operation row
// (`confirm_unrenewed`, R1: never AWS) through `audited` (R10: actor, reason, IP, target); finance and superadmin
// only. The target must be a renew_domain stuck in needs_attention at poll; the same form again is a replay (R7).
const t = useTempDatabase();
const AT = new Date("2030-01-01T00:00:00.000Z");
let resourceId = "";
let finance: AdminActor;
let superadmin: AdminActor;
let ops: AdminActor;
let support: AdminActor;
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const actorOf = async (role: AdminActor["role"]): Promise<AdminActor> => ({
  adminId: await newAdmin(t.pool, role),
  role,
  ip: "203.0.113.9",
});
beforeAll(async () => {
  resourceId = await newResource(t.pool, await newCustomer(t.pool));
  finance = await actorOf("finance");
  superadmin = await actorOf("superadmin");
  ops = await actorOf("ops");
  support = await actorOf("support");
});
const PAYLOAD = { currentExpiryYear: 2031, currentExpiresAt: "2031-03-04T05:06:07.890Z" };
const stuck = (over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "renew_domain",
    state: "needs_attention",
    step: "poll",
    attempts: 1,
    last_error: "upstream_unavailable",
    payload: JSON.stringify(PAYLOAD),
    idempotency_key: "lifecycle:renew_domain:" + uniqueSuffix(),
    ...over,
  });
const confirmsOf = async (target: string) =>
  (
    await t.pool.query(
      "select id, kind, state, idempotency_key, payload from operations where kind = 'confirm_unrenewed' and payload->>'targetOperationId' = $1",
      [target],
    )
  ).rows;

describe("operations.confirmUnrenewed", () => {
  it("queues a confirm_unrenewed for the stuck renewal, returns the message and audits actor, reason, IP and target", async () => {
    const target = await stuck();
    const requestId = uuidv7();
    const out = await asAdmin(finance, (r) =>
      r.operations.confirmUnrenewed(
        { operationId: target, requestId, at: AT },
        "registrar support case says not renewed",
      ),
    );
    expect(out).toMatchObject({ ok: true, replayed: false });
    const rows = await confirmsOf(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "confirm_unrenewed", state: "queued" });
    expect(rows[0].payload).toEqual({ targetOperationId: target, requestId });
    expect(out.ok && out.value.message).toEqual({
      operationId: rows[0].id,
      resourceId,
      enqueueSeq: 0,
    });
    // The target is not touched by the admin: only the provisioner moves it.
    const targetRow = (await t.pool.query("select state from operations where id = $1", [target]))
      .rows[0];
    expect(targetRow.state).toBe("needs_attention");
    const audit = (await auditRowsOf(t.pool, finance.adminId)).filter(
      (x) => x.target_id === target,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "operation.confirm_unrenewed",
      target_type: "operation",
      ip: "203.0.113.9",
    });
    expect(audit[0]?.metadata.reason).toBe("registrar support case says not renewed");
  });

  it("the same form again is a replay: one operation; a new form after a kept check queues another", async () => {
    const target = await stuck();
    const requestId = uuidv7();
    const call = () =>
      asAdmin(superadmin, (r) =>
        r.operations.confirmUnrenewed({ operationId: target, requestId, at: AT }, "again"),
      );
    expect(await call()).toMatchObject({ ok: true, replayed: false });
    expect(await call()).toMatchObject({ ok: true, replayed: true });
    expect(await confirmsOf(target)).toHaveLength(1);
    expect(
      await asAdmin(superadmin, (r) =>
        r.operations.confirmUnrenewed(
          { operationId: target, requestId: uuidv7(), at: AT },
          "later",
        ),
      ),
    ).toMatchObject({ ok: true, replayed: false });
    expect(await confirmsOf(target)).toHaveLength(2);
  });

  it("refuses ops and support (forbidden), writes nothing and no audit row", async () => {
    const target = await stuck();
    for (const actor of [ops, support]) {
      expect(
        await asAdmin(actor, (r) =>
          r.operations.confirmUnrenewed({ operationId: target, requestId: uuidv7(), at: AT }, "x"),
        ),
      ).toEqual({ ok: false, error: "forbidden" });
      expect(await auditRowsOf(t.pool, actor.adminId)).toHaveLength(0);
    }
    expect(await confirmsOf(target)).toHaveLength(0);
  });

  it("refuses a target that is not a renewal stuck at poll (conflict) and an unknown one (not_found), with no audit row", async () => {
    const before = (await auditRowsOf(t.pool, finance.adminId)).length;
    const cases = [
      await stuck({ step: "submit" }),
      await stuck({ step: null }),
      await stuck({ state: "waiting" }),
      await stuck({ state: "failed" }),
      await stuck({ kind: "set_name_servers" }),
    ];
    for (const target of cases) {
      expect(
        await asAdmin(finance, (r) =>
          r.operations.confirmUnrenewed({ operationId: target, requestId: uuidv7(), at: AT }, "x"),
        ),
      ).toEqual({ ok: false, error: "conflict" });
    }
    expect(
      await asAdmin(finance, (r) =>
        r.operations.confirmUnrenewed({ operationId: uuidv7(), requestId: uuidv7(), at: AT }, "x"),
      ),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await asAdmin(finance, (r) =>
        r.operations.confirmUnrenewed({ operationId: "x", requestId: uuidv7(), at: AT }, "x"),
      ),
    ).toEqual({ ok: false, error: "validation" });
    expect((await auditRowsOf(t.pool, finance.adminId)).length).toBe(before);
  });
});

describe("operations.stuckRenewals", () => {
  it("lists the renewals stuck at poll with the last check, for finance and superadmin only", async () => {
    const target = await stuck({ attempts: 2 });
    await stuck({ step: "submit" });
    await asAdmin(finance, (r) =>
      r.operations.confirmUnrenewed({ operationId: target, requestId: uuidv7(), at: AT }, "check"),
    );
    const page = await asAdmin(finance, (r) => r.operations.stuckRenewals());
    expect(page.ok).toBe(true);
    const rows = page.ok ? page.value : [];
    const mine = rows.find((r) => r.id === target);
    expect(mine).toMatchObject({ resourceId, attempts: 2, lastError: "upstream_unavailable" });
    expect(mine?.lastCheck).toMatchObject({ state: "queued", lastError: null });
    expect(rows.every((r) => r.step === "poll" && r.state === "needs_attention")).toBe(true);
    expect((await asAdmin(superadmin, (r) => r.operations.stuckRenewals())).ok).toBe(true);
    for (const actor of [ops, support]) {
      expect(await asAdmin(actor, (r) => r.operations.stuckRenewals())).toEqual({
        ok: false,
        error: "forbidden",
      });
    }
  });
});
