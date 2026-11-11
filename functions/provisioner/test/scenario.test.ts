import {
  DEAD_LETTER_ALARM,
  PROVISIONING_QUEUE,
  awsResourceName,
  createManualClock,
  createMemoryQueue,
  firstMessage,
  makeEnqueueOperation,
  sendAfterCommit,
  sweepOperations,
  toFifoInput,
  type QueueMessage,
} from "@tc/core";
import { approveOperation, runTransaction } from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../adapters";
import { createHandler } from "../index";
import type { StepDeps } from "../types";
import { createFakeCloud, fakeAccess, fakeInstanceAdapter } from "./fakes";
import { useHarness } from "./harness";
import { operationRow, seedCreate, seedOperation, seedResource, workerTx } from "./seed";

const { t, world } = useHarness();
// a sweep selects every due row of the database, so each scenario starts with an empty operations table
beforeEach(async () => {
  await t.pool.query("delete from operations");
});

function engine(start: Date, over: Partial<StepDeps> = {}) {
  const clock = createManualClock(start);
  const queue = createMemoryQueue({ clock });
  const cloud = createFakeCloud();
  const sent: { id: string; atMs: number }[] = [];
  const recording = {
    send: async (m: QueueMessage) => {
      sent.push({
        id: `${m.operationId}:${m.enqueueSeq}`,
        atMs: clock.now().getTime() - start.getTime(),
      });
      await queue.send(m);
    },
  };
  const deps: StepDeps = {
    runTx: workerTx(t.db),
    clock,
    queue: recording,
    adapters: createAdapterRegistry([fakeInstanceAdapter(cloud)]),
    access: fakeAccess(),
    env: "staging",
    log: () => {},
    ...over,
  };
  const handler = createHandler(deps);
  const sweep = () => sweepOperations({ runTx: deps.runTx, clock, queue: recording });
  // what the event source mapping does: deliver, delete what succeeded, give back what failed
  const pump = async () => {
    const received = queue.receive();
    // a batch of one record that fails makes the handler throw (Task 14); SQS then gives every record back
    let failed: Set<string>;
    try {
      const out = await handler({
        Records: received.map((m) => ({ messageId: m.messageId, body: m.body })),
      });
      failed = new Set(out.batchItemFailures.map((f) => f.itemIdentifier));
    } catch {
      failed = new Set(received.map((m) => m.messageId));
    }
    for (const m of received) {
      if (failed.has(m.messageId)) queue.release(m.messageId);
      else queue.delete(m.messageId);
    }
  };
  const drain = async () => {
    for (let i = 0; i < 20 && queue.depth > 0; i++) await pump();
  };
  return { clock, queue, cloud, sent, deps, sweep, pump, drain };
}

describe("the three proofs of the backlog row, on fakes", () => {
  it("a create with two wait steps completes through the queue, the sweeper and the batch handler; its first message was lost and the sweeper sent it 120 seconds after the commit", async () => {
    const resourceId = await seedResource(t.pool, world);
    const { operationId } = await runTransaction(
      t.db,
      (tx) =>
        makeEnqueueOperation({ now: () => new Date() })(tx, {
          resourceId,
          kind: "create",
          payload: { orderId: world.orderId },
          idempotencyKey: `order:${world.orderId}:create`,
        }),
      { role: "web_rw" },
    );
    // the database stamped next_run_at when the operation committed (web_rw cannot write it). It keeps microseconds and a JavaScript Date keeps
    // milliseconds, so the test clock starts 1 ms after the stamp: then "120 seconds old" is exactly 120 seconds on the clock
    const committedAt = new Date(
      ((await operationRow(t.pool, operationId)).next_run_at as Date).getTime() + 1,
    );
    const done: string[] = [];
    const e = engine(committedAt, {
      hooks: {
        succeeded: async (_tx, ev) => {
          done.push(ev.operationId);
        },
      },
    });
    // the commit is done and the send is lost (the queue is down)
    e.queue.failNextSends(1);
    expect(await sendAfterCommit(e.queue, firstMessage(operationId, resourceId))).toBe(false);

    e.clock.advance(60);
    expect((await e.sweep()).sent).toBe(0);
    e.clock.advance(60);
    expect((await e.sweep()).sent).toBe(1);
    await e.drain();
    for (
      let minute = 0;
      minute < 8 && (await operationRow(t.pool, operationId)).state !== "succeeded";
      minute++
    ) {
      e.clock.advance(60);
      await e.sweep();
      await e.drain();
    }

    expect(await operationRow(t.pool, operationId)).toMatchObject({
      state: "succeeded",
      attempts: 0,
      last_error: null,
    });
    expect(
      (
        await t.pool.query("select state, aws_name, config from resources where id = $1", [
          resourceId,
        ])
      ).rows[0],
    ).toEqual({
      state: "active",
      aws_name: awsResourceName("instance", resourceId),
      config: { ip: "198.51.100.7" },
    });
    expect(e.cloud.instances.size).toBe(1);
    expect(done).toEqual([operationId]);
    expect(e.sent[0]).toEqual({ id: `${operationId}:1`, atMs: 120_000 });
    expect(e.sent.map((s) => s.id)).toEqual([1, 2, 3, 4, 5].map((n) => `${operationId}:${n}`));
    expect(e.queue.depth).toBe(0);
  });

  it("[Review Focus 2] a destructive operation waits for an admin for days, and runs only after approval and the guard", async () => {
    let guardCalls = 0;
    const e = engine(new Date("2026-11-11T10:00:00Z"), {
      destructiveGuard: async () => {
        guardCalls++;
        return true;
      },
    });
    const resourceId = await seedResource(t.pool, world);
    e.cloud.instances.set(awsResourceName("instance", resourceId), {
      polls: 3,
      ip: "198.51.100.7",
    });
    const { operationId } = await runTransaction(
      t.db,
      (tx) =>
        makeEnqueueOperation(e.clock)(tx, {
          resourceId,
          kind: "destroy",
          payload: {},
          idempotencyKey: "lifecycle:s-1:2026-11-11:destroy",
          needsApproval: false,
        }),
      { role: "worker_rw" },
    );
    expect((await operationRow(t.pool, operationId)).state).toBe("needs_approval");

    e.clock.advance(3 * 86_400);
    expect((await e.sweep()).sent).toBe(0);
    await createHandler(e.deps)({
      Records: [
        {
          messageId: "forged",
          body: toFifoInput(firstMessage(operationId, resourceId)).MessageBody,
        },
      ],
    });
    expect(await operationRow(t.pool, operationId)).toMatchObject({ state: "needs_approval" });
    expect(guardCalls).toBe(0);
    expect(e.cloud.destroyCalls).toBe(0);

    const approved = await runTransaction(
      t.db,
      (tx) => approveOperation(tx, { operationId, adminId: world.adminId, at: e.clock.now() }),
      { role: "admin_rw" },
    );
    expect(approved).toMatchObject({ ok: true, replayed: false });
    if (approved.ok && approved.message)
      expect(await sendAfterCommit(e.queue, approved.message)).toBe(true);
    await e.drain();
    expect(await operationRow(t.pool, operationId)).toMatchObject({ state: "succeeded" });
    expect(guardCalls).toBe(1);
    expect(e.cloud.destroyCalls).toBe(1);

    // a destructive row without the flag, as a buggy writer would insert it, never reaches the adapter
    const rogueResource = await seedResource(t.pool, world);
    const rogue = await seedOperation(t.pool, rogueResource, { kind: "destroy" });
    await sendAfterCommit(e.queue, firstMessage(rogue, rogueResource));
    await e.drain();
    expect(await operationRow(t.pool, rogue)).toMatchObject({
      state: "needs_attention",
      last_error: "approval_flag_missing",
    });
    expect(e.cloud.destroyCalls).toBe(1);
  });

  it("[Review Focus 5] a message that is not a message reaches the dead-letter queue after 5 receives, the alarm condition holds, and the group is free again for the good message behind it", async () => {
    const e = engine(new Date("2026-11-11T10:00:00Z"));
    const resourceId = await seedResource(t.pool, world);
    const good = await seedCreate(t.pool, world, resourceId);
    e.queue.sendRaw({
      MessageBody: "{not json",
      MessageGroupId: resourceId,
      MessageDeduplicationId: "poison:0",
    });
    await sendAfterCommit(e.queue, firstMessage(good, resourceId));
    for (let i = 0; i < PROVISIONING_QUEUE.maxReceiveCount; i++) await e.pump();
    expect(e.queue.deadLetters.map((d) => d.MessageDeduplicationId)).toEqual(["poison:0"]);
    expect(e.queue.deadLetters.length).toBeGreaterThan(DEAD_LETTER_ALARM.threshold);
    expect(e.cloud.createCalls).toBe(0);
    await e.drain();
    // the good create ran: the adapter was called once, the first step led to the first wait of the fake adapter
    expect(e.cloud.createCalls).toBe(1);
    expect(await operationRow(t.pool, good)).toMatchObject({
      state: "waiting",
      step: "wait_running",
      attempts: 0,
      last_error: null,
    });
    expect(e.queue.depth).toBe(0);
  });
});
