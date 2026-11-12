// Pure stage logic of the SST app (WP0-T2). No SST global is used here, so this file is real
// TypeScript that tsc and vitest check (tests/repo/infra-lib.test.mjs). The SST declarations in
// infra/stacks/ call these functions; they never read the process environment by themselves.
//
// No account id, domain, address or secret value is written in this repository. Everything that is
// specific to an account comes from environment variables of the deploy shell or of CI (names below).

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
  };
}

// Removal and protection of stateful resources (SST app() fields).
export function removalPolicy(stage: string): "retain" | "remove" {
  return stageKind(stage) === "personal" ? "remove" : "retain";
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
