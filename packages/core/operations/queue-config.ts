// Data for the infrastructure (WP0-T4) to read. No AWS code.

// 6 x the function timeout (60 s) is the AWS guidance for the visibility timeout of an SQS event
// source of Lambda, and a maxReceiveCount of at least 5 is too. The dead-letter queue of a FIFO
// queue is a FIFO queue and keeps its messages longer than its source.
export const PROVISIONING_QUEUE = Object.freeze({
  name: "provisioning",
  fifo: true,
  functionTimeoutSeconds: 60,
  visibilityTimeoutSeconds: 360,
  maxReceiveCount: 5,
  retentionSeconds: 345_600,
  deadLetterRetentionSeconds: 1_209_600,
  batchSize: 1,
  reportBatchItemFailures: true,
});

// 3.3: an alarm fires when the dead-letter queue is not empty. SQS publishes no metric for an
// inactive queue, so a missing point must not alarm.
export const DEAD_LETTER_ALARM = Object.freeze({
  namespace: "AWS/SQS",
  metric: "ApproximateNumberOfMessagesVisible",
  statistic: "Maximum",
  periodSeconds: 300,
  evaluationPeriods: 1,
  threshold: 0,
  comparison: "GreaterThanThreshold",
  treatMissingData: "notBreaching",
});

// Every wait, retry and lost-send recovery needs the scheduler each minute (3.2). The dead-letter
// alarm cannot see a stopped schedule, so this one fires when it ran less than once in 5 minutes.
export const SCHEDULER_ALARM = Object.freeze({
  namespace: "AWS/Lambda",
  metric: "Invocations",
  statistic: "Sum",
  periodSeconds: 300,
  evaluationPeriods: 1,
  threshold: 1,
  comparison: "LessThanThreshold",
  treatMissingData: "breaching",
});
