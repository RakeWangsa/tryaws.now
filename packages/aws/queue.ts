import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { FifoSendInput } from "@tc/core";
import { toAwsError } from "./errors";

/** The URL of a FIFO queue of Amazon SQS: https, an sqs host, a 12 digit account, a name that ends in .fifo. */
export const QUEUE_URL_PATTERN =
  /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/[0-9]{12}\/[A-Za-z0-9_-]{1,75}\.fifo$/;

/** The one method of the SDK client that the send uses; a test passes a fake. */
export interface SqsLike {
  send(command: SendMessageCommand): Promise<unknown>;
}

/** Binds a client and a queue URL to the send function that `createFifoQueue` of @tc/core takes. */
export function createSqsSend(
  client: SqsLike,
  queueUrl: string,
): (input: FifoSendInput) => Promise<void> {
  if (!QUEUE_URL_PATTERN.test(queueUrl)) {
    throw new RangeError("sqs: the queue URL is not the URL of a FIFO queue");
  }
  return async (input) => {
    try {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: input.MessageBody,
          MessageGroupId: input.MessageGroupId,
          MessageDeduplicationId: input.MessageDeduplicationId,
        }),
      );
    } catch (error) {
      throw toAwsError(error, "SendMessage");
    }
  };
}

/**
 * A client for the Region of the queue. The credentials come from the default chain (the role of the Lambda, R3).
 * The SDK repeats a failed call up to 3 times; that is safe because every repeat carries the same deduplication id.
 */
export function createSqsClient(region: string): SQSClient {
  return new SQSClient({
    region,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 15000, throwOnRequestTimeout: true },
  });
}
