import { AwsError } from "@tc/aws";
import { awsResourceName, parseMessageBody, stepNext, sweepOperations } from "@tc/core";
import { retryOperation, runTransaction } from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createAdapterRegistry } from "./adapters";
import { runStep } from "./step";
import { createFakeCloud, fakeInstanceAdapter } from "./test/fakes";
import { NOW, useHarness } from "./test/harness";
import { operationRow, seedCreate, seedResource } from "./test/seed";

const { t, world, setup, message, create, resourceRow } = useHarness();
// a sweep selects every due row of the database, so each test starts with an empty operations table (every test seeds its own rows)
beforeEach(async () => {
  await t.pool.query("delete from operations");
});

const retryableError = () =>
  new AwsError({
    code: "upstream_unavailable",
    retryable: true,
    awsErrorName: "ServiceException",
    operation: "CreateInstances",
  });
const throwing = (error: unknown) => {
  const adapter = fakeInstanceAdapter(createFakeCloud());
  adapter.aws.create = async () => {
    throw error;
  };
  adapter.aws.action = async () => {
    throw error;
  };
  return adapter;
};
const registry = (...adapters: ReturnType<typeof fakeInstanceAdapter>[]) =>
  createAdapterRegistry(adapters);

describe("runStep, steps that fail", () => {
  it("a step retried three times creates one resource", async () => {
    const { deps, cloud, clock, queue } = setup();
    cloud.loseAnswers = 2;
    const { id, resourceId } = await create();
    const sweep = () => sweepOperations({ runTx: deps.runTx, clock, queue });
    const pump = async () => {
      for (const m of queue.receive()) {
        await runStep(deps, parseMessageBody(m.body)!);
        queue.delete(m.messageId);
      }
    };
    // try 1: AWS makes the instance, the answer is lost
    expect(await runStep(deps, message(id, resourceId))).toMatchObject({
      outcome: "advanced",
      to: "waiting",
      sent: false,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "waiting",
      attempts: 1,
      step: null,
      last_error: "upstream_unavailable:ServiceException",
    });
    expect((await operationRow(t.pool, id)).next_run_at).toEqual(new Date(NOW.getTime() + 60_000));
    // try 2: the sweeper releases it after 60 seconds; the step finds the instance by its name; the answer is lost again
    clock.advance(60);
    await sweep();
    await pump();
    expect(await operationRow(t.pool, id)).toMatchObject({ state: "waiting", attempts: 2 });
    expect((await operationRow(t.pool, id)).next_run_at).toEqual(
      new Date(NOW.getTime() + 60_000 + 120_000),
    );
    // try 3 succeeds
    clock.advance(120);
    await sweep();
    await pump();
    expect(cloud.createCalls).toBe(3);
    expect(cloud.instances.size).toBe(1);
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "queued",
      step: "wait_running",
      attempts: 0,
      last_error: null,
      enqueue_seq: 3,
    });
    expect((await resourceRow(resourceId)).aws_name).toBe(awsResourceName("instance", resourceId));
    expect(queue.messages.map((m) => m.MessageDeduplicationId)).toEqual([`${id}:3`]);
  });

  it("the delays are 60, 120, 240 and 480 seconds, and the 5th failure needs attention", async () => {
    const { deps, clock, queue } = setup({ adapters: registry(throwing(retryableError())) });
    const { id, resourceId } = await create();
    const delays: number[] = [];
    for (let n = 1; n <= 5; n++) {
      await runStep(deps, message(id, resourceId, n - 1));
      const row = await operationRow(t.pool, id);
      if (row.state !== "waiting") break;
      const delay = ((row.next_run_at as Date).getTime() - clock.now().getTime()) / 1000;
      delays.push(delay);
      clock.advance(delay);
      await sweepOperations({ runTx: deps.runTx, clock, queue });
    }
    expect(delays).toEqual([60, 120, 240, 480]);
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "needs_attention",
      attempts: 5,
      last_error: "upstream_unavailable:ServiceException",
    });
  });

  it("an admin retry gives exactly one more try, and a success resets the counter", async () => {
    const switchable = fakeInstanceAdapter(createFakeCloud());
    const real = switchable.aws.create;
    let failing = true;
    switchable.aws.create = async (ctx) => {
      if (failing) throw retryableError();
      return real(ctx);
    };
    const { deps, clock } = setup({ adapters: registry(switchable) });
    const { id, resourceId } = await create({
      state: "needs_attention",
      attempts: 5,
      last_error: "upstream_unavailable:ServiceException",
    });
    const retry = () =>
      runTransaction(t.db, (tx) => retryOperation(tx, { operationId: id, at: clock.now() }), {
        role: "admin_rw",
      });
    expect(await retry()).toMatchObject({ ok: true, replayed: false });
    expect(await runStep(deps, message(id, resourceId))).toMatchObject({
      outcome: "advanced",
      to: "needs_attention",
    });
    expect(await operationRow(t.pool, id)).toMatchObject({ state: "needs_attention", attempts: 6 });
    failing = false;
    await retry();
    expect(await runStep(deps, message(id, resourceId))).toMatchObject({ to: "queued" });
    expect(await operationRow(t.pool, id)).toMatchObject({ attempts: 0, last_error: null });
  });

  it("a full pool needs attention at once and the failed hook is not called", async () => {
    const full = new AwsError({
      code: "capacity_full",
      retryable: true,
      poolFull: true,
      awsErrorName: "ServiceQuotaExceededException",
      operation: "CreateInstances",
    });
    const failed: unknown[] = [];
    const { deps } = setup({
      adapters: registry(throwing(full)),
      hooks: {
        failed: async (_tx, e) => {
          failed.push(e);
        },
      },
    });
    const { id, resourceId } = await create();
    expect(await runStep(deps, message(id, resourceId))).toEqual({
      outcome: "advanced",
      to: "needs_attention",
      sent: false,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "needs_attention",
      attempts: 1,
      last_error: "capacity_full:ServiceQuotaExceededException",
    });
    expect(failed).toEqual([]);
  });

  it("an error that can never succeed fails a create, runs the failed hook, and only stops every other kind", async () => {
    const bad = new AwsError({
      code: "validation",
      retryable: false,
      awsErrorName: "InvalidInputException",
      operation: "CreateInstances",
    });
    const events: unknown[] = [];
    const { deps } = setup({
      adapters: registry(throwing(bad)),
      hooks: {
        failed: async (_tx, e) => {
          events.push(e);
        },
      },
    });
    const c = await create();
    expect(await runStep(deps, message(c.id, c.resourceId))).toEqual({
      outcome: "advanced",
      to: "failed",
      sent: false,
    });
    expect(await operationRow(t.pool, c.id)).toMatchObject({
      state: "failed",
      attempts: 1,
      last_error: "validation:InvalidInputException",
    });
    expect(events).toEqual([
      {
        operationId: c.id,
        resourceId: c.resourceId,
        customerId: world.customerId,
        kind: "create",
        code: "validation:InvalidInputException",
      },
    ]);
    const r = await create({ kind: "reboot" });
    expect(await runStep(deps, message(r.id, r.resourceId))).toMatchObject({
      to: "needs_attention",
    });
    expect(events).toHaveLength(1);
  });

  it("a failed hook that throws rolls the whole record back and leaves the operation running", async () => {
    const bad = new AwsError({
      code: "validation",
      retryable: false,
      operation: "CreateInstances",
    });
    const { deps } = setup({
      adapters: registry(throwing(bad)),
      hooks: {
        failed: async () => {
          throw new Error("hook failed");
        },
      },
    });
    const { id, resourceId } = await create();
    await expect(runStep(deps, message(id, resourceId))).rejects.toThrow("hook failed");
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "running",
      attempts: 0,
      last_error: null,
    });
  });

  it("[Review Focus 7] a create with a non-retryable error and no failed hook needs attention, never failed", async () => {
    const bad = new AwsError({
      code: "validation",
      retryable: false,
      awsErrorName: "InvalidInputException",
      operation: "CreateInstances",
    });
    const seen: unknown[] = [];
    const { deps } = setup({
      adapters: registry(throwing(bad)),
      hooks: {
        needsAttention: async (_tx, e) => {
          seen.push(e);
        },
      },
    });
    expect(deps.hooks?.failed).toBeUndefined();
    const { id, resourceId } = await create();
    expect(await runStep(deps, message(id, resourceId))).toEqual({
      outcome: "advanced",
      to: "needs_attention",
      sent: false,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "needs_attention",
      attempts: 1,
      last_error: "failed_hook_missing",
    });
    expect(seen).toEqual([
      { operationId: id, resourceId, kind: "create", code: "failed_hook_missing" },
    ]);
  });

  it("[Review Focus 7] the same with no hooks object at all: the row says failed_hook_missing and the log line carries the code", async () => {
    const bad = new AwsError({
      code: "validation",
      retryable: false,
      awsErrorName: "InvalidInputException",
      operation: "CreateInstances",
    });
    const none = setup({ adapters: registry(throwing(bad)) });
    expect(none.deps.hooks).toBeUndefined();
    const { id, resourceId } = await create();
    expect(await runStep(none.deps, message(id, resourceId))).toEqual({
      outcome: "advanced",
      to: "needs_attention",
      sent: false,
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "needs_attention",
      attempts: 1,
      last_error: "failed_hook_missing",
    });
    expect(none.logged[0]).toMatchObject({
      outcome: "advanced",
      to: "needs_attention",
      code: "failed_hook_missing",
      attempts: 1,
    });
  });

  it("an adapter cannot give a resource a name made from another resource's id (R11)", async () => {
    const other = await seedResource(t.pool, world);
    const wrong = fakeInstanceAdapter(createFakeCloud());
    wrong.aws.create = async () =>
      stepNext("wait_running", { awsName: awsResourceName("instance", other) });
    const { deps } = setup({ adapters: registry(wrong) });
    const { id, resourceId } = await create();
    expect(await runStep(deps, message(id, resourceId))).toMatchObject({
      outcome: "advanced",
      to: "needs_attention",
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "needs_attention",
      last_error: "invalid_step_result",
    });
    expect((await resourceRow(resourceId)).aws_name).toBeNull();
    expect((await resourceRow(other)).aws_name).toBeNull();
  });

  it("the attention hook runs in the record transaction for every move to needs_attention or failed, whatever the kind, and not for a wait", async () => {
    const events: unknown[] = [];
    const hooks = {
      failed: async () => {},
      needsAttention: async (_tx: unknown, e: unknown) => {
        events.push(e);
      },
    };
    const bad = new AwsError({
      code: "validation",
      retryable: false,
      operation: "CreateInstances",
    });
    const full = new AwsError({
      code: "capacity_full",
      retryable: true,
      poolFull: true,
      operation: "CreateInstances",
    });
    const a = setup({ adapters: registry(throwing(bad)), hooks: hooks as never });
    const failedCreate = await create();
    await runStep(a.deps, message(failedCreate.id, failedCreate.resourceId));
    const b = setup({ adapters: registry(throwing(full)), hooks: hooks as never });
    const reboot = await create({ kind: "reboot" });
    await runStep(b.deps, message(reboot.id, reboot.resourceId));
    const c = setup({ adapters: registry(throwing(retryableError())), hooks: hooks as never });
    const waiting = await create();
    await runStep(c.deps, message(waiting.id, waiting.resourceId));
    expect(events).toEqual([
      {
        operationId: failedCreate.id,
        resourceId: failedCreate.resourceId,
        kind: "create",
        code: "validation",
      },
      {
        operationId: reboot.id,
        resourceId: reboot.resourceId,
        kind: "reboot",
        code: "capacity_full",
      },
    ]);
  });

  it("whatever the adapter throws that is not an AwsError is a retryable internal error", async () => {
    for (const thrown of ["boom", null, undefined, new TypeError("x")]) {
      const { deps } = setup({ adapters: registry(throwing(thrown)) });
      const { id, resourceId } = await create();
      expect(await runStep(deps, message(id, resourceId))).toMatchObject({
        outcome: "advanced",
        to: "waiting",
      });
      expect(await operationRow(t.pool, id)).toMatchObject({
        state: "waiting",
        attempts: 1,
        last_error: "internal",
      });
    }
  });

  it("a result that is not a step result, an invalid config and an unplaced region need attention with their code", async () => {
    const garbage = fakeInstanceAdapter(createFakeCloud());
    garbage.aws.create = async () => ({ kind: "later" }) as never;
    const nothing = fakeInstanceAdapter(createFakeCloud());
    nothing.aws.create = async () => undefined as never;
    const badConfig = fakeInstanceAdapter(createFakeCloud());
    badConfig.parseConfig = () => {
      throw new Error("zod says no");
    };
    const cases: [string, ReturnType<typeof fakeInstanceAdapter>][] = [
      ["invalid_step_result", garbage],
      ["invalid_step_result", nothing],
      ["invalid_config", badConfig],
    ];
    for (const [code, adapter] of cases) {
      const { deps } = setup({ adapters: registry(adapter) });
      const { id, resourceId } = await create();
      expect(await runStep(deps, message(id, resourceId))).toMatchObject({
        to: "needs_attention",
      });
      expect(await operationRow(t.pool, id)).toMatchObject({
        state: "needs_attention",
        attempts: 0,
        last_error: code,
      });
    }
    const { deps } = setup();
    // the create carries the order of its customer (seedCreate), so the claim lets it run and the region check is the one that refuses it
    const resourceId = await seedResource(t.pool, world, { region: "eu-west-9" });
    const id = await seedCreate(t.pool, world, resourceId);
    expect(await runStep(deps, message(id, resourceId))).toMatchObject({
      outcome: "advanced",
      to: "needs_attention",
    });
    expect(await operationRow(t.pool, id)).toMatchObject({
      state: "needs_attention",
      attempts: 0,
      last_error: "resource_unplaced",
    });
  });

  it("[Review Focus 4] a record under a stale fence changes nothing: no patch, no hook, no message", async () => {
    const succeeded: unknown[] = [];
    const slow = fakeInstanceAdapter(createFakeCloud());
    const { id, resourceId } = await create();
    slow.aws.create = async () => {
      // while the adapter runs, the sweeper takes the run over
      await t.pool.query("update operations set state = 'waiting', attempts = 1 where id = $1", [
        id,
      ]);
      return stepNext("wait_running", { awsName: awsResourceName("instance", resourceId) });
    };
    const { deps, queue, logged } = setup({
      adapters: registry(slow),
      hooks: {
        succeeded: async (_tx, e) => {
          succeeded.push(e);
        },
      },
    });
    expect(await runStep(deps, message(id, resourceId))).toEqual({ outcome: "stale" });
    expect(await operationRow(t.pool, id)).toMatchObject({ state: "waiting", attempts: 1 });
    expect((await resourceRow(resourceId)).aws_name).toBeNull();
    expect(queue.depth).toBe(0);
    expect(succeeded).toEqual([]);
    expect(logged).toEqual([{ event: "operation_step", operationId: id, outcome: "stale" }]);
  });

  it("neither the log nor last_error holds the text of an error or the payload", async () => {
    const leaky = new Error("SECRET someone@example.test");
    const { deps, logged } = setup({ adapters: registry(throwing(leaky)) });
    const { id, resourceId } = await create();
    await runStep(deps, message(id, resourceId));
    const everything = JSON.stringify([logged, (await operationRow(t.pool, id)).last_error]);
    expect(everything).not.toContain("SECRET");
    expect(everything).not.toContain("someone@example.test");
    expect(logged[0]).toMatchObject({
      outcome: "advanced",
      to: "waiting",
      code: "internal",
      attempts: 1,
    });
  });
});
