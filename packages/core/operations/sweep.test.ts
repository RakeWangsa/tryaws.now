import {
  insertRow,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { LEASE_SECONDS } from "./policy";
import { createManualClock } from "./manual-clock";
import { PROVISIONING_QUEUE } from "./queue-config";
import { createMemoryQueue } from "./queue";
import { SWEEP_LIMIT, sweepOperations } from "./sweep";

const t = useTempDatabase();
const T = new Date("2000-01-01T01:00:00.000Z");
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
let resourceId = "";
beforeAll(async () => {
  resourceId = await newResource(t.pool, await newCustomer(t.pool));
});
beforeEach(async () => {
  await t.pool.query("delete from operations");
});
const seed = (state: string, over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "reboot",
    state,
    idempotency_key: "w:" + uniqueSuffix(),
    ...over,
  });
const row = async (id: string) =>
  (await t.pool.query("select * from operations where id = $1", [id])).rows[0];
const setup = () => {
  const clock = createManualClock(T);
  const queue = createMemoryQueue({ clock });
  const sweep = (limit?: number) =>
    sweepOperations({
      runTx: (fn) => runTransaction(t.db, fn, { role: "worker_rw" }),
      clock,
      queue,
      limit,
    });
  return { clock, queue, sweep };
};
const sentIds = (q: ReturnType<typeof createMemoryQueue>) =>
  q.messages.map((m) => (JSON.parse(m.MessageBody) as { operationId: string }).operationId);

it("every table of the sweep: who is released, resent, recovered, escalated and who is left alone", async () => {
  const { queue, sweep } = setup();
  const qOld = await seed("queued", { next_run_at: at(-180) });
  const qEdge = await seed("queued", { next_run_at: at(-120) });
  const qNew = await seed("queued", { next_run_at: at(-60) });
  const wDue = await seed("waiting", { next_run_at: at(-30) });
  const wLater = await seed("waiting", { next_run_at: at(60) });
  const rStale = await seed("running", { next_run_at: at(-90), attempts: 1 });
  const rLive = await seed("running", { next_run_at: at(60) });
  const approval = await seed("needs_approval", {
    needs_approval: true,
    kind: "destroy",
    next_run_at: at(-500),
  });
  const attention = await seed("needs_attention", { next_run_at: at(-500) });
  expect(await sweep()).toEqual({
    released: 1,
    resent: 2,
    recovered: 1,
    escalated: 0,
    sent: 3,
    sendFailures: 0,
  });
  for (const id of [qOld, qEdge, wDue]) {
    expect(await row(id)).toMatchObject({ state: "queued", enqueue_seq: 1 });
  }
  expect((await row(qOld)).next_run_at.getTime()).toBe(T.getTime());
  expect(await row(rStale)).toMatchObject({
    state: "waiting",
    attempts: 2,
    last_error: "lease_expired",
  });
  expect((await row(rStale)).next_run_at.getTime()).toBe(at(120).getTime());
  for (const id of [qNew, wLater, rLive, approval, attention]) {
    expect((await row(id)).enqueue_seq).toBe(0);
  }
  expect(queue.deadLetters).toEqual([]);
  expect(queue.messages.map((m) => m.MessageDeduplicationId)).toEqual([
    `${qOld}:1`,
    `${qEdge}:1`,
    `${wDue}:1`,
  ]);
  expect(queue.messages.every((m) => m.MessageGroupId === resourceId)).toBe(true);
});

it("[Review Focus 3] a queued operation whose message was lost is sent at 120 seconds and not before", async () => {
  const { clock, queue, sweep } = setup();
  const id = await seed("queued", { next_run_at: at(-119) });
  expect(await sweep()).toMatchObject({ resent: 0, sent: 0 });
  clock.advance(1);
  expect(await sweep()).toMatchObject({ resent: 1, sent: 1 });
  expect(sentIds(queue)).toEqual([id]);
  expect(await row(id)).toMatchObject({ enqueue_seq: 1 });
});

it("with a 60-second schedule the latest pick-up is 180 seconds after the commit", async () => {
  const { clock, queue, sweep } = setup();
  const justAfterASweep = await seed("queued", { next_run_at: at(1) });
  const exact = await seed("queued", { next_run_at: at(0) });
  const pickedAt: Record<string, number> = {};
  for (let minute = 1; minute <= 3; minute++) {
    clock.advance(60);
    await sweep();
    for (const id of sentIds(queue)) pickedAt[id] ??= clock.now().getTime() - T.getTime();
  }
  expect(pickedAt[exact]).toBe(120_000);
  expect(pickedAt[justAfterASweep]).toBe(180_000);
});

it("[Review Focus 3] with the queue down the sweep still commits, and the next sweep sends again with the next counter", async () => {
  const { clock, queue, sweep } = setup();
  const id = await seed("queued", { next_run_at: at(-300) });
  queue.failNextSends(1);
  expect(await sweep()).toMatchObject({ resent: 1, sent: 0, sendFailures: 1 });
  expect(await row(id)).toMatchObject({ state: "queued", enqueue_seq: 1 });
  expect(await sweep()).toMatchObject({ resent: 0 });
  clock.advance(120);
  expect(await sweep()).toMatchObject({ resent: 1, sent: 1, sendFailures: 0 });
  expect((await row(id)).enqueue_seq).toBe(2);
  expect(queue.messages.map((m) => m.MessageDeduplicationId)).toEqual([`${id}:2`]);
});

it("[Review Focus 4] a lease that expires for the 5th time needs attention, and an unknown kind needs attention at once", async () => {
  const { sweep } = setup();
  const fifth = await seed("running", { next_run_at: at(-1), attempts: 4 });
  const odd = await seed("running", { next_run_at: at(-1), kind: "teleport" });
  expect(await sweep()).toMatchObject({ recovered: 0, escalated: 2 });
  expect(await row(fifth)).toMatchObject({
    state: "needs_attention",
    attempts: 5,
    last_error: "lease_expired",
  });
  expect(await row(odd)).toMatchObject({ state: "needs_attention", last_error: "unknown_kind" });
});

it("the attention hook runs inside the sweep for every operation that needs attention, and a throwing hook rolls the sweep back", async () => {
  const { clock, queue } = setup();
  const fifth = await seed("running", { next_run_at: at(-1), attempts: 4 });
  const seen: unknown[] = [];
  const sweep = (onAttention: (tx: unknown, e: unknown) => Promise<void>) =>
    sweepOperations({
      runTx: (fn) => runTransaction(t.db, fn, { role: "worker_rw" }),
      clock,
      queue,
      onAttention: onAttention as never,
    });
  await expect(
    sweep(async () => {
      throw new Error("hook failed");
    }),
  ).rejects.toThrow("hook failed");
  expect(await row(fifth)).toMatchObject({ state: "running", attempts: 4 });
  await sweep(async (_tx, e) => {
    seen.push(e);
  });
  expect(seen).toEqual([{ operationId: fifth, resourceId, kind: "reboot", code: "lease_expired" }]);
  expect((await row(fifth)).state).toBe("needs_attention");
});

it("two sweeps at the same moment send every due operation once", async () => {
  const { queue, sweep } = setup();
  const made = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => seed("queued", { next_run_at: at(-200 - n) })),
  );
  const [a, b] = await Promise.all([sweep(), sweep()]);
  expect(a.sent + b.sent).toBe(5);
  for (const id of made) expect((await row(id)).enqueue_seq).toBe(1);
  expect(queue.depth).toBe(5);
});

it("the limit caps one sweep, and the next one takes the rest", async () => {
  const { sweep } = setup();
  await Promise.all([1, 2, 3, 4, 5].map((n) => seed("queued", { next_run_at: at(-200 - n) })));
  expect(SWEEP_LIMIT).toBe(100);
  expect((await sweep(2)).sent).toBe(2);
  expect((await sweep(2)).sent).toBe(2);
  expect((await sweep(2)).sent).toBe(1);
});

it("[Review Focus 4] a run that uses the whole function timeout is still inside its lease, and the sweeper takes it over once the lease has passed", async () => {
  const { clock, sweep } = setup();
  // what the claim of Task 11 writes: a running row whose lease ends LEASE_SECONDS after the claim at T
  const id = await seed("running", { next_run_at: at(LEASE_SECONDS), attempts: 0 });
  clock.advance(PROVISIONING_QUEUE.functionTimeoutSeconds);
  expect(await sweep()).toMatchObject({ recovered: 0, escalated: 0 });
  expect(await row(id)).toMatchObject({ state: "running", attempts: 0 });
  clock.advance(LEASE_SECONDS - PROVISIONING_QUEUE.functionTimeoutSeconds);
  expect(await sweep()).toMatchObject({ recovered: 1 });
  expect(await row(id)).toMatchObject({
    state: "waiting",
    attempts: 1,
    last_error: "lease_expired",
  });
});
