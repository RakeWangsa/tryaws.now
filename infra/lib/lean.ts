// WPU-B8: the stage size. "lean" is for one AWS account and a budget of about 50 USD a month;
// "full" is the sizing the stacks had before (3.3). Pure TypeScript, tested by
// tests/repo/infra-lean.test.mjs. The stacks in infra/stacks/ read the table below through
// `sizing(config.size, config.kind)`; nothing else decides a size.
//
// What lean never gives up (R2, R13, R16): RDS Proxy, TLS on instance and proxy, KMS storage
// encryption, deletion protection, the final snapshot, two AZs (the RDS subnet group needs two), the
// WAF rate rules and the admin IP allowlist.
//
// No account id, address or secret is written here.
import { InfraConfigError, type StageKind } from "./stage";

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

// The monthly budget of a lean stage (USD), and the absolute actual-spend amounts that notify.
export const LEAN_BUDGET_USD = 50;
export const LEAN_BUDGET_THRESHOLDS_USD = Object.freeze([40, 50] as const);

export interface ManagedGroup {
  readonly name: string;
  readonly priority: number;
}

export interface Sizing {
  readonly database: {
    readonly instance: string;
    readonly multiAz: boolean;
    readonly storage: string;
    readonly backupRetentionDays: number;
  };
  readonly network: {
    // sst.aws.Vpc `nat`: "managed" = NAT gateways, "ec2" = NAT instance(s).
    readonly nat: "managed" | "ec2";
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
    network: { nat: "ec2" },
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

// The `logging.retention` value of sst.aws.Function for a size.
// VERIFY: sst.aws.Function `logging.retention` accepts "1 week" and "2 weeks" (the docs list
// "1 day", "3 days", "5 days", "1 week", "2 weeks", "1 month" and longer).
export function logRetentionOf(size: StageSize): "1 week" | "2 weeks" {
  return size === "lean" ? "1 week" : "2 weeks";
}
