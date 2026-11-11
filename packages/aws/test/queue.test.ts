import { toFifoInput } from "@tc/core";
import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { AwsError } from "../errors";
import { QUEUE_URL_PATTERN, createSqsClient, createSqsSend } from "../queue";

const QUEUE_URL = "https://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning.fifo";
const A = "01a1c97d-e814-7352-b32c-d3d3ee408ab8";
const R = "01a1c97d-e813-7307-8faf-9c991091b3bd";

describe("createSqsSend", () => {
  it("accepts the URL of a FIFO queue and refuses everything else", () => {
    expect(QUEUE_URL_PATTERN.test(QUEUE_URL)).toBe(true);
    for (const bad of [
      "http://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning.fifo",
      "https://sqs.ap-southeast-1.amazonaws.com/123456789012/provisioning",
      "https://evil.example.com/123456789012/provisioning.fifo",
      QUEUE_URL + "\n",
      "",
      "provisioning.fifo",
    ])
      expect(() => createSqsSend({ send: async () => ({}) }, bad), bad).toThrow(RangeError);
  });

  it("sends exactly the four fields of a FIFO message", async () => {
    const sent: SendMessageCommand[] = [];
    const send = createSqsSend(
      {
        send: async (c) => {
          sent.push(c);
          return {};
        },
      },
      QUEUE_URL,
    );
    const input = toFifoInput({ operationId: A, resourceId: R, enqueueSeq: 3 });
    await send(input);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({
      QueueUrl: QUEUE_URL,
      MessageBody: input.MessageBody,
      MessageGroupId: R,
      MessageDeduplicationId: `${A}:3`,
    });
  });

  it("turns an error of the client into an AwsError without its text", async () => {
    const failing = {
      send: async () => {
        throw Object.assign(new Error("SECRET someone@example.test"), {
          name: "ThrottlingException",
          $metadata: { httpStatusCode: 400 },
        });
      },
    };
    const send = createSqsSend(failing, QUEUE_URL);
    const error = await send(toFifoInput({ operationId: A, resourceId: R, enqueueSeq: 0 })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AwsError);
    expect(error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      operation: "SendMessage",
    });
    expect(JSON.stringify([String(error), (error as Error).message])).not.toMatch(
      /SECRET|someone@example/,
    );
  });
});

it("createSqsClient builds a client for the Region without a call", async () => {
  expect(await createSqsClient("ap-southeast-1").config.region()).toBe("ap-southeast-1");
});
