// WPU-Z10 (owner decision 2026-11-13, JOURNEY.md "cost"): staging runs only during test sessions
// (`sst deploy --stage staging`, test, `sst remove --stage staging`). While it runs it is as cheap as the
// rules allow (one NAT instance, one week of logs, one day of backups); a removal deletes everything that
// costs money and keeps the two Cognito user pools and the SST secrets. Production keeps `retain`,
// deletion protection and its final snapshot exactly as before; personal stages keep their behaviour.
// The pure rules of infra/lib are run here; the stack files (SST globals) are proven by their text, and
// by `tsc -p infra/tsconfig.stacks.json` in tests/repo/sst-types.test.mjs where SST is installed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withForcedTls } from "../../infra/lib/database.ts";
import {
  NAT_INSTANCE,
  STAGE_SIZES,
  backupRetentionDays,
  budgetName,
  budgetOf,
  componentLogRetention,
  logRetentionOf,
  sizing,
  sstNatOf,
  workerLogRetention,
} from "../../infra/lib/lean.ts";
import {
  VPC_CIDR,
  cidrContains,
  cidrsOverlap,
  isolatedSubnets,
  rebaseSubnetCidr,
} from "../../infra/lib/network.ts";
import {
  InfraConfigError,
  USER_POOL_ID_VARIABLES,
  readStageConfig,
  removalPolicy,
  removalRules,
  resourceName,
  sstTags,
} from "../../infra/lib/stage.ts";

const root = resolve(import.meta.dirname, "../..");
const KINDS = ["production", "staging", "personal"];

const env = {
  TC_ALARM_EMAILS: "oncall@example.com",
  TC_SES_IDENTITY_ARN: "arn:aws:ses:ap-southeast-1:111111111111:identity/example.com",
  TC_SES_FROM_ADDRESS: "no-reply@example.com",
  TC_ACCOUNT_ID: "111111111111",
  TC_POOL_ACCOUNT_IDS: "111111111111",
  TC_DNS_ACCOUNT_ID: "111111111111",
  TC_DNS_EXTERNAL_ID: "external-id-value",
  TC_DOMAIN_WEB: "staging.example.com",
  TC_DOMAIN_ADMIN: "admin-staging.example.com",
  TC_ADMIN_ALLOWLIST: "203.0.113.0/24",
  TC_PROBE_SOURCES: "198.51.100.10/32",
  TC_VPC_CIDR: "172.26.0.0/16",
};
const productionEnv = { ...env, CI: "true", TC_PRODUCTION_DEPLOY: "ci-approved" };

describe("requirement 3: what a removal deletes and keeps, per stage kind", () => {
  it("staging is removed (remove), production retains (retain), personal stages stay remove", () => {
    expect(removalPolicy("staging")).toBe("remove");
    expect(removalPolicy("production")).toBe("retain");
    expect(removalPolicy("track-b")).toBe("remove");
  });

  it("production keeps deletion protection, the final snapshot and its buckets exactly as before", () => {
    expect(removalRules("production")).toEqual({
      databaseDeletionProtection: true,
      databaseFinalSnapshot: true,
      forceEmptyBuckets: false,
      retainUserPools: false,
    });
  });

  it("staging: no deletion protection, no final snapshot (test data is wiped), buckets emptied, the user pools kept", () => {
    expect(removalRules("staging")).toEqual({
      databaseDeletionProtection: false,
      databaseFinalSnapshot: false,
      forceEmptyBuckets: true,
      retainUserPools: true,
    });
  });

  it("a personal stage keeps its behaviour: protection and final snapshot on, SST's buckets, pools not retained", () => {
    expect(removalRules("personal")).toEqual({
      databaseDeletionProtection: true,
      databaseFinalSnapshot: true,
      forceEmptyBuckets: false,
      retainUserPools: false,
    });
  });

  it("is frozen (a stack cannot change the rules)", () => {
    for (const kind of KINDS) expect(Object.isFrozen(removalRules(kind)), kind).toBe(true);
  });
});

describe("requirement 3: the user pools that staging keeps are adopted again by the next deploy", () => {
  const ids = { customers: "ap-southeast-1_AbCdEf123", admins: "ap-southeast-1_ZyXwVu987" };
  const withIds = (base) => ({
    ...base,
    [USER_POOL_ID_VARIABLES.customers]: ids.customers,
    [USER_POOL_ID_VARIABLES.admins]: ids.admins,
  });

  it("names the two variables", () => {
    expect(USER_POOL_ID_VARIABLES).toEqual({
      customers: "TC_COGNITO_CUSTOMER_POOL_ID",
      admins: "TC_COGNITO_ADMIN_POOL_ID",
    });
  });

  it("are optional: unset means the deploy creates the pools", () => {
    expect(readStageConfig("staging", env).userPoolIds).toEqual({ customers: null, admins: null });
    expect(readStageConfig("production", productionEnv).userPoolIds).toEqual({
      customers: null,
      admins: null,
    });
  });

  it("are read on staging, each on its own", () => {
    expect(readStageConfig("staging", withIds(env)).userPoolIds).toEqual(ids);
    expect(
      readStageConfig("staging", { ...env, TC_COGNITO_ADMIN_POOL_ID: ` ${ids.admins} ` })
        .userPoolIds,
    ).toEqual({ customers: null, admins: ids.admins });
  });

  it("are refused on production and on a personal stage (fail closed: only staging adopts pools)", () => {
    expect(() => readStageConfig("production", withIds(productionEnv))).toThrow(
      /TC_COGNITO_CUSTOMER_POOL_ID/,
    );
    expect(() => readStageConfig("track-b", withIds(env))).toThrow(InfraConfigError);
  });

  it("refuse anything that is not a user pool id of the control plane Region", () => {
    for (const bad of [
      "us-east-1_AbCdEf123",
      "ap-southeast-1_",
      "ap-southeast-1-AbCdEf123",
      "AbCdEf123",
      "ap-southeast-1_Ab/Cd",
      `ap-southeast-1_${"a".repeat(41)}`,
    ]) {
      expect(
        () => readStageConfig("staging", { ...env, TC_COGNITO_CUSTOMER_POOL_ID: bad }),
        bad,
      ).toThrow(/TC_COGNITO_CUSTOMER_POOL_ID/);
    }
  });
});

describe("requirement 4: database backups", () => {
  it("staging keeps one day whatever the size; production and personal stages are unchanged", () => {
    for (const size of STAGE_SIZES) expect(backupRetentionDays("staging", size), size).toBe(1);
    for (const kind of ["production", "personal"]) {
      for (const size of STAGE_SIZES) {
        expect(backupRetentionDays(kind, size), `${kind} ${size}`).toBe(
          sizing(size, kind).database.backupRetentionDays,
        );
      }
    }
    expect(backupRetentionDays("production", "full")).toBe(14);
    expect(backupRetentionDays("production", "lean")).toBe(7);
  });
});

describe("requirement 2: log retention", () => {
  it("staging: one week for the workers and for every function SST builds, in both sizes", () => {
    for (const size of STAGE_SIZES) {
      expect(workerLogRetention("staging", size), size).toBe("1 week");
    }
    expect(componentLogRetention("staging")).toBe("1 week");
  });

  it("production and personal stages are unchanged: workers by size, SST's own default elsewhere", () => {
    for (const kind of ["production", "personal"]) {
      for (const size of STAGE_SIZES) {
        expect(workerLogRetention(kind, size), `${kind} ${size}`).toBe(logRetentionOf(size));
      }
      expect(componentLogRetention(kind), kind).toBeUndefined();
    }
  });
});

describe("requirements 1 and 10: one NAT instance on every lean stage", () => {
  it("lean builds its own single NAT instance on every stage kind, production included; full keeps managed NAT", () => {
    for (const kind of KINDS) {
      expect(sizing("lean", kind).network.nat, kind).toBe("single-instance");
      expect(sizing("full", kind).network.nat, kind).toBe("managed");
    }
  });

  it("asks sst.aws.Vpc for no NAT in lean (it would build one per AZ) and for managed NAT in full", () => {
    expect(sstNatOf("single-instance")).toBeUndefined();
    expect(sstNatOf("managed")).toBe("managed");
  });

  it("is a fck-nat t4g.nano of the fck-nat publisher, arm64, the latest image", () => {
    expect(NAT_INSTANCE).toEqual({
      type: "t4g.nano",
      amiOwner: "568608671756",
      amiName: "fck-nat-al2023-*",
      architecture: "arm64",
    });
    expect(Object.isFrozen(NAT_INSTANCE)).toBe(true);
  });

  const vpcSource = resolve(root, ".sst/platform/src/components/aws/vpc.ts");
  it.skipIf(!existsSync(vpcSource))(
    "makes the same AMI choice as SST 4.17.2 vpc.ts (skipped when the SST platform is not installed)",
    () => {
      const text = readFileSync(vpcSource, "utf8");
      expect(text).toContain(`owners: ["${NAT_INSTANCE.amiOwner}"]`);
      expect(text).toContain(`values: ["${NAT_INSTANCE.amiName}"]`);
      expect(text).toContain(`values: ["${NAT_INSTANCE.architecture}"]`);
      expect(text).toContain(`ec2: { instance: "${NAT_INSTANCE.type}"`);
      expect(text).toContain("mostRecent: true");
    },
  );
});

describe("requirement 11: the SST subnets are rebased onto the stage's VPC CIDR", () => {
  // SST 4.17.2 vpc.ts: public 10.0.(8 x i).0/22 and private 10.0.(8 x i + 4).0/22, whatever the VPC CIDR.
  const sstLayout = ["10.0.0.0/22", "10.0.4.0/22", "10.0.8.0/22", "10.0.12.0/22"];

  it("moves every subnet of SST's layout into the VPC of the stage kind, clear of the isolated subnets", () => {
    for (const kind of KINDS) {
      const rebased = sstLayout.map((cidr) => rebaseSubnetCidr(cidr, kind));
      const prefix = VPC_CIDR[kind].split(".").slice(0, 2).join(".");
      expect(rebased, kind).toEqual([
        `${prefix}.0.0/22`,
        `${prefix}.4.0/22`,
        `${prefix}.8.0/22`,
        `${prefix}.12.0/22`,
      ]);
      for (const cidr of rebased) {
        expect(cidrContains(VPC_CIDR[kind], cidr), cidr).toBe(true);
        for (const isolated of isolatedSubnets(kind)) {
          expect(cidrsOverlap(cidr, isolated.cidr), `${cidr} ${isolated.cidr}`).toBe(false);
        }
      }
      for (const a of rebased) {
        for (const b of rebased) if (a !== b) expect(cidrsOverlap(a, b)).toBe(false);
      }
    }
  });

  it("fails closed when SST's layout is not the one it was written for", () => {
    for (const bad of ["10.1.0.0/22", "192.168.0.0/22", "10.0.0.0", "", "10.0.300.0/22"]) {
      expect(() => rebaseSubnetCidr(bad, "staging"), bad).toThrow(InfraConfigError);
    }
  });
});

describe("requirement 11: TLS is forced by exactly one rds.force_ssl entry", () => {
  // SST 4.17.2 postgres.ts createParameterGroup sets these two; the transform used to append a second
  // rds.force_ssl (0 and 1 in one group, a permanent diff).
  const sstDefaults = [
    { name: "rds.force_ssl", value: "0" },
    { name: "rds.logical_replication", value: "1", applyMethod: "pending-reboot" },
  ];

  it("replaces SST's rds.force_ssl 0 with 1 and keeps every other parameter", () => {
    expect(withForcedTls(sstDefaults)).toEqual([
      { name: "rds.logical_replication", value: "1", applyMethod: "pending-reboot" },
      { name: "rds.force_ssl", value: "1", applyMethod: "immediate" },
    ]);
  });

  it("leaves exactly one entry whatever it is given", () => {
    for (const input of [
      [],
      [{ name: "rds.force_ssl", value: "1" }],
      [...sstDefaults, { name: "rds.force_ssl", value: "0", applyMethod: "pending-reboot" }],
    ]) {
      const forced = withForcedTls(input).filter((p) => p.name === "rds.force_ssl");
      expect(forced).toEqual([{ name: "rds.force_ssl", value: "1", applyMethod: "immediate" }]);
    }
  });
});

describe("requirements 5, 9 and 10: the monthly budget of a lean stage", () => {
  it("staging: 50 USD with notifications at 25, 40 and 50 USD (50, 80 and 100 per cent)", () => {
    expect(budgetOf("staging")).toEqual({ limitUsd: 50, thresholdsUsd: [25, 40, 50] });
  });

  it("production: 100 USD with notifications at 50, 80 and 100 USD", () => {
    expect(budgetOf("production")).toEqual({ limitUsd: 100, thresholdsUsd: [50, 80, 100] });
  });

  it("a personal stage gets the staging budget", () => {
    expect(budgetOf("personal")).toEqual(budgetOf("staging"));
  });

  it("notifies at half, four fifths and all of the limit, rising", () => {
    for (const kind of KINDS) {
      const { limitUsd, thresholdsUsd } = budgetOf(kind);
      expect(thresholdsUsd, kind).toEqual([limitUsd * 0.5, limitUsd * 0.8, limitUsd]);
      expect(Object.isFrozen(thresholdsUsd), kind).toBe(true);
    }
  });

  it("names `sst remove --stage staging` in the budget name, which every budget e-mail quotes", () => {
    const name = budgetName("staging");
    expect(name.startsWith(resourceName("staging", "monthly-budget"))).toBe(true);
    expect(name).toContain("sst remove --stage staging");
    expect(budgetName("track-b")).toContain("sst remove --stage track-b");
  });

  it("never tells production to remove itself", () => {
    expect(budgetName("production")).toBe("tc-production-monthly-budget");
  });

  it("fits the Budgets name rules for every stage name: at most 100 characters, no colon, no backslash", () => {
    const longest = `a${"b".repeat(19)}c`;
    for (const stage of ["staging", "production", "track-b", longest]) {
      const name = budgetName(stage);
      expect(name.length, stage).toBeLessThanOrEqual(100);
      expect(name, stage).not.toMatch(/[:\\]|\/action\//);
    }
  });

  it("filters on the tags SST puts on every resource: the app AND the stage", () => {
    expect(sstTags("tryaws-now", "staging")).toEqual({
      "sst:app": "tryaws-now",
      "sst:stage": "staging",
    });
    expect(Object.isFrozen(sstTags("tryaws-now", "production"))).toBe(true);
  });
});

// ---- The stack text of every requirement (the stacks use SST globals, so their text is pinned) ----------

const text = (file) => readFileSync(resolve(root, file), "utf8");
// Without comments and with single spaces, as tests/repo/infra-rules.test.mjs reads the stacks.
const code = (file) =>
  text(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ");

describe("requirement 1: network.ts builds one NAT instance with one Elastic IP on a lean stage", () => {
  const network = code("infra/stacks/network.ts");

  it("asks the Vpc for no NAT in lean and builds exactly one instance, one Elastic IP and one association", () => {
    expect(network).toContain("nat: sstNatOf(nat)");
    expect(network.match(/new aws\.ec2\.Instance\(/g)).toHaveLength(1);
    expect(network.match(/new aws\.ec2\.Eip\(/g)).toHaveLength(1);
    expect(network.match(/new aws\.ec2\.EipAssociation\(/g)).toHaveLength(1);
    expect(network).toContain(
      'const singleNat = nat === "single-instance" ? singleNatInstance(config, vpc) : undefined',
    );
  });

  it("uses SST's image choice on a t4g.nano and turns off the source/destination check", () => {
    expect(network).toContain("owners: [NAT_INSTANCE.amiOwner]");
    expect(network).toContain("values: [NAT_INSTANCE.amiName]");
    expect(network).toContain("values: [NAT_INSTANCE.architecture]");
    expect(network).toContain("mostRecent: true");
    expect(network).toContain("instanceType: NAT_INSTANCE.type");
    expect(network).toContain("sourceDestCheck: false");
  });

  it("routes 0.0.0.0/0 of every private route table (both AZs) to the instance, on lean only", () => {
    expect(network).toContain(
      'args.routes = [{ cidrBlock: "0.0.0.0/0", networkInterfaceId: $output(natInterface.promise) }]',
    );
    expect(network).toContain(
      '...(nat === "single-instance" ? { privateRouteTable: routeToSingleNat } : {})',
    );
    expect(network).toContain("natInterface.resolve(singleNat.instance.primaryNetworkInterfaceId)");
    // The isolated subnets of invoice-renderer keep their route table without a default route.
    expect(network).toContain('new aws.ec2.RouteTable("IsolatedRouteTable", { vpcId: vpc.id })');
  });

  it("keeps the NAT security group minimal: inbound from the VPC CIDR only, outbound anywhere", () => {
    const group = network.slice(
      network.indexOf('"NatSecurityGroup"'),
      network.indexOf('"NatInstance"'),
    );
    expect(group).toContain(
      'ingress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: [VPC_CIDR[config.kind]] }]',
    );
    expect(group).toContain(
      'egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }]',
    );
  });

  it("rebases SST's public and private subnets onto the stage's VPC CIDR (requirement 11)", () => {
    expect(network).toContain("args.cidrBlock = rebaseSubnetCidr(args.cidrBlock, config.kind)");
    expect(network).toContain("publicSubnet: rebase");
    expect(network).toContain("privateSubnet: rebase");
  });

  it("gives the one NAT address to the stack output natAddress", () => {
    expect(network).toContain("natAddress: singleNat?.elasticIp.publicIp");
    expect(code("infra/app.ts")).toContain("natAddress: net.natAddress");
  });
});

describe("requirement 2: one week of logs on every staging log group", () => {
  it("logs.ts sets the retention of every sst.aws.Function on staging only", () => {
    const logs = code("infra/stacks/logs.ts");
    expect(logs).toContain("const retention = componentLogRetention(config.kind)");
    expect(logs).toContain("if (retention === undefined) return");
    expect(logs).toContain("$transform(sst.aws.Function,");
    expect(logs).toContain("{ ...(logging ?? {}), retention }");
  });

  it("app.ts registers it before the first stack", () => {
    const app = code("infra/app.ts");
    const at = app.indexOf("logRetention(config);");
    expect(at).toBeGreaterThan(0);
    for (const first of ["secrets();", "network(config);", "auth(config);", "workers({", "web({"]) {
      expect(app.indexOf(first), first).toBeGreaterThan(at);
    }
  });

  it("workers.ts sets the workers' retention by stage kind and size", () => {
    expect(code("infra/stacks/workers.ts")).toContain(
      "logging: { retention: workerLogRetention(inputs.config.kind, inputs.config.size) }",
    );
  });
});

describe("requirements 3 and 4: what the stacks do with the removal rules", () => {
  it("app.ts takes the removal policy and protection of production from infra/lib/stage.ts", () => {
    const app = code("infra/app.ts");
    expect(app).toContain("removal: removalPolicy(stage)");
    expect(app).toContain('protect: stageKind(stage) === "production"');
  });

  it("database.ts: protection, the final snapshot and the backup days come from the rules", () => {
    const database = code("infra/stacks/database.ts");
    expect(database).toContain("const rules = removalRules(config.kind)");
    expect(database).toContain("args.deletionProtection = rules.databaseDeletionProtection");
    expect(database).toContain("args.skipFinalSnapshot = !rules.databaseFinalSnapshot");
    expect(database).toContain(
      'if (rules.databaseFinalSnapshot) { args.finalSnapshotIdentifier = resourceName(stage, "database-final"); }',
    );
    expect(database).toContain(
      "args.backupRetentionPeriod = backupRetentionDays(config.kind, config.size)",
    );
  });

  it("storage.ts empties the buckets on staging only and leaves the other stages' buckets as SST builds them", () => {
    const storage = code("infra/stacks/storage.ts");
    expect(storage).toContain("const { forceEmptyBuckets } = removalRules(config.kind)");
    expect(storage).toContain("args.forceDestroy = true;");
    expect(storage).not.toMatch(/forceDestroy = false/);
  });

  it("auth.ts keeps and adopts the two user pools on staging, and names the trigger there", () => {
    const auth = code("infra/stacks/auth.ts");
    expect(auth).toContain("const { retainUserPools } = removalRules(config.kind)");
    expect(auth).toContain("if (!retainUserPools) return; opts.retainOnDelete = true;");
    expect(auth).toContain("if (poolId !== null) opts.import = poolId;");
    expect(auth).toContain("keepPool(opts, config.userPoolIds.customers)");
    expect(auth).toContain("keepPool(opts, config.userPoolIds.admins)");
    // WPU-X12 round 3: both trigger functions (messages and pre sign-up) are named on staging only, by
    // one builder: the kept pools store their ARNs.
    expect(auth).toContain("...(retainUserPools ? { name: resourceName(stage, part) } : {})");
    expect(auth).toContain('triggerArgs("cognito-messages", "handler", "cognito-messages")');
    expect(auth).toContain('triggerArgs("cognito-messages", "preSignUp", "cognito-presignup")');
    // Requirement 11 (verify review B1 auth.ts:53): the plural Pulumi field, in both pools.
    expect(
      auth.match(
        /args\.userAttributeUpdateSettings = \{ attributesRequireVerificationBeforeUpdates: \["email"\],? \}/g,
      ),
    ).toHaveLength(2);
  });
});

describe("requirements 5, 9 and 10: budget.ts", () => {
  const budget = code("infra/stacks/budget.ts");

  it("takes the limit and thresholds of the stage kind and names the removal command", () => {
    expect(budget).toContain("const plan = budgetOf(config.kind)");
    expect(budget).toContain("name: budgetName(stage)");
    expect(budget).toContain("limitAmount: String(plan.limitUsd)");
    expect(budget).toContain("plan.thresholdsUsd.map(");
  });

  it("filters on the app AND the stage tag", () => {
    expect(budget).toContain(
      "filterExpression: { ands: Object.entries(sstTags($app.name, stage)).map(",
    );
    expect(budget).toContain("tags: { key, values: [value] }");
  });

  it("the us-east-1 provider of the web ACLs carries the same tags", () => {
    expect(code("infra/stacks/waf.ts")).toContain(
      "defaultTags: { tags: sstTags($app.name, stage) }",
    );
  });

  // TC_BUDGET_ALARM=off (2026-11-14, an organization SCP denies budgets) is the only way to leave it out;
  // unset, it is on (infra/lib/lean.ts parseBudgetAlarm).
  it("app.ts still builds the budget on every lean stage, production included, unless switched off", () => {
    expect(code("infra/app.ts")).toContain(
      'if (config.size === "lean" && config.budgetAlarm) { budget(config, alarm.topic); }',
    );
  });
});

describe("requirement 11: the VERIFY fixes in the stacks", () => {
  it("alarms.ts takes every filtered log group from the function, never /aws/lambda/<name>", () => {
    const alarms = code("infra/stacks/alarms.ts");
    expect(alarms).not.toContain("/aws/lambda/");
    expect(alarms).toContain("return f.nodes.logGroup;");
    expect(alarms.match(/logGroupName: logGroupOf\(/g)).toHaveLength(3);
  });

  it("database.ts replaces SST's rds.force_ssl instead of appending a second one", () => {
    const database = code("infra/stacks/database.ts");
    expect(database).toContain("withForcedTls(existing ?? [])");
    expect(database).not.toMatch(/\.\.\.\(existing \?\? \[\]\), \{ name: "rds\.force_ssl"/);
  });

  it("workers.ts publishes a version of access-details for its alias", () => {
    const workers = code("infra/stacks/workers.ts");
    // WPU-Y3: and kyc-check, for its "web" alias.
    expect(workers).toMatch(
      /const PUBLISHED_VERSIONS: readonly string\[\] = \[ "reader", "access-details", "invoice-renderer", "kyc-check",? \]/,
    );
    expect(workers).not.toContain("an alias cannot point to $LATEST");
  });

  it("each fix cites the line of the verify review", () => {
    for (const file of [
      "infra/stacks/alarms.ts",
      "infra/stacks/network.ts",
      "infra/stacks/workers.ts",
      "infra/lib/database.ts",
      "infra/lib/network.ts",
    ]) {
      expect(text(file), file).toContain("verify-review-2026-11-13.md");
    }
  });
});

describe("requirements 4 and 7: the documents", () => {
  const runbook = text("docs/runbooks/staging-on-demand.md");

  it("the staging database proof states the staging rule and that production keeps its own", async () => {
    const { MANUAL_PROOFS } = await import("../../verify/manual-proofs.mjs");
    const proof = MANUAL_PROOFS["wp0-t3-staging-database"].description;
    expect(proof).toContain("1-day backup retention, no deletion protection and no final snapshot");
    expect(proof).toContain(
      "production keeps 14-day (7 lean) retention, deletion protection and its final snapshot",
    );
    expect(proof).not.toMatch(
      /14-day backup retention and deletion protection show on the instance/,
    );
  });

  it("the runbook covers start, end, what is wiped and kept, the next-day check, the daily cost and the rule", () => {
    for (const part of [
      "## Start a session",
      "## What to test",
      "## End the session",
      "## What is wiped and what persists",
      "## Next day: check that nothing billable remains",
      '"deploy-staging"',
      '"remove-staging"',
      "`npx sst remove --stage staging`",
      "Cost Explorer",
      "2.7 USD a day",
      "never leave staging up overnight unless a test needs it",
      "cost allocation tag in the Billing console of the PAYER account",
      "the filter counts nothing",
      "Both Cognito user pools",
      "The SST secrets",
    ]) {
      expect(runbook, part).toContain(part);
    }
    expect(text("docs/runbooks/README.md")).toContain("(staging-on-demand.md)");
  });

  it("the lean runbook says what SST really builds and what the stage builds instead", () => {
    const lean = text("docs/runbooks/single-account-lean.md");
    expect(lean).toContain("in EACH Availability Zone, so two of each");
    expect(lean).toContain("builds ONE fck-nat t4g.nano");
    expect(lean).not.toMatch(/VERIFY after the first deploy that SST makes one NAT instance/);
  });
});
