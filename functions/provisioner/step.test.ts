import { awsResourceName, createManualClock, createMemoryQueue, type QueueMessage } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "./adapters";
import { runStep } from "./step";
import { createFakeCloud, fakeInstanceAdapter } from "./test/fakes";
import { NOW, useHarness } from "./test/harness";
import { operationRow, seedResource, seedWorld } from "./test/seed";
import type { HookEvent } from "./types";

const { t, world, setup, message, create, resourceRow } = useHarness();

describe("runStep, steps that succeed", () => {
  it("a next result queues the next step, bumps the counter, patches the resource and sends after the commit", async () => {
    const { id, resourceId } = await create();
    const seen: unknown[] = [];
    const forwarded = createMemoryQueue({ clock: createManualClock(NOW) });
    const queue = {
      send: async (m: QueueMessage) => {
        seen.push(
          (await t.pool.query("select state, enqueue_seq from operations where id = $1", [id]))
            .rows[0],
        );
        await forwarded.send(m);
      },
    };
    const { deps, cloud } = setup({ queue });
    expect(await runStep(deps, message(id, resourceId))).toEqual({
      outcome: "advanced",
      to: "queued",
      sent: true,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "queued",
      step: "wait_running",
      attempts: 0,
      last_error: null,
      enqueue_seq: 1,
    });
    expect((await operationRow(t.pool, id)).next_run_at).toEqual(NOW);
    expect(seen).toEqual([{ state: "queued", enqueue_seq: 1 }]);
    expect(forwarded.messages.map((m) => [m.MessageGroupId, m.MessageDeduplicationId])).toEqual([
      [resourceId, `${id}:1`],
    ]);
    expect((await resourceRow(resourceId)).aws_name).toBe(awsResourceName("instance", resourceId));
    expect(cloud.instances.size).toBe(1);
  });

  it("a wait result waits until the time the adapter named and sends nothing", async () => {
    const { deps, queue } = setup();
    const { id, resourceId } = await create({ step: "wait_running" });
    expect(await runStep(deps, message(id, resourceId))).toEqual({
      outcome: "advanced",
      to: "waiting",
      sent: false,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "waiting",
      step: "wait_running",
      attempts: 0,
    });
    expect((await operationRow(t.pool, id)).next_run_at).toEqual(
      new Date("2026-11-11T10:00:30.000Z"),
    );
    expect(queue.depth).toBe(0);
  });

  it("a done result finishes the operation, merges the config and runs the succeeded hook", async () => {
    const events: HookEvent[] = [];
    const { deps } = setup({
      hooks: {
        succeeded: async (_tx, event) => {
          events.push(event);
        },
      },
    });
    const { id, resourceId } = await create({ step: "allocate_ip" });
    expect(await runStep(deps, message(id, resourceId))).toEqual({
      outcome: "advanced",
      to: "succeeded",
      sent: false,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "succeeded",
      attempts: 0,
      last_error: null,
    });
    expect(await resourceRow(resourceId)).toMatchObject({
      state: "active",
      config: { ip: "198.51.100.7" },
    });
    expect(events).toEqual([
      { operationId: id, resourceId, customerId: world.customerId, kind: "create" },
    ]);
  });

  it("a destroyed result sets deleted_at to the time of the record (the CHECK of resources)", async () => {
    const { deps, cloud } = setup({ destructiveGuard: async () => true });
    const { id, resourceId } = await create({
      kind: "destroy",
      needs_approval: true,
      approved_by: world.adminId,
    });
    expect(await runStep(deps, message(id, resourceId))).toMatchObject({
      outcome: "advanced",
      to: "succeeded",
    });
    expect(await resourceRow(resourceId)).toMatchObject({ state: "destroyed", deleted_at: NOW });
    expect(cloud.instances.size).toBe(0);
  });

  it("the adapter gets the context of 10.3, and its account holds the account id and the ExternalId only", async () => {
    const contexts: Record<string, unknown>[] = [];
    const spy = fakeInstanceAdapter(createFakeCloud());
    const original = spy.aws.create;
    spy.aws.create = async (ctx) => {
      contexts.push(ctx as unknown as Record<string, unknown>);
      return original(ctx);
    };
    const { deps } = setup({ adapters: createAdapterRegistry([spy]) });
    const { id, resourceId } = await create();
    await runStep(deps, message(id, resourceId));
    const ctx = contexts[0] as {
      operation: Record<string, unknown>;
      resource: Record<string, unknown>;
      account: Record<string, unknown>;
    } & Record<string, unknown>;
    expect(ctx.operation).toMatchObject({
      id,
      kind: "create",
      step: null,
      attempt: 1,
      payload: { orderId: world.orderId, note: "someone@example.test" },
    });
    expect(ctx.operation.createdAt).toBeInstanceOf(Date);
    expect(ctx.stepKey).toBe(`${id}:start`);
    expect(ctx.resource).toMatchObject({
      id: resourceId,
      customerId: world.customerId,
      family: "linux_instance",
    });
    expect(Object.keys(ctx.account).sort()).toEqual(["awsAccountId", "externalId"]);
    expect(ctx).toMatchObject({
      region: "ap-southeast-1",
      env: "staging",
      config: { plan: "nano" },
    });
  });

  it("[Review Focus 6] ctx.owned gives the customer's own resource and null for another customer's, a missing one and a non-UUID", async () => {
    const stranger = await seedWorld(t.pool);
    const answers: unknown[] = [];
    const probe = fakeInstanceAdapter(createFakeCloud());
    const original = probe.aws.create;
    probe.aws.create = async (ctx) => {
      answers.push(
        await ctx.owned(ctx.resource.id),
        await ctx.owned(stranger.resourceId),
        await ctx.owned("01a1c97d-e814-7352-b32c-d3d3ee408ab8"),
        await ctx.owned("abc"),
      );
      return original(ctx);
    };
    const { deps } = setup({ adapters: createAdapterRegistry([probe]) });
    const { id, resourceId } = await create();
    await runStep(deps, message(id, resourceId));
    expect(answers).toEqual([
      expect.objectContaining({ id: resourceId, customerId: world.customerId }),
      null,
      null,
      null,
    ]);
  });

  it("a message whose resource id differs from the operation's changes nothing: the row decides, also for the group of the next message", async () => {
    const { deps, cloud, queue } = setup();
    const { id, resourceId } = await create();
    const lyingResource = await seedResource(t.pool, world);
    expect(await runStep(deps, message(id, lyingResource))).toMatchObject({
      outcome: "advanced",
      to: "queued",
    });
    expect(cloud.instances.has(awsResourceName("instance", resourceId))).toBe(true);
    expect(cloud.instances.has(awsResourceName("instance", lyingResource))).toBe(false);
    expect((await operationRow(t.pool, id)).resource_id).toBe(resourceId);
    expect(queue.messages.map((m) => [m.MessageGroupId, m.MessageDeduplicationId])).toEqual([
      [resourceId, `${id}:1`],
    ]);
  });

  it("a succeeded hook that throws rolls the whole record back and leaves the operation running", async () => {
    const { deps } = setup({
      hooks: {
        succeeded: async () => {
          throw new Error("hook failed");
        },
      },
    });
    const { id, resourceId } = await create({ step: "allocate_ip" });
    await expect(runStep(deps, message(id, resourceId))).rejects.toThrow("hook failed");
    expect(await operationRow(t.pool, id)).toMatchObject({ state: "running" });
    expect((await resourceRow(resourceId)).state).toBe("creating");
  });

  it("[Review Focus 3] with the queue down the step is still recorded and the outcome says sent: false", async () => {
    const { deps, queue } = setup();
    const { id, resourceId } = await create();
    queue.failNextSends(1);
    expect(await runStep(deps, message(id, resourceId))).toEqual({
      outcome: "advanced",
      to: "queued",
      sent: false,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({ state: "queued", enqueue_seq: 1 });
  });

  it("a skipped or refused claim is returned as it is, and no adapter is called", async () => {
    const { deps, cloud } = setup();
    const { id, resourceId } = await create({ state: "running" });
    expect(await runStep(deps, message(id, resourceId))).toEqual({
      outcome: "skipped",
      reason: "not_runnable",
    });
    const odd = await create({ kind: "destroy" });
    expect(await runStep(deps, message(odd.id, odd.resourceId))).toEqual({
      outcome: "refused",
      code: "approval_flag_missing",
    });
    expect(cloud.createCalls).toBe(0);
  });

  it("the log line holds ids and codes only, never the payload", async () => {
    const { deps, logged } = setup();
    const { id, resourceId } = await create();
    await runStep(deps, message(id, resourceId));
    expect(logged).toEqual([
      {
        event: "operation_step",
        operationId: id,
        resourceId,
        kind: "create",
        step: "wait_running",
        outcome: "advanced",
        to: "queued",
        attempts: 0,
        sent: true,
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain("someone@example.test");
  });
});
