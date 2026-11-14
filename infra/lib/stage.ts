// Pure stage logic of the SST app (WP0-T2). No SST global is used here, so this file is real
// TypeScript that tsc and vitest check (tests/repo/infra-lib.test.mjs). The SST declarations in
// infra/stacks/ call these functions; they never read the process environment by themselves.
//
// No account id, domain, address or secret value is written in this repository. Everything that is
// specific to an account comes from environment variables of the deploy shell or of CI (names below).

import {
  BUDGET_ALARM_VARIABLE,
  parseBudgetAlarm,
  parseStageSize,
  STAGE_SIZE_VARIABLE,
  type StageSize,
} from "./lean";

export type StageKind = "production" | "staging" | "personal";
export type TcStage = "staging" | "production";

export const REGION = "ap-southeast-1";
export const EDGE_REGION = "us-east-1";

// "staging" and "production" are the two shared stages; any other name is a personal or per-track
// stage in the staging account (open item: one stage per track, only CI deploys "staging").
const STAGE_NAME = /^[a-z][a-z0-9-]{1,19}[a-z0-9]$/;

export class InfraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraConfigError";
  }
}

export function stageKind(stage: string): StageKind {
  if (!STAGE_NAME.test(stage)) {
    throw new InfraConfigError("stage name must be 3 to 21 characters of a-z, 0-9 and -");
  }
  if (stage === "production") return "production";
  if (stage === "staging") return "staging";
  if (stage.startsWith("prod")) {
    // fail closed: a personal stage that could be mistaken for production is refused
    throw new InfraConfigError("a personal stage name must not start with prod");
  }
  return "personal";
}

// The value of TC_STAGE (apps/web/server/config.ts accepts local, test, staging, production).
// A deployed stage is never local or test, so a deploy can never turn the fake switches on.
export function tcStage(stage: string): TcStage {
  return stageKind(stage) === "production" ? "production" : "staging";
}

// TC_ENV of the provisioner (TC_ENVS of @tc/core is ["production", "staging"]).
export const tcEnv = tcStage;

export const FAKE_SWITCHES = ["TC_EPS", "TC_IDP", "TC_SMS"] as const;

export type Env = Readonly<Record<string, string | undefined>>;

// The deploy shell must not carry a fake switch (it would be copied into function environments by
// mistake). Any non-empty value is refused, whatever it says.
export function assertNoFakeSwitches(env: Env): void {
  for (const name of FAKE_SWITCHES) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      throw new InfraConfigError(
        `${name} is set in the deploy environment; fakes exist only in local and test`,
      );
    }
  }
}

export const PRODUCTION_CI_VARIABLE = "TC_PRODUCTION_DEPLOY";
export const PRODUCTION_CI_VALUE = "ci-approved";

// R16 and the CLAUDE.md rule "never deploy production": the production stage is refused unless CI
// sets the variable and CI=true. A developer machine or a Claude Code session cannot pass this by
// accident. The workflow that sets the variable is WP0-T6, not part of this task.
export function assertDeployAllowed(stage: string, env: Env): void {
  assertNoFakeSwitches(env);
  const kind = stageKind(stage);
  if (kind !== "production") return;
  if (env[PRODUCTION_CI_VARIABLE] !== PRODUCTION_CI_VALUE || env["CI"] !== "true") {
    throw new InfraConfigError(
      `stage production is refused outside the protected CI job (${PRODUCTION_CI_VARIABLE} is not set)`,
    );
  }
}

// Names. AWS resource names of the control plane are tc-<stage>-<part>; IAM role names are fixed so
// the pool-account trust policies (6.3) can name the role by a stable aws:PrincipalArn condition.
const PART = /^[a-z][a-z0-9-]{0,40}$/;

export function resourceName(stage: string, part: string): string {
  stageKind(stage);
  if (!PART.test(part))
    throw new InfraConfigError("name part must be lowercase letters, digits and -");
  const name = `tc-${stage}-${part}`;
  if (name.length > 64) throw new InfraConfigError("resource name is longer than 64 characters");
  return name;
}

export function roleName(stage: string, fn: string): string {
  return resourceName(stage, `${fn}-role`);
}

export interface StageConfig {
  readonly stage: string;
  readonly kind: StageKind;
  readonly tcStage: TcStage;
  readonly region: string;
  // Required on every stage, personal ones included (a subdomain of the staging zone): APP_ORIGIN must be https.
  readonly webDomain: string;
  readonly adminDomain: string;
  // raw, validated by allowlist.ts
  readonly adminAllowlist: string;
  readonly alarmEmails: readonly string[];
  // SES: ARN of the verified identity the Cognito pools and the notifier send from
  readonly sesIdentityArn: string;
  readonly sesFromAddress: string;
  readonly accountId: string;
  // accounts the control plane may assume roles in (6.3): pool accounts and tc-dns. Ids come from the
  // environment only.
  readonly poolAccountIds: readonly string[];
  readonly dnsAccountId: string;
  // sts:ExternalId of the tc-dns roles: a plain value, not a secret (6.3)
  readonly dnsExternalId: string;
  // WPU-X4: the sts:ExternalId of the tc-pool-roles stack of the ONE pool account (TC_POOL_EXTERNAL_ID),
  // a plain value (6.3). Optional on every stage: null when unset. Handed to the migrator only, which
  // registers the pool account with it (poolAccountDecision of @tc/db checks the pattern of
  // infra/org/pool-roles.yaml; a malformed value is skipped there, it never fails the deploy).
  readonly poolExternalId: string | null;
  // C.5: the public /32 addresses of the stage's NAT (TC_PROBE_SOURCES) that the bootstrap beacon port
  // of a new Linux server is opened to during create: the two NAT gateways of a full stage, the ONE NAT
  // instance of a lean stage (WPU-Z10), and the network of the Lightsail VPC of the pool account
  // (TC_VPC_CIDR) that its firewall allows. Required on staging and production; a personal stage may
  // leave both out and then every Linux create stops before the static IP (R16).
  readonly probeSources: readonly string[];
  readonly vpcCidr: string | null;
  // WPU-B8: "lean" (one account, about 50 USD a month) or "full" (default). Read from TC_STAGE_SIZE.
  readonly size: StageSize;
  // The monthly budget alarm of a lean stage; TC_BUDGET_ALARM=off turns it off (infra/lib/lean.ts).
  readonly budgetAlarm: boolean;
  // WPU-Z10: the Cognito user pools that a removal of staging kept (removalRules) and that this deploy
  // adopts again (Pulumi `import`, infra/stacks/auth.ts). Null: the deploy creates the pool. Staging only.
  readonly userPoolIds: UserPoolIds;
}

export interface UserPoolIds {
  readonly customers: string | null;
  readonly admins: string | null;
}

// ---- TC_PROBE_SOURCES and TC_VPC_CIDR -----------------------------------------------------------------
// The same rules as parseProbeSources of packages/aws/adapters/bootstrap-probe.ts (infra must not import
// packages/aws, R1; a repo test compares the two). They throw with a message that names the variable,
// where the runtime parser answers null: a deploy that would leave every Linux create closed is refused
// at synth time, not discovered by the first customer.
const MAX_PROBE_SOURCES = 10;
const MIN_PROBE_PREFIX = 16;
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function cidrParts(value: string): { octets: number[]; prefix: number } | null {
  const m = IPV4_CIDR.exec(value);
  if (m === null) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  return { octets, prefix };
}

// A dotted IPv4 outside private, loopback, link-local, shared, multicast and reserved space.
function isPublicAddress(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function isPrivateAddress(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseProbeSourcesConfig(raw: string): readonly string[] {
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length > MAX_PROBE_SOURCES) {
    throw new InfraConfigError(`TC_PROBE_SOURCES lists more than ${MAX_PROBE_SOURCES} addresses`);
  }
  for (const part of parts) {
    const cidr = cidrParts(part);
    if (cidr === null) {
      throw new InfraConfigError(`TC_PROBE_SOURCES entry is not an IPv4 CIDR: ${part}`);
    }
    if (cidr.prefix < MIN_PROBE_PREFIX) {
      throw new InfraConfigError(
        `TC_PROBE_SOURCES entry ${part} is wider than /${MIN_PROBE_PREFIX} (use the /32 of each NAT address)`,
      );
    }
    if (!isPublicAddress(cidr.octets)) {
      throw new InfraConfigError(`TC_PROBE_SOURCES entry ${part} is not a public address`);
    }
  }
  return Object.freeze(parts);
}

export function parseVpcCidrConfig(raw: string): string {
  const value = raw.trim();
  const cidr = cidrParts(value);
  if (cidr === null) throw new InfraConfigError("TC_VPC_CIDR is not an IPv4 CIDR");
  if (!isPrivateAddress(cidr.octets)) {
    throw new InfraConfigError("TC_VPC_CIDR must be a private (RFC 1918) network");
  }
  if (cidr.prefix < 16 || cidr.prefix > 28) {
    throw new InfraConfigError("TC_VPC_CIDR prefix must be between /16 and /28");
  }
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function need(env: Env, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InfraConfigError(`${name} is required for this stage`);
  }
  return value.trim();
}

function host(env: Env, name: string): string {
  const raw = need(env, name);
  if (!HOST.test(raw)) throw new InfraConfigError(`${name} is not a host name`);
  return raw;
}

// ---- Cognito user pools that staging keeps between test sessions (WPU-Z10) ------------------------------
// A removal of staging keeps both pools (removalRules: retainUserPools), so the admin users and their TOTP
// survive. The next deploy would create two new, empty pools unless it is told the ids of the kept ones:
// a person records them once (stack outputs customerPoolId and adminPoolId) as these variables, and every
// later deploy adopts the pools (docs/runbooks/staging-on-demand.md). Only staging keeps and adopts pools:
// a value on another stage is refused (R16), so production can never adopt a pool by mistake.
export const USER_POOL_ID_VARIABLES = {
  customers: "TC_COGNITO_CUSTOMER_POOL_ID",
  admins: "TC_COGNITO_ADMIN_POOL_ID",
} as const;

// A user pool id is <Region>_<letters and digits> (Cognito API UserPoolId); the pools live in REGION.
const USER_POOL_ID = new RegExp(`^${REGION}_[0-9A-Za-z]{1,40}$`);

function readUserPoolIds(kind: StageKind, env: Env): UserPoolIds {
  const read = (name: string): string | null => {
    const value = optional(env, name);
    if (value === undefined) return null;
    if (kind !== "staging") {
      throw new InfraConfigError(`${name} is for the staging stage only (it adopts a kept pool)`);
    }
    if (!USER_POOL_ID.test(value)) {
      throw new InfraConfigError(`${name} is not a Cognito user pool id of ${REGION}`);
    }
    return value;
  };
  return {
    customers: read(USER_POOL_ID_VARIABLES.customers),
    admins: read(USER_POOL_ID_VARIABLES.admins),
  };
}

// Reads the stage configuration from the environment of the deploy. The names are listed in
// JOURNEY.md for DevOps. Values for staging and production come from the CI environment.
export function readStageConfig(stage: string, env: Env): StageConfig {
  assertDeployAllowed(stage, env);
  const kind = stageKind(stage);
  const alarmEmails = need(env, "TC_ALARM_EMAILS")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (alarmEmails.length === 0 || !alarmEmails.every((value) => EMAIL.test(value))) {
    throw new InfraConfigError("TC_ALARM_EMAILS must list e-mail addresses");
  }
  const sesIdentityArn = need(env, "TC_SES_IDENTITY_ARN");
  if (!sesIdentityArn.startsWith("arn:aws:ses:")) {
    throw new InfraConfigError("TC_SES_IDENTITY_ARN must be an SES identity ARN");
  }
  const accountId = need(env, "TC_ACCOUNT_ID");
  if (!/^[0-9]{12}$/.test(accountId)) throw new InfraConfigError("TC_ACCOUNT_ID must be 12 digits");
  const ids = (name: string): string[] =>
    need(env, name)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
  const poolAccountIds = ids("TC_POOL_ACCOUNT_IDS");
  const dnsAccountId = need(env, "TC_DNS_ACCOUNT_ID");
  if (
    poolAccountIds.length === 0 ||
    ![...poolAccountIds, dnsAccountId].every((id) => /^[0-9]{12}$/.test(id))
  ) {
    throw new InfraConfigError(
      "TC_POOL_ACCOUNT_IDS and TC_DNS_ACCOUNT_ID must be 12-digit account ids",
    );
  }
  // C.5: required on the shared stages; a personal stage may omit both (and then no Linux create runs).
  const probeRaw =
    kind === "personal" ? optional(env, "TC_PROBE_SOURCES") : need(env, "TC_PROBE_SOURCES");
  const vpcRaw = kind === "personal" ? optional(env, "TC_VPC_CIDR") : need(env, "TC_VPC_CIDR");
  return {
    stage,
    kind,
    tcStage: tcStage(stage),
    region: REGION,
    webDomain: host(env, "TC_DOMAIN_WEB"),
    adminDomain: host(env, "TC_DOMAIN_ADMIN"),
    adminAllowlist: need(env, "TC_ADMIN_ALLOWLIST"),
    alarmEmails,
    sesIdentityArn,
    sesFromAddress: need(env, "TC_SES_FROM_ADDRESS"),
    accountId,
    poolAccountIds,
    dnsAccountId,
    dnsExternalId: need(env, "TC_DNS_EXTERNAL_ID"),
    poolExternalId: optional(env, "TC_POOL_EXTERNAL_ID") ?? null,
    probeSources: probeRaw === undefined ? [] : parseProbeSourcesConfig(probeRaw),
    vpcCidr: vpcRaw === undefined ? null : parseVpcCidrConfig(vpcRaw),
    size: parseStageSize(env[STAGE_SIZE_VARIABLE]),
    budgetAlarm: parseBudgetAlarm(env[BUDGET_ALARM_VARIABLE]),
    userPoolIds: readUserPoolIds(kind, env),
  };
}

// ---- Removal (SST app() `removal`, and what the stacks keep or delete) --------------------------------
// WPU-Z10 (owner decision 2026-11-13, JOURNEY.md): staging runs only during test sessions and ends with
// `sst remove --stage staging`, which must delete everything that costs money; its test data is wiped.
// So staging is "remove" like a personal stage. SST "retain" would keep the RDS instance, its subnet and
// parameter groups, the VPC with its subnets and the S3 buckets (.sst/platform/src/auto/run.ts,
// addTransformationToRetainResourcesOnDelete), which is what production needs and staging must not do.
// Production keeps "retain", and `protect` (infra/app.ts) refuses `sst remove` on it altogether.
export function removalPolicy(stage: string): "retain" | "remove" {
  return stageKind(stage) === "production" ? "retain" : "remove";
}

export interface RemovalRules {
  // RDS deletion protection, and a final snapshot when the instance is deleted (3.3, R13).
  readonly databaseDeletionProtection: boolean;
  readonly databaseFinalSnapshot: boolean;
  // true: the stack sets S3 forceDestroy itself, so a removal empties each bucket (every object version)
  // and deletes it. false: the stack leaves the bucket arguments as SST builds them (SST 4.17.2
  // bucket.ts createBucket already sets forceDestroy true), so nothing changes for that stage.
  readonly forceEmptyBuckets: boolean;
  // The two Cognito user pools survive a removal (Pulumi retainOnDelete) and are adopted again by the next
  // deploy (UserPoolIds above): free to keep, and their admin users and TOTP are painful to recreate.
  readonly retainUserPools: boolean;
}

// - production: exactly as before WPU-Z10 (`retain`, protection, final snapshot, buckets and pools as SST
//   builds them).
// - staging: nothing that costs money survives a removal: no deletion protection, no final snapshot (the
//   test data is wiped by decision), buckets emptied; the user pools (and the SST secrets, which `sst
//   remove` leaves alone unless the app sets state.purge) are kept.
// - personal: unchanged (protection and final snapshot on, buckets and pools as SST builds them).
const REMOVAL_RULES: Readonly<Record<StageKind, RemovalRules>> = {
  production: Object.freeze({
    databaseDeletionProtection: true,
    databaseFinalSnapshot: true,
    forceEmptyBuckets: false,
    retainUserPools: false,
  }),
  staging: Object.freeze({
    databaseDeletionProtection: false,
    databaseFinalSnapshot: false,
    forceEmptyBuckets: true,
    retainUserPools: true,
  }),
  personal: Object.freeze({
    databaseDeletionProtection: true,
    databaseFinalSnapshot: true,
    forceEmptyBuckets: false,
    retainUserPools: false,
  }),
};

export function removalRules(kind: StageKind): RemovalRules {
  return REMOVAL_RULES[kind];
}

// ---- The tags SST puts on every resource (WPU-Z10, budget filter) ---------------------------------------
// The SST 4.17.2 CLI configures the AWS provider with defaultTags {"sst:app": <app>, "sst:stage": <stage>}
// (.sst/platform/src/components/aws/helpers/provider.ts shows the config; the CLI binary sets it), and
// SST's own providers for other Regions copy that config (useProvider). A provider built by hand does not:
// infra/stacks/waf.ts passes these tags to its us-east-1 provider. The lean budget (infra/stacks/budget.ts)
// counts only the costs that carry BOTH tags, once a person has activated them as cost allocation tags in
// the payer account (docs/runbooks/staging-on-demand.md).
export function sstTags(
  app: string,
  stage: string,
): Readonly<Record<"sst:app" | "sst:stage", string>> {
  return Object.freeze({ "sst:app": app, "sst:stage": stage });
}

const POOL_ONLY = ["TcProvisioner", "TcReader", "TcAccessDetails"] as const;
const DNS_ONLY = ["TcDnsProvisioner", "TcDnsReader"] as const;

// The role ARNs a function may assume (R1: web and admin get none). TcBillingReader exists in each
// pool account and in tc-dns (6.3). The ARNs are built here from the environment; no account id is
// written in the repository.
export function assumableRoleArns(
  role: string,
  config: Pick<StageConfig, "poolAccountIds" | "dnsAccountId">,
): readonly string[] {
  const arn = (account: string) => `arn:aws:iam::${account}:role/${role}`;
  if ((POOL_ONLY as readonly string[]).includes(role)) return config.poolAccountIds.map(arn);
  if ((DNS_ONLY as readonly string[]).includes(role)) return [arn(config.dnsAccountId)];
  if (role === "TcBillingReader") return [...config.poolAccountIds, config.dnsAccountId].map(arn);
  throw new InfraConfigError(`unknown pool role ${role}`);
}
