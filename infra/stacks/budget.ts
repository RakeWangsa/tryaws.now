// WPU-B8: the monthly cost budget of a lean stage (about 50 USD). Called from infra/app.ts only when
// config.size is "lean". It notifies the alarm topic of alarms.ts, so the same people get the mail.
//
// NOT TYPE-CHECKED, see network.ts.
import { LEAN_BUDGET_THRESHOLDS_USD, LEAN_BUDGET_USD } from "../lib/lean";
import { resourceName, type StageConfig } from "../lib/stage";

export function budget(config: StageConfig, topic: { arn: unknown }) {
  const stage = config.stage;

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

  // VERIFY: aws.budgets.Budget argument names in Pulumi AWS v7 (budgetType, limitAmount as a string,
  // limitUnit, timeUnit, notifications[].comparisonOperator / threshold / thresholdType /
  // notificationType / subscriberSnsTopicArns), and that thresholdType "ABSOLUTE_VALUE" with
  // comparisonOperator "GREATER_THAN" notifies when actual spend passes 40 and 50 USD.
  const monthly = new aws.budgets.Budget("MonthlyBudget", {
    name: resourceName(stage, "monthly-budget"),
    budgetType: "COST",
    limitAmount: String(LEAN_BUDGET_USD),
    limitUnit: "USD",
    timeUnit: "MONTHLY",
    notifications: LEAN_BUDGET_THRESHOLDS_USD.map((threshold) => ({
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
