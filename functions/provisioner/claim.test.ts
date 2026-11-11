import { createManualClock, type QueueMessage } from "@tc/core";
import { newCustomer, newOrder, newResource, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { claimStep } from "./claim";
import type { ClaimDeps, DestructiveGuard } from "./types";
import {
  operationRow,
  putApprovalUntil,
  seedOperation,
  seedResource,
  seedWorld,
  workerTx,
  type World,
} from "./test/seed";

const t = useTempDatabase();
let world: World;
beforeAll(async () => {
  world = await seedWorld(t.pool);
});
const NOW = new Date("2026-11-11T10:00:00.000Z");
const LATE = new Date("2026-12-02T00:00:00.000Z");
const message = (operationId: string): QueueMessage => ({
  operationId,
  resourceId: world.resourceId,
  enqueueSeq: 0,
});
const deps = (over: Partial<ClaimDeps> = {}, at = NOW): ClaimDeps => ({
  runTx: workerTx(t.db),
  clock: createManualClock(at),
  hasAdapter: (family) => family === "linux_instance",
  ...over,
});
const fresh = () => seedResource(t.pool, world);

describe("claimStep", () => {
  it("claims a queued operation: running, a lease 120 seconds ahead, attempts and step untouched", async () => {
    const id = await seedOperation(t.pool, await fresh(), { step: "wait_running", attempts: 2 });
    const out = await claimStep(deps(), message(id));
    expect(out).toMatchObject({ status: "run", leaseUntil: new Date("2026-11-11T10:02:00.000Z") });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "running",
      step: "wait_running",
      attempts: 2,
    });
    expect((await operationRow(t.pool, id)).next_run_at).toEqual(
      new Date("2026-11-11T10:02:00.000Z"),
    );
  });

  it("[Review Focus 1] an unknown, running, waiting, finished or unapproved operation is skipped and nothing changes", async () => {
    expect(await claimStep(deps(), message("01a1c97d-e814-7352-b32c-d3d3ee408ab8"))).toEqual({
      status: "skipped",
      reason: "not_found",
    });
    for (const state of ["running", "waiting", "succeeded", "failed", "needs_attention"]) {
      const id = await seedOperation(t.pool, await fresh(), { state, attempts: 1 });
      expect(await claimStep(deps(), message(id)), state).toEqual({
        status: "skipped",
        reason: "not_runnable",
      });
      expect(await operationRow(t.pool, id)).toMatchObject({ state, attempts: 1 });
    }
    const flagged = await seedOperation(t.pool, await fresh(), {
      state: "needs_approval",
      needs_approval: true,
      kind: "destroy",
    });
    expect(await claimStep(deps(), message(flagged))).toEqual({
      status: "skipped",
      reason: "not_runnable",
    });
  });

  it("a queued operation whose next_run_at is still ahead (clock skew) runs", async () => {
    const id = await seedOperation(t.pool, await fresh(), {
      next_run_at: new Date(NOW.getTime() + 10_000),
    });
    expect((await claimStep(deps(), message(id))).status).toBe("run");
  });

  it("[Review Focus 2] a destructive operation without the flag is refused before the cutoff, and the guard is not asked", async () => {
    const guard = vi.fn<DestructiveGuard>(async () => true);
    const id = await seedOperation(t.pool, await fresh(), { kind: "destroy" });
    expect(await claimStep(deps({ destructiveGuard: guard }), message(id))).toEqual({
      status: "refused",
      code: "approval_flag_missing",
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "needs_attention",
      last_error: "approval_flag_missing",
      attempts: 0,
    });
    expect(guard).not.toHaveBeenCalled();
  });

  it("a destructive operation runs only through the guard, inside the claim transaction", async () => {
    const approved = { needs_approval: true, approved_by: world.adminId, kind: "destroy" };
    const yes = vi.fn<DestructiveGuard>(async () => true);
    const a = await seedOperation(t.pool, await fresh(), approved);
    expect((await claimStep(deps({ destructiveGuard: yes }), message(a))).status).toBe("run");
    expect(yes).toHaveBeenCalledTimes(1);
    expect(yes.mock.calls[0]?.[1].operation.id).toBe(a);
    const b = await seedOperation(t.pool, await fresh(), approved);
    expect(await claimStep(deps({ destructiveGuard: async () => false }), message(b))).toEqual({
      status: "refused",
      code: "destructive_guard_refused",
    });
    const c = await seedOperation(t.pool, await fresh(), approved);
    expect(await claimStep(deps(), message(c))).toEqual({
      status: "refused",
      code: "destructive_guard_missing",
    });
    expect(await operationRow(t.pool, c)).toMatchObject({
      state: "needs_attention",
      last_error: "destructive_guard_missing",
    });
    const late = await seedOperation(t.pool, await fresh(), { kind: "purge_snapshots" });
    expect(
      (await claimStep(deps({ destructiveGuard: async () => true }, LATE), message(late))).status,
    ).toBe("run");
  });

  it("an unplaced resource, a family without adapter and an unknown kind need attention with their code", async () => {
    const unplaced = await newResource(t.pool, world.customerId);
    const a = await seedOperation(t.pool, unplaced);
    expect(await claimStep(deps(), message(a))).toEqual({
      status: "refused",
      code: "resource_unplaced",
    });
    const b = await seedOperation(t.pool, await fresh());
    expect(await claimStep(deps({ hasAdapter: () => false }), message(b))).toEqual({
      status: "refused",
      code: "no_adapter",
    });
    const c = await seedOperation(t.pool, await fresh(), { kind: "teleport" });
    expect(await claimStep(deps(), message(c))).toEqual({
      status: "refused",
      code: "unknown_kind",
    });
    for (const [id, code] of [
      [a, "resource_unplaced"],
      [b, "no_adapter"],
      [c, "unknown_kind"],
    ]) {
      expect(await operationRow(t.pool, id as string)).toMatchObject({
        state: "needs_attention",
        last_error: code,
      });
    }
  });

  it("a younger operation of the same resource waits 60 seconds behind an older active one, without an attempt", async () => {
    const resource = await fresh();
    const older = await seedOperation(t.pool, resource);
    const younger = await seedOperation(t.pool, resource);
    expect(await claimStep(deps(), message(younger))).toEqual({
      status: "skipped",
      reason: "blocked",
    });
    expect(await operationRow(t.pool, younger)).toMatchObject({ state: "waiting", attempts: 0 });
    expect((await operationRow(t.pool, younger)).next_run_at).toEqual(
      new Date("2026-11-11T10:01:00.000Z"),
    );
    expect((await claimStep(deps(), message(older))).status).toBe("run");
  });

  it("[Review Focus 6] an operation for a resource of another customer needs attention with owner_mismatch, and no adapter runs", async () => {
    const stranger = await newCustomer(t.pool);
    const resource = await fresh();
    const byKey = await seedOperation(t.pool, resource, {
      idempotency_key: `customer:${stranger}:k-1`,
    });
    expect(await claimStep(deps(), message(byKey))).toEqual({
      status: "refused",
      code: "owner_mismatch",
    });
    const ownKey = await seedOperation(t.pool, resource, {
      idempotency_key: `customer:${world.customerId}:k-2`,
    });
    expect((await claimStep(deps(), message(ownKey))).status).toBe("run");
    const otherOrder = await newOrder(t.pool, stranger);
    const create = await seedOperation(t.pool, await fresh(), {
      kind: "create",
      payload: { orderId: otherOrder },
    });
    expect(await claimStep(deps(), message(create))).toEqual({
      status: "refused",
      code: "owner_mismatch",
    });
    const noOrder = await seedOperation(t.pool, await fresh(), {
      kind: "create",
      payload: { orderId: "o-1" },
    });
    expect(await claimStep(deps(), message(noOrder))).toEqual({
      status: "refused",
      code: "owner_mismatch",
    });
    const ownOrder = await seedOperation(t.pool, await fresh(), {
      kind: "create",
      payload: { orderId: world.orderId },
    });
    expect((await claimStep(deps(), message(ownOrder))).status).toBe("run");
  });

  it("[Review Focus 8] a create on a resource that is not creating, and anything on a destroyed resource, needs attention with resource_state", async () => {
    const active = await seedResource(t.pool, world, { state: "active" });
    const a = await seedOperation(t.pool, active, {
      kind: "create",
      payload: { orderId: world.orderId },
    });
    expect(await claimStep(deps(), message(a))).toEqual({
      status: "refused",
      code: "resource_state",
    });
    const destroyed = await seedResource(t.pool, world, { state: "destroyed", deleted_at: NOW });
    const b = await seedOperation(t.pool, destroyed);
    expect(await claimStep(deps(), message(b))).toEqual({
      status: "refused",
      code: "resource_state",
    });
    expect(await operationRow(t.pool, b)).toMatchObject({
      state: "needs_attention",
      last_error: "resource_state",
    });
  });

  it("the end date is read from the setting each time: a missing row fails closed", async () => {
    const id = await seedOperation(t.pool, await fresh(), { kind: "destroy" });
    await t.pool.query(
      "update settings set value = '\"2027-01-31T00:00:00.000Z\"'::jsonb where key = 'r13_approval_until'",
    );
    try {
      expect(
        await claimStep(deps({ destructiveGuard: async () => true }, LATE), message(id)),
      ).toEqual({ status: "refused", code: "approval_flag_missing" });
      const again = await seedOperation(t.pool, await fresh(), { kind: "destroy" });
      await t.pool.query("delete from settings where key = 'r13_approval_until'");
      expect(
        await claimStep(deps({ destructiveGuard: async () => true }, LATE), message(again)),
      ).toEqual({ status: "refused", code: "approval_flag_missing" });
    } finally {
      await t.pool.query("delete from settings where key = 'r13_approval_until'");
      await putApprovalUntil(t.pool);
    }
  });

  it("[R16] a guard that throws makes the claim fail, and the operation stays queued with no attempt counted", async () => {
    const id = await seedOperation(t.pool, await fresh(), {
      kind: "destroy",
      needs_approval: true,
      approved_by: world.adminId,
      attempts: 1,
    });
    const guard = async () => {
      throw new Error("guard failed");
    };
    await expect(claimStep(deps({ destructiveGuard: guard }), message(id))).rejects.toThrow(
      "guard failed",
    );
    expect(await operationRow(t.pool, id)).toMatchObject({ state: "queued", attempts: 1 });
  });

  it("a refusal calls the attention hook in the claim transaction, with the code", async () => {
    const seen: unknown[] = [];
    const id = await seedOperation(t.pool, await fresh(), { kind: "teleport" });
    await claimStep(
      deps({
        onAttention: async (_tx, e) => {
          seen.push(e);
        },
      }),
      message(id),
    );
    expect(seen).toEqual([
      { operationId: id, resourceId: expect.any(String), kind: "teleport", code: "unknown_kind" },
    ]);
  });

  it("reject_operation needs no adapter and no placement", async () => {
    const unplaced = await newResource(t.pool, world.customerId);
    const id = await seedOperation(t.pool, unplaced, {
      kind: "reject_operation",
      payload: { targetOperationId: "01a1c97d-e814-7352-b32c-d3d3ee408ab8" },
    });
    expect((await claimStep(deps({ hasAdapter: () => false }), message(id))).status).toBe("run");
  });

  it("an older operation that an admin retried waits for a younger one that is running", async () => {
    const resource = await fresh();
    const retried = await seedOperation(t.pool, resource);
    await seedOperation(t.pool, resource, {
      state: "running",
      next_run_at: new Date(NOW.getTime() + 60_000),
    });
    expect(await claimStep(deps(), message(retried))).toEqual({
      status: "skipped",
      reason: "blocked",
    });
  });

  it("a needs_attention or needs_approval operation of the resource does not block a younger one", async () => {
    const resource = await fresh();
    await seedOperation(t.pool, resource, { state: "needs_attention" });
    await seedOperation(t.pool, resource, {
      state: "needs_approval",
      needs_approval: true,
      kind: "destroy",
    });
    const id = await seedOperation(t.pool, resource);
    expect((await claimStep(deps(), message(id))).status).toBe("run");
  });
});
