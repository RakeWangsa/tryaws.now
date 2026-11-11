import { toFifoInput, type LogEvent, type QueueMessage } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createHandler, type SqsRecord } from "./index";
import type { StepDeps } from "./types";

const A = "01a1c97d-e814-7352-b32c-d3d3ee408ab8";
const B = "01a1c97d-e815-7a11-8b2e-3a1c5f0d9e44";
const R = "01a1c97d-e813-7307-8faf-9c991091b3bd";
const record = (messageId: string, operationId: string, seq = 0): SqsRecord => ({
  messageId,
  body: toFifoInput({ operationId, resourceId: R, enqueueSeq: seq }).MessageBody,
});
function build(run: (message: QueueMessage) => Promise<unknown>) {
  const logged: LogEvent[] = [];
  const calls: string[] = [];
  const deps = { log: (e: LogEvent) => logged.push(e) } as unknown as StepDeps;
  const handler = createHandler(deps, (async (_deps: StepDeps, message: QueueMessage) => {
    calls.push(message.operationId);
    return run(message);
  }) as never);
  return { handler, logged, calls };
}

describe("the batch handler", () => {
  it("runs the records in order and reports no failure, whatever the outcome of a run", async () => {
    const outcomes = [{ outcome: "advanced" }, { outcome: "skipped" }, { outcome: "stale" }];
    const { handler, calls } = build(async () => outcomes.shift());
    const out = await handler({ Records: [record("m1", A), record("m2", B), record("m3", A, 1)] });
    expect(out).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual([A, B, A]);
  });

  it("[Review Focus 5] a body that is not a message fails its record and everything after it, and nothing after it runs", async () => {
    const { handler, calls, logged } = build(async () => ({ outcome: "advanced" }));
    const out = await handler({
      Records: [
        record("m1", A),
        { messageId: "m2", body: "{not json, someone@example.test" },
        record("m3", B),
      ],
    });
    expect(out).toEqual({
      batchItemFailures: [{ itemIdentifier: "m2" }, { itemIdentifier: "m3" }],
    });
    expect(calls).toEqual([A]);
    expect(logged).toEqual([{ event: "batch_failure", messageId: "m2", reason: "malformed_body" }]);
  });

  it("a run that throws (the database is down) fails its record and the rest, and its text is not logged", async () => {
    const { handler, logged } = build(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 someone@example.test");
    });
    const out = await handler({ Records: [record("m1", A), record("m2", B)] });
    expect(out.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(["m1", "m2"]);
    expect(logged).toEqual([{ event: "batch_failure", messageId: "m1", reason: "run_error" }]);
  });

  it("[Review Focus 5] a batch of one record that fails throws a fixed error, for a malformed body and for a run that throws", async () => {
    const malformed = build(async () => ({ outcome: "advanced" }));
    await expect(
      malformed.handler({
        Records: [{ messageId: "m1", body: "{not json, someone@example.test" }],
      }),
    ).rejects.toThrow("provisioner: record failed");
    expect(malformed.logged).toEqual([
      { event: "batch_failure", messageId: "m1", reason: "malformed_body" },
    ]);
    const failing = build(async () => {
      throw new Error("connect ECONNREFUSED someone@example.test");
    });
    await expect(failing.handler({ Records: [record("m1", A)] })).rejects.toThrow(
      "provisioner: record failed",
    );
    expect(failing.logged).toEqual([
      { event: "batch_failure", messageId: "m1", reason: "run_error" },
    ]);
    const ok = build(async () => ({ outcome: "advanced" }));
    expect(await ok.handler({ Records: [record("m1", A)] })).toEqual({ batchItemFailures: [] });
  });

  it("a function that may run longer than the lease runs nothing and fails every record", async () => {
    const { handler, calls, logged } = build(async () => ({ outcome: "advanced" }));
    const longer = { getRemainingTimeInMillis: () => 300_000 };
    expect(await handler({ Records: [record("m1", A), record("m2", B)] }, longer)).toEqual({
      batchItemFailures: [{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }],
    });
    await expect(handler({ Records: [record("m1", A)] }, longer)).rejects.toThrow(
      "provisioner: record failed",
    );
    expect(calls).toEqual([]);
    expect(logged[0]).toEqual({ event: "lease_shorter_than_timeout" });
    const fine = { getRemainingTimeInMillis: () => 60_000 };
    expect(await handler({ Records: [record("m1", A)] }, fine)).toEqual({ batchItemFailures: [] });
  });

  it("an empty batch is a success and never throws", async () => {
    const { handler } = build(async () => ({ outcome: "advanced" }));
    expect(await handler({ Records: [] })).toEqual({ batchItemFailures: [] });
  });
});
