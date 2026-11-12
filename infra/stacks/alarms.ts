// WP0-T4: alarms to SNS (3.3: "Alarms go to an SNS topic that emails the on-call list").
// - The dead-letter queue alarm uses DEAD_LETTER_ALARM of @tc/core (queue-config.ts): the queue has
//   a message when ApproximateNumberOfMessagesVisible is above 0; a missing point does not alarm.
// - The scheduler alarm uses SCHEDULER_ALARM: fewer than one invocation in 5 minutes alarms, and a
//   missing point alarms too (a stopped schedule publishes nothing).
//
// NOT TYPE-CHECKED, see network.ts.
import { DEAD_LETTER_ALARM, SCHEDULER_ALARM } from "../../packages/core/operations/queue-config";
import {
  LEDGER_LOG_MESSAGES,
  LEDGER_METRIC_NAMESPACE,
  LEDGER_SILENCE_HOURS,
} from "../lib/functions";
import { resourceName, type StageConfig } from "../lib/stage";
import type { Messaging } from "./messaging";
import type { Workers } from "./workers";

export function alarms(config: StageConfig, queues: Messaging, workers: Workers) {
  const stage = config.stage;

  const topic = new aws.sns.Topic("AlarmTopic", { name: resourceName(stage, "alarms") });
  // VERIFY: an e-mail subscription stays "pending confirmation" until each address clicks the link;
  // it cannot be confirmed by the deploy.
  config.alarmEmails.forEach(
    (address, index) =>
      new aws.sns.TopicSubscription(`AlarmEmail${index}`, {
        topic: topic.arn,
        protocol: "email",
        endpoint: address,
      }),
  );

  // VERIFY: the dimension name for SQS is QueueName; the DLQ is FIFO so its name ends in .fifo.
  const deadLetterAlarm = new aws.cloudwatch.MetricAlarm("DeadLetterAlarm", {
    name: resourceName(stage, "provisioning-dlq-not-empty"),
    namespace: DEAD_LETTER_ALARM.namespace,
    metricName: DEAD_LETTER_ALARM.metric,
    statistic: DEAD_LETTER_ALARM.statistic,
    period: DEAD_LETTER_ALARM.periodSeconds,
    evaluationPeriods: DEAD_LETTER_ALARM.evaluationPeriods,
    threshold: DEAD_LETTER_ALARM.threshold,
    comparisonOperator: DEAD_LETTER_ALARM.comparison,
    treatMissingData: DEAD_LETTER_ALARM.treatMissingData,
    dimensions: { QueueName: queues.deadLetter.nodes.queue.name },
    alarmActions: [topic.arn],
    alarmDescription: "A provisioning message reached the dead-letter queue",
  });

  const schedulerFunction = workers.crons["scheduler"]?.nodes.function;
  const schedulerAlarm = new aws.cloudwatch.MetricAlarm("SchedulerAlarm", {
    name: resourceName(stage, "scheduler-stopped"),
    namespace: SCHEDULER_ALARM.namespace,
    metricName: SCHEDULER_ALARM.metric,
    statistic: SCHEDULER_ALARM.statistic,
    period: SCHEDULER_ALARM.periodSeconds,
    evaluationPeriods: SCHEDULER_ALARM.evaluationPeriods,
    threshold: SCHEDULER_ALARM.threshold,
    comparisonOperator: SCHEDULER_ALARM.comparison,
    treatMissingData: SCHEDULER_ALARM.treatMissingData,
    dimensions: { FunctionName: schedulerFunction?.name },
    alarmActions: [topic.arn],
    alarmDescription: "The scheduler ran less than once in 5 minutes",
  });

  // C.13: ledger alarms from the structured log lines of functions/reconciler/ledger-check.ts. Both
  // functions that run the check (the daily ledger-check and the hourly reconciler) are filtered.
  // ledger_mismatch and ledger_check_failed are errors (R16: a check that could not finish is not a pass);
  // the silence of ledger_check_ok for 26 hours is an alarm too.
  // VERIFY: the JSON filter pattern syntax of CloudWatch Logs metric filters and that an sst.aws.Function
  // logs to /aws/lambda/<function name>.
  const ledgerFunctions = [
    workers.crons["ledger-check"]?.nodes.function,
    workers.crons["reconciler"]?.nodes.function,
  ];
  const ledgerFilter = (
    id: string,
    fn: { name: unknown } | undefined,
    pattern: string,
    metric: string,
  ) =>
    new aws.cloudwatch.LogMetricFilter(id, {
      name: resourceName(stage, id.toLowerCase()),
      logGroupName: $interpolate`/aws/lambda/${fn?.name}`,
      pattern,
      metricTransformation: {
        name: metric,
        namespace: LEDGER_METRIC_NAMESPACE,
        value: "1",
        defaultValue: "0",
      },
    });
  ledgerFunctions.forEach((fn, index) => {
    ledgerFilter(
      `LedgerBad${index}`,
      fn,
      `{ $.msg = "${LEDGER_LOG_MESSAGES.mismatch}" || $.msg = "${LEDGER_LOG_MESSAGES.failed}" }`,
      "LedgerBad",
    );
    ledgerFilter(`LedgerOk${index}`, fn, `{ $.msg = "${LEDGER_LOG_MESSAGES.ok}" }`, "LedgerOk");
  });

  const ledgerMismatchAlarm = new aws.cloudwatch.MetricAlarm("LedgerMismatchAlarm", {
    name: resourceName(stage, "ledger-mismatch"),
    namespace: LEDGER_METRIC_NAMESPACE,
    metricName: "LedgerBad",
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    treatMissingData: "notBreaching",
    alarmActions: [topic.arn],
    alarmDescription:
      "The ledger check found a mismatch or could not finish (ledger_mismatch, ledger_check_failed)",
  });

  const ledgerSilentAlarm = new aws.cloudwatch.MetricAlarm("LedgerSilentAlarm", {
    name: resourceName(stage, "ledger-check-silent"),
    namespace: LEDGER_METRIC_NAMESPACE,
    metricName: "LedgerOk",
    statistic: "Sum",
    period: 3600,
    evaluationPeriods: LEDGER_SILENCE_HOURS,
    datapointsToAlarm: LEDGER_SILENCE_HOURS,
    threshold: 1,
    comparisonOperator: "LessThanThreshold",
    treatMissingData: "breaching",
    alarmActions: [topic.arn],
    alarmDescription: "No ledger_check_ok line for 26 hours: the ledger check did not run",
  });

  return { topic, deadLetterAlarm, schedulerAlarm, ledgerMismatchAlarm, ledgerSilentAlarm };
}

export type Alarms = ReturnType<typeof alarms>;
