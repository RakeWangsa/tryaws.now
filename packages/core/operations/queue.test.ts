import { expect, it } from "vitest";
import { createManualClock } from "./manual-clock";
import {
  createFifoQueue,
  createMemoryQueue,
  firstMessage,
  parseMessageBody,
  sendAfterCommit,
  toFifoInput,
  type QueueMessage,
} from "./queue";
import { DEAD_LETTER_ALARM, PROVISIONING_QUEUE, SCHEDULER_ALARM } from "./queue-config";

const A = "01a1c97d-e814-7352-b32c-d3d3ee408ab8";
const B = "01a1c97d-e815-7a11-8b2e-3a1c5f0d9e44";
const R = "01a1c97d-e813-7307-8faf-9c991091b3bd";
const S = "01a1c97d-e816-7b22-9c3f-4b2d6e1f0a55";
const msg = (operationId: string, resourceId: string, enqueueSeq: number): QueueMessage => ({
  operationId,
  resourceId,
  enqueueSeq,
});
const clock = () => createManualClock(new Date("2030-01-01T00:00:00Z"));

it("the group is the resource id and the deduplication id is <operation id>:<enqueue_seq>", () => {
  expect(toFifoInput(msg(A, R, 3))).toEqual({
    MessageBody: `{"operationId":"${A}","resourceId":"${R}","enqueueSeq":3}`,
    MessageGroupId: R,
    MessageDeduplicationId: `${A}:3`,
  });
  expect(firstMessage(A, R)).toEqual(msg(A, R, 0));
});

it("ids that are not lowercase UUIDs and counters that are not small integers are refused", () => {
  const bad = [
    msg("x", R, 0),
    msg(A, "x", 0),
    msg(A.toUpperCase(), R, 0),
    msg(A, R, -1),
    msg(A, R, 1.5),
    msg(A, R, 2 ** 31),
    msg(A, R, Number.NaN),
  ];
  for (const m of bad) expect(() => toFifoInput(m)).toThrow(RangeError);
});

it("[Review Focus 5] parseMessageBody round-trips a message and returns null for everything else", () => {
  expect(parseMessageBody(toFifoInput(msg(A, R, 7)).MessageBody)).toEqual(msg(A, R, 7));
  const bodies = [
    "",
    "x",
    "[]",
    "null",
    "{}",
    '{"operationId":1}',
    `{"operationId":"${A}","resourceId":"${R}"}`,
    `{"operationId":"${A}","resourceId":"${R}","enqueueSeq":-1}`,
    `{"operationId":"${A}","resourceId":"x","enqueueSeq":0}`,
    "a".repeat(2000),
  ];
  for (const body of bodies) expect(parseMessageBody(body), body.slice(0, 24)).toBeNull();
});

it("[Review Focus 3] sendAfterCommit says whether the queue took the message and never throws", async () => {
  const q = createMemoryQueue({ clock: clock() });
  expect(await sendAfterCommit(q, msg(A, R, 0))).toBe(true);
  q.failNextSends(1);
  expect(await sendAfterCommit(q, msg(A, R, 1))).toBe(false);
  expect(q.depth).toBe(1);
  expect(q.messages.map((m) => m.MessageDeduplicationId)).toEqual([`${A}:0`]);
  const sent: string[] = [];
  const queue = createFifoQueue(async (input) => {
    sent.push(input.MessageDeduplicationId);
  });
  await queue.send(msg(B, S, 4));
  expect(sent).toEqual([`${B}:4`]);
});

it("the memory queue delivers one message per group at a time, in order, and groups do not block each other", async () => {
  const q = createMemoryQueue({ clock: clock() });
  await q.send(msg(A, R, 0));
  await q.send(msg(A, R, 1));
  await q.send(msg(B, S, 0));
  const first = q.receive();
  expect(first.map((m) => m.groupId)).toEqual([R, S]);
  expect(first[0]?.body).toBe(toFifoInput(msg(A, R, 0)).MessageBody);
  expect(q.receive()).toEqual([]);
  q.delete(first[0]!.messageId);
  expect(q.receive().map((m) => m.body)).toEqual([toFifoInput(msg(A, R, 1)).MessageBody]);
});

it("a repeated deduplication id inside 5 minutes is accepted and not delivered; after 5 minutes it is", async () => {
  const c = clock();
  const q = createMemoryQueue({ clock: c });
  await q.send(msg(A, R, 0));
  await q.send(msg(A, R, 0));
  expect(q.depth).toBe(1);
  c.advance(299);
  await q.send(msg(A, R, 0));
  expect(q.depth).toBe(1);
  c.advance(2);
  await q.send(msg(A, R, 0));
  expect(q.depth).toBe(2);
  await q.send(msg(A, R, 1));
  expect(q.depth).toBe(3);
});

it("a message released 5 times moves to the dead-letter queue and unblocks its group", async () => {
  const q = createMemoryQueue({ clock: clock(), maxReceiveCount: 5 });
  await q.send(msg(A, R, 0));
  await q.send(msg(B, R, 0));
  for (let i = 1; i <= 5; i++) {
    const [m] = q.receive();
    expect(m?.body).toContain(A);
    expect(m?.receiveCount).toBe(i);
    q.release(m!.messageId);
  }
  expect(q.deadLetters.map((d) => d.MessageDeduplicationId)).toEqual([`${A}:0`]);
  expect(q.receive().map((m) => m.body)).toEqual([toFifoInput(msg(B, R, 0)).MessageBody]);
});

it("sendRaw stores a body that is not a message, with the same deduplication", () => {
  const q = createMemoryQueue({ clock: clock() });
  q.sendRaw({ MessageBody: "{not json", MessageGroupId: R, MessageDeduplicationId: "poison:0" });
  q.sendRaw({ MessageBody: "{not json", MessageGroupId: R, MessageDeduplicationId: "poison:0" });
  expect(q.depth).toBe(1);
  expect(q.receive().map((m) => m.body)).toEqual(["{not json"]);
});

it("the queue settings follow the AWS guidance, the alarm fires when the dead-letter queue is not empty, and a second alarm fires when the scheduler stops", () => {
  expect(PROVISIONING_QUEUE.visibilityTimeoutSeconds).toBeGreaterThanOrEqual(
    6 * PROVISIONING_QUEUE.functionTimeoutSeconds,
  );
  expect(PROVISIONING_QUEUE.maxReceiveCount).toBeGreaterThanOrEqual(5);
  expect(PROVISIONING_QUEUE.deadLetterRetentionSeconds).toBeGreaterThan(
    PROVISIONING_QUEUE.retentionSeconds,
  );
  expect(PROVISIONING_QUEUE).toMatchObject({
    name: "provisioning",
    fifo: true,
    batchSize: 1,
    reportBatchItemFailures: true,
  });
  expect(DEAD_LETTER_ALARM).toEqual({
    namespace: "AWS/SQS",
    metric: "ApproximateNumberOfMessagesVisible",
    statistic: "Maximum",
    periodSeconds: 300,
    evaluationPeriods: 1,
    threshold: 0,
    comparison: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  });
  expect(SCHEDULER_ALARM).toEqual({
    namespace: "AWS/Lambda",
    metric: "Invocations",
    statistic: "Sum",
    periodSeconds: 300,
    evaluationPeriods: 1,
    threshold: 1,
    comparison: "LessThanThreshold",
    treatMissingData: "breaching",
  });
  expect(
    Object.isFrozen(PROVISIONING_QUEUE) &&
      Object.isFrozen(DEAD_LETTER_ALARM) &&
      Object.isFrozen(SCHEDULER_ALARM),
  ).toBe(true);
});
