// WP0-T4: alarms to SNS (3.3: "Alarms go to an SNS topic that emails the on-call list").
// - The dead-letter queue alarm uses DEAD_LETTER_ALARM of @tc/core (queue-config.ts): the queue has
//   a message when ApproximateNumberOfMessagesVisible is above 0; a missing point does not alarm.
// - The scheduler alarm uses SCHEDULER_ALARM: fewer than one invocation in 5 minutes alarms, and a
//   missing point alarms too (a stopped schedule publishes nothing).
//
// NOT TYPE-CHECKED, see network.ts.
import { DEAD_LETTER_ALARM, SCHEDULER_ALARM } from "../../packages/core/operations/queue-config";
import {
  ALERT_LOG_EVENTS,
  ALERT_LOG_REASONS,
  ALERT_METRIC_NAMESPACE,
  LEDGER_LOG_MESSAGES,
  LEDGER_METRIC_NAMESPACE,
  LEDGER_SILENCE_HOURS,
  RECONCILE_SILENCE_HOURS,
} from "../lib/functions";
import { resourceName, type StageConfig } from "../lib/stage";
import type { Messaging } from "./messaging";
import type { Workers } from "./workers";

export function alarms(
  config: StageConfig,
  queues: Messaging,
  workers: Workers,
  // The Next.js components, for the server-function error alarms (5xx). Optional so that a caller that
  // has no web tier (a test of this file) still builds the rest.
  web?: { customer: unknown; admin: unknown },
) {
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

  // WPU-B3 (audit items 14, 15, 36). Alerts from structured log lines, and a function-error alarm for every
  // function that runs on a schedule or from the queue and for the two Next.js servers.
  // VERIFY (first `sst diff`): the log group of an sst.aws.Function is /aws/lambda/<function name>; the
  // JSON filter syntax with `||`; `queues.provisioning.subscribe` returns an object with
  // nodes.function; the server function of sst.aws.Nextjs is at nodes.server.
  const alertFilter = (
    id: string,
    fn: { name: unknown } | undefined,
    events: readonly string[],
    metric: string,
  ) =>
    new aws.cloudwatch.LogMetricFilter(id, {
      name: resourceName(stage, id.toLowerCase()),
      logGroupName: $interpolate`/aws/lambda/${fn?.name}`,
      pattern: `{ ${events.map((e) => `$.event = "${e}"`).join(" || ")} }`,
      metricTransformation: {
        name: metric,
        namespace: ALERT_METRIC_NAMESPACE,
        value: "1",
        defaultValue: "0",
      },
    });
  const alertAlarm = (id: string, metric: string, description: string) =>
    new aws.cloudwatch.MetricAlarm(id, {
      name: resourceName(stage, id.toLowerCase()),
      namespace: ALERT_METRIC_NAMESPACE,
      metricName: metric,
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "notBreaching",
      alarmActions: [topic.arn],
      alarmDescription: description,
    });

  // Item 14: the capacity of a failed or destroyed resource was not given back.
  const provisionerFunction = workers.provisioner?.nodes.function;
  alertFilter(
    "CapacityReleaseProblemFilter",
    provisionerFunction,
    [ALERT_LOG_EVENTS.capacityReleaseProblem],
    "CapacityReleaseProblem",
  );
  const capacityReleaseAlarm = alertAlarm(
    "CapacityReleaseAlarm",
    "CapacityReleaseProblem",
    "A capacity release failed (row_missing or malformed_record): see the discrepancies list",
  );

  // Item 15: a credit note (Mushak 6.7) that is refused again and again.
  alertFilter(
    "CreditNoteStuckFilter",
    schedulerFunction,
    [ALERT_LOG_EVENTS.creditNoteStuck],
    "CreditNoteStuck",
  );
  const creditNoteStuckAlarm = alertAlarm(
    "CreditNoteStuckAlarm",
    "CreditNoteStuck",
    "A credit note has been refused for more than 24 hours: see the open credit-note notices",
  );

  // WPU-Y1: the hand-set exchange rate is older than 6 days (once a day, from the scheduler).
  alertFilter(
    "FxRateStaleFilter",
    schedulerFunction,
    [ALERT_LOG_EVENTS.fxRateStaleWarning],
    "FxRateStale",
  );
  const fxRateStaleAlarm = alertAlarm(
    "FxRateStaleAlarm",
    "FxRateStale",
    "The USD to BDT rate is older than 6 days or missing: set a new rate in the admin portal (purchases stop after 7 days)",
  );

  // WPU-Z1: a renewal held because it could not be priced or posted for another reason than the rate or the wallet
  // (a stored price that cannot be read, no pricing rule in force, a ledger refusal). Nothing is charged, graced or
  // retained while it lasts, so a person has to repair it: one line in 5 minutes alarms. The event AND the reason are
  // matched, so the lines of a rate hold (reason fx_rate_unavailable) stay with FxRateStaleAlarm.
  // Checked 2026-11-13 against the CloudWatch Logs page "Filter pattern syntax": a JSON pattern joins conditions with
  // `&&` without parentheses (order () > && > ||). The VERIFY of the log group above applies here too.
  new aws.cloudwatch.LogMetricFilter("RenewalPriceHoldFilter", {
    name: resourceName(stage, "renewalpriceholdfilter"),
    logGroupName: $interpolate`/aws/lambda/${schedulerFunction?.name}`,
    pattern: `{ $.event = "${ALERT_LOG_EVENTS.lifecycleRenewalHeld}" && $.reason = "${ALERT_LOG_REASONS.renewalPriceUnavailable}" }`,
    metricTransformation: {
      name: "RenewalPriceHold",
      namespace: ALERT_METRIC_NAMESPACE,
      value: "1",
      defaultValue: "0",
    },
  });
  const renewalPriceHoldAlarm = alertAlarm(
    "RenewalPriceHoldAlarm",
    "RenewalPriceHold",
    "A renewal is held because it cannot be priced (not the rate, not the wallet): see lifecycle_renewal_held with reason price_unavailable and repair the price",
  );

  // Item 36: reconciliation.
  const reconcilerFunction = workers.crons["reconciler"]?.nodes.function;
  alertFilter(
    "ReconcileBadFilter",
    reconcilerFunction,
    [
      ALERT_LOG_EVENTS.reconcileFindings,
      ALERT_LOG_EVENTS.reconcileIncomplete,
      ALERT_LOG_EVENTS.reconcileStaleOperations,
      ALERT_LOG_EVENTS.reconcileUsageFailed,
    ],
    "ReconcileBad",
  );
  const reconcileBadAlarm = alertAlarm(
    "ReconcileBadAlarm",
    "ReconcileBad",
    "The reconciliation found orphans, missing resources or stale operations, or could not finish",
  );
  alertFilter(
    "ReconcileRanFilter",
    reconcilerFunction,
    [ALERT_LOG_EVENTS.reconcileOk, ALERT_LOG_EVENTS.reconcileIncomplete],
    "ReconcileRan",
  );
  const reconcileSilentAlarm = new aws.cloudwatch.MetricAlarm("ReconcileSilentAlarm", {
    name: resourceName(stage, "reconcile-silent"),
    namespace: ALERT_METRIC_NAMESPACE,
    metricName: "ReconcileRan",
    statistic: "Sum",
    period: 3600,
    evaluationPeriods: RECONCILE_SILENCE_HOURS,
    datapointsToAlarm: RECONCILE_SILENCE_HOURS,
    threshold: 1,
    comparisonOperator: "LessThanThreshold",
    treatMissingData: "breaching",
    alarmActions: [topic.arn],
    alarmDescription: "The reconciliation finished no run for 3 hours",
  });

  // Item 36: 5xx. A Lambda that fails answers the caller with an error: for the two Next.js servers that
  // is a 5xx page, for the workers a failed run (R16 makes every job reject on failure). One alarm for
  // each function, on the AWS/Lambda Errors metric.
  // NOT BUILT, Needs decision: the CloudFront 5xxErrorRate of the two distributions. CloudFront metrics
  // live in us-east-1 and an alarm may only act on a topic of its own Region, so it needs a second topic
  // and e-mail subscriptions there.
  const customerServer = (web?.customer as { nodes?: { server?: { name: unknown } } } | undefined)
    ?.nodes?.server;
  const adminServer = (web?.admin as { nodes?: { server?: { name: unknown } } } | undefined)?.nodes
    ?.server;
  const errorTargets: [string, { name: unknown } | undefined][] = [
    ["Provisioner", provisionerFunction],
    ["Scheduler", schedulerFunction],
    ["Reconciler", reconcilerFunction],
    ["LedgerCheck", workers.crons["ledger-check"]?.nodes.function],
    ["PaymentsSweeper", workers.crons["payments-sweeper"]?.nodes.function],
    ["Notifier", workers.crons["notifier"]?.nodes.function],
    ["CatalogSync", workers.crons["catalog-sync"]?.nodes.function],
    ["WebServer", customerServer],
    ["AdminServer", adminServer],
  ];
  const functionErrorAlarms = errorTargets.map(
    ([label, fn]) =>
      new aws.cloudwatch.MetricAlarm(`${label}ErrorsAlarm`, {
        name: resourceName(stage, `${label.toLowerCase()}-errors`),
        namespace: "AWS/Lambda",
        metricName: "Errors",
        statistic: "Sum",
        period: 300,
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        treatMissingData: "notBreaching",
        dimensions: { FunctionName: fn?.name },
        alarmActions: [topic.arn],
        alarmDescription: `The ${label} function failed an invocation (5xx for a web server)`,
      }),
  );

  return {
    topic,
    deadLetterAlarm,
    schedulerAlarm,
    ledgerMismatchAlarm,
    ledgerSilentAlarm,
    capacityReleaseAlarm,
    creditNoteStuckAlarm,
    fxRateStaleAlarm,
    renewalPriceHoldAlarm,
    reconcileBadAlarm,
    reconcileSilentAlarm,
    functionErrorAlarms,
  };
}

export type Alarms = ReturnType<typeof alarms>;
