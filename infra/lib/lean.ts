// WPU-B8: the stage size. "lean" is for one AWS account and a budget of about 50 USD a month;
// "full" is the sizing the stacks had before (3.3). Pure TypeScript, tested by
// tests/repo/infra-lean.test.mjs and tests/repo/staging-on-demand.test.mjs. The stacks in infra/stacks/
// read the table below through `sizing(config.size, config.kind)`; nothing else decides a size.
//
// What lean never gives up (R2, R13, R16): RDS Proxy, TLS on instance and proxy, KMS storage
// encryption, two AZs (the RDS subnet group needs two), the WAF rate rules and the admin IP allowlist.
// Deletion protection and the final snapshot stay on production and personal stages; staging gives
// them up by owner decision (WPU-Z10, removalRules in ./stage.ts): it runs only during test sessions,
// is removed after each one, and its test data is wiped.
//
// No account id of this platform, no address and no secret is written here. The one 12-digit number
// below is the public AWS account that publishes the fck-nat images (NAT_INSTANCE.amiOwner).
import { InfraConfigError, resourceName, type StageKind } from "./stage";

export const STAGE_SIZES = ["lean", "full"] as const;
export type StageSize = (typeof STAGE_SIZES)[number];

export const STAGE_SIZE_VARIABLE = "TC_STAGE_SIZE";

// Fail closed (R16): unset or empty is "full" (today's behaviour); any other value than the two
// words is refused, so a typo can never silently pick a size.
export function parseStageSize(raw: string | undefined): StageSize {
  if (raw === undefined || raw === "") return "full";
  if ((STAGE_SIZES as readonly string[]).includes(raw)) return raw as StageSize;
  throw new InfraConfigError(`${STAGE_SIZE_VARIABLE} must be one of ${STAGE_SIZES.join(", ")}`);
}

// The monthly budget alarm of a lean stage (WPU-B8) can be switched off. Reason (2026-11-14): a service
// control policy of the AWS Organization denies budgets:ModifyBudget to this member account (deploy-staging
// run 43571996920), and the management account is never touched from here. The budget alert then lives in
// the management account (docs/runbooks/single-account-lean.md). Fail closed (R16): unset or empty is
// "on"; only "on" and "off" are accepted.
export const BUDGET_ALARM_VARIABLE = "TC_BUDGET_ALARM";

export function parseBudgetAlarm(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new InfraConfigError(`${BUDGET_ALARM_VARIABLE} must be on or off`);
}

export interface ManagedGroup {
  readonly name: string;
  readonly priority: number;
}

// "managed": sst.aws.Vpc `nat: "managed"`, a NAT gateway with its Elastic IP in each AZ (full).
// "single-instance": ONE NAT instance with one Elastic IP for the whole VPC, built by
// infra/stacks/network.ts (lean, WPU-Z10). SST 4.17.2 `nat: "ec2"` would build one t4g.nano and one
// Elastic IP PER AZ (vpc.ts createElasticIps and createNatInstances map over the zones), so two of each.
export type NatKind = "managed" | "single-instance";

export interface Sizing {
  readonly database: {
    readonly instance: string;
    readonly multiAz: boolean;
    readonly storage: string;
    readonly backupRetentionDays: number;
  };
  readonly network: {
    readonly nat: NatKind;
  };
  readonly waf: {
    readonly managedGroups: readonly ManagedGroup[];
  };
  readonly logRetentionDays: 7 | 14;
}

const COMMON = { name: "AWSManagedRulesCommonRuleSet", priority: 10 } as const;
const KNOWN_BAD_INPUTS = { name: "AWSManagedRulesKnownBadInputsRuleSet", priority: 20 } as const;
const IP_REPUTATION = { name: "AWSManagedRulesAmazonIpReputationList", priority: 30 } as const;

function freeze<T extends Sizing>(value: T): T {
  Object.freeze(value.database);
  Object.freeze(value.network);
  Object.freeze(value.waf.managedGroups.map((group) => Object.freeze(group)));
  Object.freeze(value.waf);
  return Object.freeze(value);
}

function lean(): Sizing {
  return freeze({
    database: { instance: "t4g.micro", multiAz: false, storage: "20 GB", backupRetentionDays: 7 },
    network: { nat: "single-instance" },
    waf: { managedGroups: [COMMON] },
    logRetentionDays: 7,
  });
}

function full(kind: StageKind): Sizing {
  const production = kind === "production";
  return freeze({
    database: {
      instance: production ? "t4g.medium" : "t4g.micro",
      // 3.3: Multi-AZ in production
      multiAz: production,
      storage: "20 GB",
      backupRetentionDays: 14,
    },
    network: { nat: "managed" },
    waf: { managedGroups: [COMMON, KNOWN_BAD_INPUTS, IP_REPUTATION] },
    logRetentionDays: 14,
  });
}

export function sizing(size: StageSize, kind: StageKind): Sizing {
  return size === "lean" ? lean() : full(kind);
}

// ---- NAT (WPU-Z10, requirement 1) ----------------------------------------------------------------------

// The `nat` argument of sst.aws.Vpc: none in lean (network.ts builds the single instance itself).
export function sstNatOf(nat: NatKind): "managed" | undefined {
  return nat === "managed" ? "managed" : undefined;
}

// The single NAT instance of a lean stage: the image choice of SST 4.17.2 vpc.ts (createNatInstances: the
// most recent image named fck-nat-al2023-* for arm64 from the fck-nat publisher, whose AWS account id is
// public: SST vpc.ts and the fck-nat README) on SST's default instance type (normalizeNat: t4g.nano).
// tests/repo/staging-on-demand.test.mjs compares the four values with SST's source.
export const NAT_INSTANCE = Object.freeze({
  type: "t4g.nano",
  amiOwner: "568608671756",
  amiName: "fck-nat-al2023-*",
  architecture: "arm64",
} as const);

// ---- Database backups (WPU-Z10, requirement 4) ---------------------------------------------------------

// Staging keeps one day (its data is wiped at each removal); every other stage keeps its size's days.
export const STAGING_BACKUP_RETENTION_DAYS = 1;

export function backupRetentionDays(kind: StageKind, size: StageSize): number {
  return kind === "staging"
    ? STAGING_BACKUP_RETENTION_DAYS
    : sizing(size, kind).database.backupRetentionDays;
}

// ---- Log retention (WPU-B8; WPU-Z10, requirement 2) ----------------------------------------------------

export type LogRetention = "1 week" | "2 weeks";

// The `logging.retention` value of sst.aws.Function for a size.
// VERIFY result (WPU-Z9, SST 4.17.2 components/aws/logging.ts RETENTION): "1 week" is 7 days and
// "2 weeks" 14 days.
export function logRetentionOf(size: StageSize): LogRetention {
  return size === "lean" ? "1 week" : "2 weeks";
}

// The functions of functions/ (infra/stacks/workers.ts): one week on staging whatever the size; other
// stages keep the retention of their size.
export function workerLogRetention(kind: StageKind, size: StageSize): LogRetention {
  return kind === "staging" ? "1 week" : logRetentionOf(size);
}

// The functions that SST components build (the Next.js server, image optimizer and ISR revalidation
// functions, the Cognito trigger): one week on staging; undefined elsewhere, which leaves SST's own
// defaults exactly as before (function.ts: 1 month; ssr-site.ts image optimizer: 3 days).
export function componentLogRetention(kind: StageKind): "1 week" | undefined {
  return kind === "staging" ? "1 week" : undefined;
}

// ---- Monthly budget of a lean stage (WPU-B8; WPU-Z10, requirements 5, 9 and 10) ------------------------

export interface StageBudget {
  readonly limitUsd: number;
  // Absolute ACTUAL spend in USD that notifies: half, four fifths and all of the limit, so a stage left
  // running is noticed early.
  readonly thresholdsUsd: readonly number[];
}

// Owner decisions of 2026-11-13: staging 50 USD (25, 40, 50); production, which runs lean around the
// clock at about 80 to 90 USD a month, 100 USD (50, 80, 100). A personal stage gets the staging budget.
const STAGING_BUDGET: StageBudget = Object.freeze({
  limitUsd: 50,
  thresholdsUsd: Object.freeze([25, 40, 50]),
});
const STAGE_BUDGETS: Readonly<Record<StageKind, StageBudget>> = {
  staging: STAGING_BUDGET,
  production: Object.freeze({ limitUsd: 100, thresholdsUsd: Object.freeze([50, 80, 100]) }),
  personal: STAGING_BUDGET,
};

export function budgetOf(kind: StageKind): StageBudget {
  return STAGE_BUDGETS[kind];
}

// The AWS Budgets name rules (Budget.BudgetName): 1 to 100 characters, no ":" and no "\".
const BUDGET_NAME_MAX = 100;

// The name of the budget. Every budget e-mail quotes it, so on a stage that is meant to be removed it
// says how to stop the spending: `sst remove --stage <stage>` (requirement 5). Production is never
// removed (`protect`), so its name is the plain resource name.
export function budgetName(stage: string): string {
  const base = resourceName(stage, "monthly-budget");
  const name = stage === "production" ? base : `${base} - stop it with sst remove --stage ${stage}`;
  if (name.length > BUDGET_NAME_MAX || /[:\\]/.test(name)) {
    throw new InfraConfigError("the budget name does not fit the AWS Budgets name rules");
  }
  return name;
}
