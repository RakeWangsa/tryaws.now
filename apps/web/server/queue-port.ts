import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { toFifoInput } from "@tc/core";
import type { OperationQueue } from "@tc/core";

// WPU-G2. The enqueue port of the web tier: after the commit of an operation row the Server Action
// sends the message of contract 3.3 (group = resource id, deduplication id = <operation id>:<seq>)
// so the provisioner starts in seconds instead of waiting for the scheduler sweep. R1 is kept: this
// file imports no packages/aws and holds no provisioning call; the only AWS action of the role of
// the web function is sqs:SendMessage on the one queue (infra/stacks/web.ts). R3: no keys, the
// default credential chain of the function role. A failed send is not an error for the customer:
// sendAfterCommit logs it and the sweep sends the row whose enqueue_seq is still 0 (3.4).

/** Same shape as the FIFO queue URL of packages/aws/queue.ts (kept here because web cannot import it). */
export const QUEUE_URL_PATTERN =
  /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/[0-9]{12}\/[A-Za-z0-9_-]{1,75}\.fifo$/;

export interface SqsSendInput {
  readonly QueueUrl: string;
  readonly MessageBody: string;
  readonly MessageGroupId: string;
  readonly MessageDeduplicationId: string;
}

/** The one call the port makes; a test passes a fake. */
export interface SqsSender {
  send(input: SqsSendInput): Promise<void>;
}

export function makeSqsOperationQueue(sender: SqsSender, queueUrl: string): OperationQueue {
  if (!QUEUE_URL_PATTERN.test(queueUrl)) {
    throw new RangeError("queue: the queue URL is not the URL of a FIFO queue");
  }
  return {
    async send(message) {
      // Validates the three fields (uuid, uuid, counter) before anything leaves the process.
      const fifo = toFifoInput(message);
      try {
        await sender.send({ QueueUrl: queueUrl, ...fifo });
      } catch {
        // A fixed text: the SDK message can carry an ARN or an address (R14).
        throw new Error("queue: the message was not accepted");
      }
    },
  };
}

function sdkSender(region: string): SqsSender {
  const client = new SQSClient({
    region,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 4000, throwOnRequestTimeout: true },
  });
  return {
    async send(input) {
      await client.send(new SendMessageCommand(input));
    },
  };
}

/**
 * The queue of this environment, or null when none is configured or the URL is malformed (the sweep
 * then carries every operation). The client is built on the first send, never at import.
 */
export function queuePortFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  build: (region: string) => SqsSender = sdkSender,
): OperationQueue | null {
  const url = env["PROVISIONING_QUEUE_URL"];
  if (typeof url !== "string") return null;
  const match = QUEUE_URL_PATTERN.exec(url);
  if (match === null) return null;
  const region = env["AWS_REGION"] || (match[1] as string);
  let sender: SqsSender | undefined;
  return makeSqsOperationQueue(
    {
      send: (input) => {
        sender ??= build(region);
        return sender.send(input);
      },
    },
    url,
  );
}
