// WPU-B8: the monthly cost budget of a lean stage. Called from infra/app.ts only when config.size is
// "lean" and config.budgetAlarm is on (TC_BUDGET_ALARM, infra/lib/lean.ts). It notifies the alarm topic of alarms.ts, so the same people get the mail.
// WPU-Z10 (owner decisions 2026-11-13): staging 50 USD with notifications at 25, 40 and 50 USD;
// production (lean, around the clock) 100 USD at 50, 80 and 100 USD; a personal stage as staging
// (infra/lib/lean.ts budgetOf). The budget counts only this app's stage: the account also runs the
// owner's other projects, so an unfiltered budget would count all of them.
//
// NOT TYPE-CHECKED, see network.ts.
import { budgetName, budgetOf } from "../lib/lean";
import { sstTags, type StageConfig } from "../lib/stage";

export function budget(config: StageConfig, topic: aws.sns.Topic) {
  const stage = config.stage;
  const plan = budgetOf(config.kind);

  // AWS Budgets publishes to the topic as the service principal budgets.amazonaws.com, so the topic
  // policy must allow it. This policy REPLACES the topic's default one, so the default statement
  // (publish and manage by the owner account) is repeated. The account id comes from the stage
  // configuration (environment), never from the repository.
  // VERIFY: the $jsonStringify global of SST; aws.sns.TopicPolicy arguments (arn, policy) in Pulumi AWS v7; that the repeated default
  // statement keeps CloudWatch alarms publishing; that the SNS topic may be in a Region other than
  // the budget's home Region (Budgets is global).
  new aws.sns.TopicPolicy("BudgetTopicPolicy", {
    arn: topic.arn,
    policy: $jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OwnerAccount",
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: ["sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes", "sns:Receive"],
          Resource: topic.arn,
          Condition: { StringEquals: { "AWS:SourceOwner": config.accountId } },
        },
        {
          Sid: "AllowBudgets",
          Effect: "Allow",
          Principal: { Service: "budgets.amazonaws.com" },
          Action: "sns:Publish",
          Resource: topic.arn,
          Condition: { StringEquals: { "aws:SourceAccount": config.accountId } },
        },
      ],
    }),
  });

  // WPU-Z10 (requirement 9): only the costs that carry BOTH tags that SST puts on every resource of this
  // app and stage (infra/lib/stage.ts sstTags): sst:app = the app name AND sst:stage = this stage. A
  // person must activate the two keys as cost allocation tags in the Billing console of the PAYER account
  // (docs/runbooks/staging-on-demand.md); until then the filter counts nothing and this budget never
  // notifies, so the runbook's next-day Cost Explorer check is the guard. FilterExpression replaces the
  // deprecated CostFilters (AWS Budgets API reference, Budget); Pulumi AWS 7.20.0 types it as
  // `filterExpression: { ands: [{ tags: { key, values } }] }`.
  // VERIFY (first deploy): the Budgets console shows the two tag conditions, and a tag key in a Budgets
  // Expression is the plain key (`sst:app`), as in Cost Explorer, without the `user:` prefix of the old
  // TagKeyValue filter. Resources that cannot carry tags (data transfer, for example) are not counted.
  //
  // The name of the budget is quoted by every budget e-mail, and on staging it says how to stop the
  // spending: `sst remove --stage staging` (requirement 5, budgetName).
  // VERIFY: aws.budgets.Budget argument names in Pulumi AWS v7 (budgetType, limitAmount as a string,
  // limitUnit, timeUnit, notifications[].comparisonOperator / threshold / thresholdType /
  // notificationType / subscriberSnsTopicArns), and that thresholdType "ABSOLUTE_VALUE" with
  // comparisonOperator "GREATER_THAN" notifies when actual spend passes each threshold.
  const monthly = new aws.budgets.Budget("MonthlyBudget", {
    name: budgetName(stage),
    budgetType: "COST",
    limitAmount: String(plan.limitUsd),
    limitUnit: "USD",
    timeUnit: "MONTHLY",
    filterExpression: {
      ands: Object.entries(sstTags($app.name, stage)).map(([key, value]) => ({
        tags: { key, values: [value] },
      })),
    },
    notifications: plan.thresholdsUsd.map((threshold) => ({
      comparisonOperator: "GREATER_THAN",
      threshold,
      thresholdType: "ABSOLUTE_VALUE",
      notificationType: "ACTUAL",
      subscriberSnsTopicArns: [topic.arn],
    })),
  });

  return { monthly };
}

export type Budget = ReturnType<typeof budget>;
