import { describe, expect, it } from "vitest";
import { makeSqsOperationQueue, queuePortFromEnv, type SqsSender } from "./queue-port.ts";

const URL = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning.fifo";
const A = "01a1c97d-e814-7352-b32c-d3d3ee408ab8";
const R = "01a1c97d-e813-7307-8faf-9c991091b3bd";

describe("makeSqsOperationQueue", () => {
  it("sends the four fields of the FIFO contract: group is the resource, dedup is <operation>:<seq>", async () => {
    const seen: unknown[] = [];
    const sender: SqsSender = {
      async send(input) {
        seen.push(input);
      },
    };
    const queue = makeSqsOperationQueue(sender, URL);
    await queue.send({ operationId: A, resourceId: R, enqueueSeq: 0 });
    expect(seen).toEqual([
      {
        QueueUrl: URL,
        MessageBody: JSON.stringify({ operationId: A, resourceId: R, enqueueSeq: 0 }),
        MessageGroupId: R,
        MessageDeduplicationId: `${A}:0`,
      },
    ]);
  });

  it("refuses a queue URL that is not the https URL of a FIFO queue", () => {
    for (const bad of [
      "",
      "http://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning.fifo",
      "https://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning",
      "https://evil.example.com/123456789012/provisioning.fifo",
    ])
      expect(() => makeSqsOperationQueue({ send: async () => {} }, bad), bad).toThrow(RangeError);
  });

  it("rejects a malformed message before any send (the caller then leaves it to the sweep)", async () => {
    let calls = 0;
    const queue = makeSqsOperationQueue(
      {
        send: async () => {
          calls += 1;
        },
      },
      URL,
    );
    await expect(queue.send({ operationId: "x", resourceId: R, enqueueSeq: 0 })).rejects.toThrow(
      RangeError,
    );
    expect(calls).toBe(0);
  });

  it("does not leak the text of an SDK error", async () => {
    const queue = makeSqsOperationQueue(
      {
        send: async () => {
          throw new Error("secret arn:aws:sqs:x someone@example.test");
        },
      },
      URL,
    );
    const error = await queue
      .send({ operationId: A, resourceId: R, enqueueSeq: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/secret|arn:|example/);
  });
});

describe("queuePortFromEnv", () => {
  it("is null without a queue URL (the sweep carries the operation)", () => {
    expect(queuePortFromEnv({}, () => ({ send: async () => {} }))).toBeNull();
  });

  it("is null for a malformed queue URL (fail closed, no throw at startup)", () => {
    expect(
      queuePortFromEnv({ PROVISIONING_QUEUE_URL: "https://evil.example.com/x" }, () => ({
        send: async () => {},
      })),
    ).toBeNull();
  });

  it("builds the client lazily: not on construction, once on the first send", async () => {
    let built = 0;
    const queue = queuePortFromEnv(
      { PROVISIONING_QUEUE_URL: URL, AWS_REGION: "ap-southeast-1" },
      (region) => {
        built += 1;
        expect(region).toBe("ap-southeast-1");
        return { send: async () => {} };
      },
    );
    expect(queue).not.toBeNull();
    expect(built).toBe(0);
    await queue?.send({ operationId: A, resourceId: R, enqueueSeq: 0 });
    await queue?.send({ operationId: A, resourceId: R, enqueueSeq: 1 });
    expect(built).toBe(1);
  });

  it("takes the Region from the queue URL when AWS_REGION is absent", async () => {
    let region = "";
    const queue = queuePortFromEnv({ PROVISIONING_QUEUE_URL: URL }, (r) => {
      region = r;
      return { send: async () => {} };
    });
    await queue?.send({ operationId: A, resourceId: R, enqueueSeq: 0 });
    expect(region).toBe("ap-southeast-1");
  });
});
