import type { OperationState } from "@tc/db";
import {
  inTransaction,
  insertRow,
  newAdmin,
  newCustomer,
  newResource,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TRANSITIONS, WORKER_TRANSITIONS } from "./states";

const pairs = (list: readonly (readonly [OperationState, OperationState])[]) =>
  list.map(([from, to]) => [from, to] as [OperationState, OperationState]);

const t = useTempDatabase();
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
    idempotency_key: "s:" + uniqueSuffix(),
    ...over,
  });
const move = (role: string, id: string, from: string, to: string, extra = "") =>
  inTransaction(t.pool, async (c) => {
    await c.query(`set local role ${role}`);
    return (
      await c.query(`update operations set state = $3 ${extra} where id = $1 and state = $2`, [
        id,
        from,
        to,
      ])
    ).rowCount;
  });

describe("PostgreSQL lets worker_rw and admin_rw make every transition of the tables", () => {
  it.each(pairs(WORKER_TRANSITIONS))(
    "worker_rw: %s -> %s, unflagged and approved",
    async (from, to) => {
      expect(await move("worker_rw", await seed(from), from, to)).toBe(1);
      const approved = await seed(from, { needs_approval: true, approved_by: adminId });
      expect(await move("worker_rw", approved, from, to)).toBe(1);
    },
  );
  it.each(pairs(ADMIN_TRANSITIONS))("admin_rw: %s -> %s", async (from, to) => {
    const flagged = from === "needs_approval";
    const id = await seed(from, flagged ? { needs_approval: true } : {});
    const extra =
      from === "needs_approval" && to === "queued" ? `, approved_by = '${adminId}'` : "";
    expect(await move("admin_rw", id, from, to, extra)).toBe(1);
  });
});

describe("and refuses the moves that would weaken R13", () => {
  it("worker_rw cannot move an unapproved flagged operation out of needs_approval, except to failed", async () => {
    for (const to of ["queued", "needs_attention", "running"]) {
      const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
      await expect(move("worker_rw", id, "needs_approval", to)).rejects.toMatchObject({
        code: "23514",
      });
    }
  });
  it("admin_rw cannot approve without writing approved_by", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    await expect(move("admin_rw", id, "needs_approval", "queued")).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("worker_rw cannot write approved_by or needs_approval at all", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    await expect(
      move("worker_rw", id, "needs_approval", "failed", `, approved_by = '${adminId}'`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      move("worker_rw", id, "needs_approval", "failed", ", needs_approval = false"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
