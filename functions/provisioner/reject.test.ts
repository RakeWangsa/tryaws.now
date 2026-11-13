import { rejectOperation, runTransaction } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { runStep } from "./step";
import { NOW, useHarness } from "./test/harness";
import { operationRow, seedOperation, seedResource } from "./test/seed";

const { t, world, setup, message, create, resourceRow } = useHarness();

// a create that ran out of tries; its resource is still creating (the column default of resources.state)
const stuckCreate = async () => {
  const c = await create({
    state: "needs_attention",
    attempts: 5,
    last_error: "upstream_unavailable:ServiceException",
  });
  expect((await resourceRow(c.resourceId)).state).toBe("creating");
  return c;
};
// the admin rejects (Task 8): this inserts the reject_operation; the caller sends the returned message after the commit
const reject = async (target: string, at = NOW) => {
  const out = await runTransaction(t.db, (tx) => rejectOperation(tx, { operationId: target, at }), {
    role: "admin_rw",
  });
  if (!out.ok || !out.message) throw new Error("reject did not queue an operation");
  return out.message;
};

describe("reject_operation, run by the provisioner as worker_rw", () => {
  it("a rejected create reaches failed and calls the failed hook once, with the code rejected, in the same transaction", async () => {
    const events: unknown[] = [];
    const attention: unknown[] = [];
    const { deps, cloud } = setup({
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
        needsAttention: async (_tx, e) => {
          attention.push(e);
        },
      },
    });
    const target = await stuckCreate();
    const m = await reject(target.id);
    expect(await runStep(deps, m)).toMatchObject({ outcome: "advanced", to: "succeeded" });
    expect(await operationRow(t.pool, target.id)).toMatchObject({
      state: "failed",
      last_error: "rejected",
      attempts: 5,
    });
    expect(await operationRow(t.pool, m.operationId)).toMatchObject({ state: "succeeded" });
    expect(events).toEqual([
      {
        operationId: target.id,
        resourceId: target.resourceId,
        customerId: world.customerId,
        kind: "create",
        code: "rejected",
      },
    ]);
    expect(attention).toEqual([
      { operationId: target.id, resourceId: target.resourceId, kind: "create", code: "rejected" },
    ]);
    expect(cloud.createCalls).toBe(0);
  });

  it("a hook that throws rolls the whole rejection back: the target stays needs_attention, the reject operation stays running", async () => {
    const { deps } = setup({
      hooks: {
        failed: async () => {
          throw new Error("hook failed");
        },
      },
    });
    const target = await stuckCreate();
    const m = await reject(target.id);
    await expect(runStep(deps, m)).rejects.toThrow("hook failed");
    expect(await operationRow(t.pool, target.id)).toMatchObject({ state: "needs_attention" });
    expect(await operationRow(t.pool, m.operationId)).toMatchObject({ state: "running" });
  });

  it("with no failed hook a create is not rejected: the reject operation needs attention with failed_hook_missing and the target stays", async () => {
    const { deps } = setup();
    const target = await stuckCreate();
    const m = await reject(target.id);
    expect(await runStep(deps, m)).toMatchObject({ outcome: "advanced", to: "needs_attention" });
    expect(await operationRow(t.pool, m.operationId)).toMatchObject({
      state: "needs_attention",
      last_error: "failed_hook_missing",
    });
    expect(await operationRow(t.pool, target.id)).toMatchObject({ state: "needs_attention" });
  });

  it("another kind is rejected without the failed hook; the hook is not called for it", async () => {
    const events: unknown[] = [];
    const { deps } = setup({
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
      },
    });
    const target = await create({ kind: "reboot", state: "needs_attention" });
    const m = await reject(target.id);
    expect(await runStep(deps, m)).toMatchObject({ to: "succeeded" });
    expect(await operationRow(t.pool, target.id)).toMatchObject({
      state: "failed",
      last_error: "rejected",
    });
    expect(events).toEqual([]);
  });

  it("WPU-Z13: a domain renewal the registry holds (step poll) is not rejected: the reject operation needs attention with renewal_submitted, the target stays and no hook runs", async () => {
    const events: unknown[] = [];
    const attention: unknown[] = [];
    const { deps } = setup({
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
        needsAttention: async (_tx, e) => {
          attention.push(e);
        },
      },
    });
    const target = await create({
      kind: "renew_domain",
      state: "needs_attention",
      step: "poll",
      attempts: 5,
      last_error: "rate_limited:ThrottlingException",
      payload: { currentExpiryYear: 2027, years: 1 },
    });
    const m = await reject(target.id);
    expect(await runStep(deps, m)).toMatchObject({ outcome: "advanced", to: "needs_attention" });
    expect(await operationRow(t.pool, m.operationId)).toMatchObject({
      state: "needs_attention",
      last_error: "renewal_submitted",
    });
    expect(await operationRow(t.pool, target.id)).toMatchObject({
      state: "needs_attention",
      step: "poll",
      attempts: 5,
      last_error: "rate_limited:ThrottlingException",
    });
    expect(events).toEqual([]);
    expect(attention).toEqual([
      {
        operationId: m.operationId,
        resourceId: target.resourceId,
        kind: "reject_operation",
        code: "renewal_submitted",
      },
    ]);
  });

  // WPU-Y5 (c): a dns_zone create past create_zone made the hosted zone; a rejection would refund the order while the
  // zone stays. Refused like renewal_submitted: the reject operation needs attention with zone_created, the target
  // and the money stay, no hook runs.
  it("WPU-Y5: a dns_zone create at wait_insync is not rejected: zone_created, the target stays and no hook runs", async () => {
    const events: unknown[] = [];
    const attention: unknown[] = [];
    const { deps } = setup({
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
        needsAttention: async (_tx, e) => {
          attention.push(e);
        },
      },
    });
    const resourceId = await seedResource(t.pool, world, { family: "dns_zone" });
    const targetId = await seedOperation(t.pool, resourceId, {
      kind: "create",
      state: "needs_attention",
      step: "wait_insync",
      attempts: 5,
      last_error: "upstream_unavailable:NoSuchChange",
      payload: { orderId: world.orderId },
    });
    const m = await reject(targetId);
    expect(await runStep(deps, m)).toMatchObject({ outcome: "advanced", to: "needs_attention" });
    expect(await operationRow(t.pool, m.operationId)).toMatchObject({
      state: "needs_attention",
      last_error: "zone_created",
    });
    expect(await operationRow(t.pool, targetId)).toMatchObject({
      state: "needs_attention",
      step: "wait_insync",
      attempts: 5,
      last_error: "upstream_unavailable:NoSuchChange",
    });
    expect(events).toEqual([]);
    expect(attention).toEqual([
      { operationId: m.operationId, resourceId, kind: "reject_operation", code: "zone_created" },
    ]);
  });

  // WPU-Y5 (c), fix round 1: at create_zone an earlier attempt may have sent CreateHostedZone with its answer lost.
  const zoneCreate = async (over: Record<string, unknown>) => {
    const resourceId = await seedResource(t.pool, world, { family: "dns_zone" });
    const targetId = await seedOperation(t.pool, resourceId, {
      kind: "create",
      state: "needs_attention",
      payload: { orderId: world.orderId },
      ...over,
    });
    return { resourceId, targetId };
  };

  it("WPU-Y5: a dns_zone create at create_zone after an attempt (attempts > 0 or a last error) is not rejected: zone_created", async () => {
    for (const over of [
      { step: "create_zone", attempts: 5, last_error: "upstream_unavailable:ServiceException" },
      { step: "create_zone", attempts: 1 },
      { step: "create_zone", attempts: 0, last_error: "lease_expired" },
    ]) {
      const events: unknown[] = [];
      const { deps } = setup({
        hooks: {
          failed: async (_tx, e) => {
            events.push(e);
          },
        },
      });
      const { targetId } = await zoneCreate(over);
      const m = await reject(targetId);
      expect(await runStep(deps, m), JSON.stringify(over)).toMatchObject({
        to: "needs_attention",
      });
      expect(await operationRow(t.pool, m.operationId)).toMatchObject({
        state: "needs_attention",
        last_error: "zone_created",
      });
      expect(await operationRow(t.pool, targetId)).toMatchObject({
        state: "needs_attention",
        step: "create_zone",
      });
      expect(events).toEqual([]);
    }
  });

  it("WPU-Y5: a dns_zone create that cannot have sent CreateHostedZone is rejected with its refund", async () => {
    for (const over of [
      { step: null, attempts: 5, last_error: "upstream_unavailable:ServiceException" },
      { step: "create_zone", attempts: 0 },
      // the local input check of createHostedZone: the same input at every attempt, so nothing was ever sent
      { step: "create_zone", attempts: 3, last_error: "validation" },
    ]) {
      const events: unknown[] = [];
      const { deps } = setup({
        hooks: {
          failed: async (_tx, e) => {
            events.push(e);
          },
        },
      });
      const { targetId } = await zoneCreate(over);
      const m = await reject(targetId);
      expect(await runStep(deps, m), JSON.stringify(over)).toMatchObject({ to: "succeeded" });
      expect(await operationRow(t.pool, targetId)).toMatchObject({
        state: "failed",
        last_error: "rejected",
      });
      expect(events).toHaveLength(1);
    }
  });

  it("WPU-Z13 review round 2: a domain renewal at step submit (RenewDomain may have been sent, its answer lost) is not rejected either: renewal_submitted, the target stays and no hook runs", async () => {
    const events: unknown[] = [];
    const { deps } = setup({
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
      },
    });
    const target = await create({
      kind: "renew_domain",
      state: "needs_attention",
      step: "submit",
      attempts: 5,
      last_error: "upstream_unavailable:TimeoutError",
      payload: { currentExpiryYear: 2027, years: 1 },
    });
    const m = await reject(target.id);
    expect(await runStep(deps, m)).toMatchObject({ outcome: "advanced", to: "needs_attention" });
    expect(await operationRow(t.pool, m.operationId)).toMatchObject({
      state: "needs_attention",
      last_error: "renewal_submitted",
    });
    expect(await operationRow(t.pool, target.id)).toMatchObject({
      state: "needs_attention",
      step: "submit",
      attempts: 5,
      last_error: "upstream_unavailable:TimeoutError",
    });
    expect(events).toEqual([]);
  });

  it("WPU-Z13: a rejected domain renewal that the registry does not hold yet (no step) reaches failed and calls the failed hook (its charge goes back); without the hook it is not rejected", async () => {
    const events: unknown[] = [];
    const { deps } = setup({
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
      },
    });
    const target = await create({
      kind: "renew_domain",
      state: "needs_attention",
      attempts: 5,
      payload: { currentExpiryYear: 2027, years: 1 },
    });
    const m = await reject(target.id);
    expect(await runStep(deps, m)).toMatchObject({ to: "succeeded" });
    expect(await operationRow(t.pool, target.id)).toMatchObject({
      state: "failed",
      last_error: "rejected",
    });
    expect(events).toEqual([
      {
        operationId: target.id,
        resourceId: target.resourceId,
        customerId: world.customerId,
        kind: "renew_domain",
        code: "rejected",
      },
    ]);

    const bare = setup();
    const stuck = await create({ kind: "renew_domain", state: "needs_attention", attempts: 5 });
    const n = await reject(stuck.id);
    expect(await runStep(bare.deps, n)).toMatchObject({ to: "needs_attention" });
    expect(await operationRow(t.pool, n.operationId)).toMatchObject({
      last_error: "failed_hook_missing",
    });
    expect(await operationRow(t.pool, stuck.id)).toMatchObject({ state: "needs_attention" });
  });

  it("if an admin retried the target before the engine ran, the older queued target does not hold the rejection back: it does nothing and the reject operation succeeds", async () => {
    const { deps } = setup({
      hooks: {
        failed: async () => {
          throw new Error("must not run");
        },
      },
    });
    const target = await stuckCreate();
    const m = await reject(target.id);
    await t.pool.query("update operations set state = 'queued' where id = $1", [target.id]);
    expect(await runStep(deps, m)).toEqual({ outcome: "advanced", to: "succeeded", sent: false });
    expect(await operationRow(t.pool, m.operationId)).toMatchObject({ state: "succeeded" });
    expect(await operationRow(t.pool, target.id)).toMatchObject({ state: "queued" });
  });

  it("a replay posts once: the second run finds the target failed and calls no hook", async () => {
    const events: unknown[] = [];
    const { deps } = setup({
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
      },
    });
    const target = await stuckCreate();
    const m = await reject(target.id);
    await runStep(deps, m);
    await t.pool.query("update operations set state = 'queued' where id = $1", [m.operationId]);
    expect(await runStep(deps, m)).toMatchObject({ to: "succeeded" });
    expect(events).toHaveLength(1);
  });

  it("[Review Focus 6] a target of another resource is refused with owner_mismatch and nothing is written for it", async () => {
    const { deps } = setup({ hooks: { failed: async () => {} } });
    const target = await stuckCreate();
    const elsewhere = await seedResource(t.pool, world);
    const op = await seedOperation(t.pool, elsewhere, {
      kind: "reject_operation",
      payload: { targetOperationId: target.id },
    });
    expect(await runStep(deps, message(op, elsewhere))).toMatchObject({ to: "needs_attention" });
    expect(await operationRow(t.pool, op)).toMatchObject({ last_error: "owner_mismatch" });
    expect(await operationRow(t.pool, target.id)).toMatchObject({ state: "needs_attention" });
  });

  it("a payload without a UUID target is invalid_step_result", async () => {
    const { deps } = setup({ hooks: { failed: async () => {} } });
    const resourceId = await seedResource(t.pool, world);
    const op = await seedOperation(t.pool, resourceId, {
      kind: "reject_operation",
      payload: { targetOperationId: "x" },
    });
    expect(await runStep(deps, message(op, resourceId))).toMatchObject({ to: "needs_attention" });
    expect(await operationRow(t.pool, op)).toMatchObject({ last_error: "invalid_step_result" });
  });
});
