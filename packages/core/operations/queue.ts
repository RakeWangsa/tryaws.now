import type { Clock } from "../types";
import { PROVISIONING_QUEUE } from "./queue-config";

export interface QueueMessage {
  readonly operationId: string;
  readonly resourceId: string;
  readonly enqueueSeq: number;
}

export interface OperationQueue {
  send(message: QueueMessage): Promise<void>;
}

// The field names of the SQS SendMessage input.
export interface FifoSendInput {
  readonly MessageBody: string;
  readonly MessageGroupId: string;
  readonly MessageDeduplicationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SEQ = 2_147_483_647;
const MAX_BODY_LENGTH = 1000;
const DEDUP_WINDOW_MS = 300_000;

const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SEQ;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

// The message group is the resource, the deduplication id is <operation id>:<enqueue_seq> (3.3).
export function toFifoInput(message: QueueMessage): FifoSendInput {
  if (!isUuid(message.operationId) || !isUuid(message.resourceId) || !isSeq(message.enqueueSeq)) {
    throw new RangeError("invalid queue message");
  }
  return {
    MessageBody: JSON.stringify({
      operationId: message.operationId,
      resourceId: message.resourceId,
      enqueueSeq: message.enqueueSeq,
    }),
    MessageGroupId: message.resourceId,
    MessageDeduplicationId: `${message.operationId}:${message.enqueueSeq}`,
  };
}

export function parseMessageBody(body: string): QueueMessage | null {
  if (body.length > MAX_BODY_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { operationId, resourceId, enqueueSeq } = parsed as Record<string, unknown>;
  if (!isUuid(operationId) || !isUuid(resourceId) || !isSeq(enqueueSeq)) return null;
  return { operationId, resourceId, enqueueSeq };
}

// The real SQS call is injected (WP4-T2 Task 15).
export function createFifoQueue(send: (input: FifoSendInput) => Promise<void>): OperationQueue {
  return { send: (message) => send(toFifoInput(message)) };
}

// Never throws: a lost send is recovered by the scheduler (3.4).
export async function sendAfterCommit(
  queue: OperationQueue,
  message: QueueMessage,
): Promise<boolean> {
  try {
    await queue.send(message);
    return true;
  } catch {
    return false;
  }
}

// The counter a new row has: what the creator of an operation sends after its commit.
export function firstMessage(operationId: string, resourceId: string): QueueMessage {
  return { operationId, resourceId, enqueueSeq: 0 };
}

export interface ReceivedMessage {
  readonly messageId: string;
  readonly body: string;
  readonly groupId: string;
  readonly receiveCount: number;
}

export interface MemoryQueue extends OperationQueue {
  receive(): ReceivedMessage[];
  delete(messageId: string): void;
  release(messageId: string): void;
  failNextSends(count: number): void;
  sendRaw(input: FifoSendInput): void;
  readonly messages: readonly FifoSendInput[];
  readonly deadLetters: readonly FifoSendInput[];
  readonly depth: number;
}

interface Stored {
  readonly messageId: string;
  readonly input: FifoSendInput;
  receiveCount: number;
  inFlight: boolean;
}

// A fake for tests, not a model of all of SQS.
export function createMemoryQueue(options: {
  clock: Clock;
  maxReceiveCount?: number;
}): MemoryQueue {
  const maxReceiveCount = options.maxReceiveCount ?? PROVISIONING_QUEUE.maxReceiveCount;
  let stored: Stored[] = [];
  const dead: FifoSendInput[] = [];
  // deduplication id -> time of its first acceptance; a dropped duplicate does not renew it
  const accepted = new Map<string, number>();
  let counter = 0;
  let failures = 0;

  const store = (input: FifoSendInput): void => {
    const at = options.clock.now().getTime();
    const first = accepted.get(input.MessageDeduplicationId);
    if (first !== undefined && at - first < DEDUP_WINDOW_MS) return;
    accepted.set(input.MessageDeduplicationId, at);
    counter += 1;
    stored.push({ messageId: `m${counter}`, input, receiveCount: 0, inFlight: false });
  };

  return {
    async send(message) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("queue unavailable");
      }
      store(toFifoInput(message));
    },
    sendRaw: store,
    failNextSends(count) {
      failures = count;
    },
    receive() {
      const blocked = new Set(stored.filter((m) => m.inFlight).map((m) => m.input.MessageGroupId));
      const out: ReceivedMessage[] = [];
      for (const m of stored) {
        const group = m.input.MessageGroupId;
        if (blocked.has(group)) continue;
        blocked.add(group);
        m.inFlight = true;
        m.receiveCount += 1;
        out.push({
          messageId: m.messageId,
          body: m.input.MessageBody,
          groupId: group,
          receiveCount: m.receiveCount,
        });
      }
      return out;
    },
    delete(messageId) {
      stored = stored.filter((m) => m.messageId !== messageId);
    },
    release(messageId) {
      const m = stored.find((s) => s.messageId === messageId);
      if (m === undefined) return;
      if (m.receiveCount >= maxReceiveCount) {
        dead.push(m.input);
        stored = stored.filter((s) => s !== m);
        return;
      }
      m.inFlight = false;
    },
    get messages() {
      return stored.map((m) => m.input);
    },
    get deadLetters() {
      return [...dead];
    },
    get depth() {
      return stored.length;
    },
  };
}
