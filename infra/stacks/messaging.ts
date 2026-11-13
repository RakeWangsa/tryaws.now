// WP0-T4: SQS FIFO queue `provisioning` with a FIFO dead-letter queue (3.3). The numbers come from
// @tc/core (packages/core/operations/queue-config.ts); the file is a pure data module, so a relative
// import is safe and keeps infra independent of the workspace package graph.
//
// NOT TYPE-CHECKED, see network.ts.
import { PROVISIONING_QUEUE } from "../../packages/core/operations/queue-config";

export function messaging() {
  const deadLetter = new sst.aws.Queue("ProvisioningDlq", {
    fifo: true,
    transform: {
      // Transform<sqs.QueueArgs>, as SST passes it (.sst/platform/src/components/aws/queue.ts).
      queue: (args: aws.sqs.QueueArgs) => {
        args.messageRetentionSeconds = PROVISIONING_QUEUE.deadLetterRetentionSeconds;
        // VERIFY: SSE-SQS (sqsManagedSseEnabled) is on by default for new queues; set explicitly.
        args.sqsManagedSseEnabled = true;
      },
    },
  });

  const provisioning = new sst.aws.Queue("Provisioning", {
    fifo: true,
    // 6 x the function timeout (PROVISIONING_QUEUE.visibilityTimeoutSeconds)
    visibilityTimeout: `${PROVISIONING_QUEUE.visibilityTimeoutSeconds} seconds`,
    // VERIFY: dlq.queue takes the ARN of the dead-letter queue and `retry` is the maxReceiveCount.
    dlq: { queue: deadLetter.arn, retry: PROVISIONING_QUEUE.maxReceiveCount },
    transform: {
      queue: (args: aws.sqs.QueueArgs) => {
        args.messageRetentionSeconds = PROVISIONING_QUEUE.retentionSeconds;
        args.sqsManagedSseEnabled = true;
        // The deduplication id is <operation id>:<enqueue_seq>, set by the sender (3.3), so
        // content-based deduplication stays off (the component default).
      },
    },
  });

  return { provisioning, deadLetter };
}

export type Messaging = ReturnType<typeof messaging>;
