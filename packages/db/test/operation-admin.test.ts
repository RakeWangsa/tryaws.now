import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { approveOperation, rejectOperation, retryOperation } from "../operations/admin";
import { runTransaction, type DatabaseRole } from "../tx";
import { insertRow } from "./sql";
import { newAdmin, newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as =
  (role: DatabaseRole) =>
  <T>(fn: (tx: Tx) => Promise<T>) =>
    runTransaction(t.db, fn, { role });
const admin = as("admin_rw");
const AT = new Date("2030-01-01T00:00:00.000Z");
let resourceId = "";
let adminId = "";
beforeAll(async () => {
  resourceId = await newResource(t.pool, await newCustomer(t.pool));
  adminId = await newAdmin(t.pool, "ops");
});
const seed = (state: string, over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "reboot",
    state,
    idempotency_key: "a:" + uniqueSuffix(),
    ...over,
  });
const row = async (id: string) =>
  (await t.pool.query("select * from operations where id = $1", [id])).rows[0];
const UNKNOWN = "01a1c97d-e814-7352-b32c-d3d3ee408ab8";

describe("approveOperation", () => {
  it("queues a flagged operation with its approver and the next counter, and a replay changes nothing", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    const first = await admin((tx) => approveOperation(tx, { operationId: id, adminId, at: AT }));
    expect(first).toEqual({
      ok: true,
      replayed: false,
      message: { operationId: id, resourceId, enqueueSeq: 1 },
    });
    expect(await row(id)).toMatchObject({ state: "queued", approved_by: adminId, enqueue_seq: 1 });
    expect((await row(id)).next_run_at.getTime()).toBe(AT.getTime());
    const again = await admin((tx) => approveOperation(tx, { operationId: id, adminId, at: AT }));
    expect(again).toEqual({
      ok: true,
      replayed: true,
      message: { operationId: id, resourceId, enqueueSeq: 1 },
    });
    expect((await row(id)).enqueue_seq).toBe(1);
  });

  it("two approvals at the same moment give one winner, one replay and the counter 1", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    const both = await Promise.all([
      admin((tx) => approveOperation(tx, { operationId: id, adminId, at: AT })),
      admin((tx) => approveOperation(tx, { operationId: id, adminId, at: AT })),
    ]);
    expect(both.map((r) => r.ok && r.replayed).sort()).toEqual([false, true]);
    expect((await row(id)).enqueue_seq).toBe(1);
  });

  it("refuses an operation that is not waiting for approval and an unknown one", async () => {
    const unflagged = await seed("queued");
    expect(
      await admin((tx) => approveOperation(tx, { operationId: unflagged, adminId, at: AT })),
    ).toEqual({ ok: false, error: "conflict" });
    const rejected = await seed("failed", { needs_approval: true, kind: "destroy" });
    expect(
      await admin((tx) => approveOperation(tx, { operationId: rejected, adminId, at: AT })),
    ).toEqual({ ok: false, error: "conflict" });
    expect(
      await admin((tx) => approveOperation(tx, { operationId: UNKNOWN, adminId, at: AT })),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await admin((tx) => approveOperation(tx, { operationId: "x", adminId, at: AT })),
    ).toEqual({ ok: false, error: "not_found" });
    const flagged = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    await expect(
      admin((tx) => approveOperation(tx, { operationId: flagged, adminId: "x", at: AT })),
    ).rejects.toThrow(RangeError);
  });

  it("[Review Focus 2] an unknown or disabled admin cannot approve: forbidden, nothing written", async () => {
    const flagged = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    const disabled = await newAdmin(t.pool, "ops");
    await t.pool.query("update admin_users set status = 'disabled' where id = $1", [disabled]);
    for (const who of [UNKNOWN, disabled]) {
      expect(
        await admin((tx) => approveOperation(tx, { operationId: flagged, adminId: who, at: AT })),
      ).toEqual({ ok: false, error: "forbidden" });
    }
    expect(await row(flagged)).toMatchObject({
      state: "needs_approval",
      approved_by: null,
      enqueue_seq: 0,
    });
  });

  it("worker_rw and web_rw cannot approve: the grants give them no approved_by", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    for (const role of ["worker_rw", "web_rw"] as const) {
      await expect(
        as(role)((tx) => approveOperation(tx, { operationId: id, adminId, at: AT })),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("retryOperation", () => {
  it("queues a needs_attention operation, keeps its attempts and last error, and a replay changes nothing", async () => {
    const id = await seed("needs_attention", {
      attempts: 5,
      last_error: "upstream_unavailable:ServiceException",
      enqueue_seq: 3,
    });
    expect(await admin((tx) => retryOperation(tx, { operationId: id, at: AT }))).toEqual({
      ok: true,
      replayed: false,
      message: { operationId: id, resourceId, enqueueSeq: 4 },
    });
    expect(await row(id)).toMatchObject({
      state: "queued",
      attempts: 5,
      last_error: "upstream_unavailable:ServiceException",
      enqueue_seq: 4,
    });
    expect(await admin((tx) => retryOperation(tx, { operationId: id, at: AT }))).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect((await row(id)).enqueue_seq).toBe(4);
  });

  it("refuses failed (final), running, unknown and not-a-UUID", async () => {
    for (const state of ["failed", "running", "succeeded", "needs_approval"]) {
      const id = await seed(
        state,
        state === "needs_approval" ? { needs_approval: true, kind: "destroy" } : {},
      );
      expect(await admin((tx) => retryOperation(tx, { operationId: id, at: AT })), state).toEqual({
        ok: false,
        error: "conflict",
      });
    }
    expect(await admin((tx) => retryOperation(tx, { operationId: UNKNOWN, at: AT }))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await admin((tx) => retryOperation(tx, { operationId: "x", at: AT }))).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("rejectOperation", () => {
  it("fails an operation that waits for approval (not a create), with no message, and a replay says so", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    expect(await admin((tx) => rejectOperation(tx, { operationId: id, at: AT }))).toEqual({
      ok: true,
      replayed: false,
      message: null,
    });
    expect((await row(id)).state).toBe("failed");
    expect(await admin((tx) => rejectOperation(tx, { operationId: id, at: AT }))).toEqual({
      ok: true,
      replayed: true,
      message: null,
    });
  });

  // WPU-Y4 fix round 5 (M2): rejecting the destroy of a retained subscription whose resource lives leaves it with
  // no live destroy; an attention item is written in the same transaction (once), ids and fixed words only.
  it("a rejected retention destroy writes one attention item; one of a non-retained subscription writes none", async () => {
    const customer = await newCustomer(t.pool);
    const sub = async (status: string) => {
      const res = await newResource(t.pool, customer, { state: "suspended" });
      await insertRow(t.pool, "subscriptions", {
        resource_id: res,
        customer_id: customer,
        term_days: 30,
        price_snapshot: "{}",
        period_start: "2026-01-01T00:00:00Z",
        period_end: "2026-01-31T00:00:00Z",
        status,
      });
      return res;
    };
    const items = async (res: string) =>
      (
        await t.pool.query(
          "select kind, details from discrepancies where details ->> 'resourceId' = $1",
          [res],
        )
      ).rows;
    const retained = await sub("retained");
    const a = await insertRow(t.pool, "operations", {
      resource_id: retained,
      kind: "destroy",
      state: "needs_approval",
      needs_approval: true,
      idempotency_key: "a:" + uniqueSuffix(),
    });
    await admin((tx) => rejectOperation(tx, { operationId: a, at: AT }));
    await admin((tx) => rejectOperation(tx, { operationId: a, at: AT }));
    expect(await items(retained)).toEqual([
      {
        kind: "missing",
        details: {
          resourceId: retained,
          operationId: a,
          reason: "retention_destroy_rejected",
          source: "admin_reject",
        },
      },
    ]);
    // needs_attention: the reject is a reject_operation; the item is written once too.
    const b = await insertRow(t.pool, "operations", {
      resource_id: retained,
      kind: "destroy",
      state: "needs_attention",
      attempts: 3,
      idempotency_key: "a:" + uniqueSuffix(),
    });
    await admin((tx) => rejectOperation(tx, { operationId: b, at: AT }));
    await admin((tx) => rejectOperation(tx, { operationId: b, at: AT }));
    expect((await items(retained)).filter((r) => r.details.operationId === b)).toHaveLength(1);
    // An active subscription: nothing to note.
    const active = await sub("active");
    const c = await insertRow(t.pool, "operations", {
      resource_id: active,
      kind: "destroy",
      state: "needs_approval",
      needs_approval: true,
      idempotency_key: "a:" + uniqueSuffix(),
    });
    await admin((tx) => rejectOperation(tx, { operationId: c, at: AT }));
    expect(await items(active)).toEqual([]);
  });

  it("a create that waits for approval is not rejected here: conflict, nothing written", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "create" });
    expect(await admin((tx) => rejectOperation(tx, { operationId: id, at: AT }))).toEqual({
      ok: false,
      error: "conflict",
    });
    expect((await row(id)).state).toBe("needs_approval");
  });

  it("[Review Focus 7] a needs_attention operation is not set to failed by the admin: a reject_operation is inserted, and the target stays", async () => {
    for (const kind of ["create", "reboot"]) {
      const target = await seed("needs_attention", { kind, attempts: 5 });
      const first = await admin((tx) => rejectOperation(tx, { operationId: target, at: AT }));
      expect(first).toMatchObject({
        ok: true,
        replayed: false,
        message: { resourceId, enqueueSeq: 0 },
      });
      const messageId = first.ok && first.message ? first.message.operationId : "";
      expect(await row(target)).toMatchObject({ state: "needs_attention", attempts: 5 });
      expect(await row(messageId)).toMatchObject({
        kind: "reject_operation",
        state: "queued",
        needs_approval: false,
        idempotency_key: `reject:${target}`,
        payload: { targetOperationId: target },
        resource_id: resourceId,
      });
      const again = await admin((tx) => rejectOperation(tx, { operationId: target, at: AT }));
      expect(again).toMatchObject({
        ok: true,
        replayed: true,
        message: { operationId: messageId },
      });
    }
  });

  it("refuses a running, queued or succeeded operation and an unknown one", async () => {
    for (const state of ["running", "queued", "succeeded"]) {
      const id = await seed(state);
      expect(await admin((tx) => rejectOperation(tx, { operationId: id, at: AT })), state).toEqual({
        ok: false,
        error: "conflict",
      });
    }
    expect(await admin((tx) => rejectOperation(tx, { operationId: UNKNOWN, at: AT }))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await admin((tx) => rejectOperation(tx, { operationId: "x", at: AT }))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("a rejection after a retry is a conflict and the target stays queued", async () => {
    const id = await seed("needs_attention");
    expect(await admin((tx) => retryOperation(tx, { operationId: id, at: AT }))).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await admin((tx) => rejectOperation(tx, { operationId: id, at: AT }))).toEqual({
      ok: false,
      error: "conflict",
    });
    expect((await row(id)).state).toBe("queued");
  });

  it("a retry after a rejection is accepted too: the reject operation is queued, the target is queued, and both rows are kept", async () => {
    const id = await seed("needs_attention");
    const rejected = await admin((tx) => rejectOperation(tx, { operationId: id, at: AT }));
    expect(rejected).toMatchObject({ ok: true, replayed: false });
    expect(await admin((tx) => retryOperation(tx, { operationId: id, at: AT }))).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect((await row(id)).state).toBe("queued");
    const key = `reject:${id}`;
    expect(
      (await t.pool.query("select state from operations where idempotency_key = $1", [key])).rows,
    ).toEqual([{ state: "queued" }]);
  });
});
