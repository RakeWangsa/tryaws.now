// WP0-T2, WP0-T3, WP0-T4: the pure parts of the SST app (infra/lib). Real TypeScript, run here.
// The 12-digit numbers below are made up for the test (111111111111 and the like); no real account
// id is written anywhere in the repository.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllowlist } from "../../infra/lib/allowlist.ts";
import {
  FUNCTIONS,
  DB_PASSWORD_SECRET,
  PROXY_ROLES,
  POOL_ROLE_FUNCTIONS,
  provisionerNetworkEnvironment,
  WEB_SECRETS,
} from "../../infra/lib/functions.ts";
import {
  AVAILABILITY_ZONES,
  AZ_COUNT,
  VPC_CIDR,
  cidrContains,
  cidrsOverlap,
  isolatedSubnets,
} from "../../infra/lib/network.ts";
import {
  PRODUCTION_CI_VARIABLE,
  assertDeployAllowed,
  assertNoFakeSwitches,
  assumableRoleArns,
  parseProbeSourcesConfig,
  parseVpcCidrConfig,
  readStageConfig,
  removalPolicy,
  resourceName,
  roleName,
  stageKind,
  tcStage,
} from "../../infra/lib/stage.ts";

const root = resolve(import.meta.dirname, "../..");

const env = {
  TC_ALARM_EMAILS: "oncall@example.com, second@example.com",
  TC_SES_IDENTITY_ARN: "arn:aws:ses:ap-southeast-1:111111111111:identity/example.com",
  TC_SES_FROM_ADDRESS: "no-reply@example.com",
  TC_ACCOUNT_ID: "111111111111",
  TC_POOL_ACCOUNT_IDS: "222222222222,333333333333",
  TC_DNS_ACCOUNT_ID: "444444444444",
  TC_DNS_EXTERNAL_ID: "external-id-value",
  TC_DOMAIN_WEB: "app.example.com",
  TC_DOMAIN_ADMIN: "ops.example.com",
  TC_ADMIN_ALLOWLIST: "203.0.113.0/24",
  TC_PROBE_SOURCES: "198.51.100.10/32, 198.51.100.11/32",
  TC_VPC_CIDR: "172.26.0.0/16",
};

describe("stage", () => {
  it("classifies the stage names", () => {
    expect(stageKind("production")).toBe("production");
    expect(stageKind("staging")).toBe("staging");
    expect(stageKind("track-b")).toBe("personal");
    expect(tcStage("production")).toBe("production");
    expect(tcStage("staging")).toBe("staging");
    expect(tcStage("track-b")).toBe("staging");
  });

  it("refuses bad names and names that look like production", () => {
    for (const bad of [
      "",
      "A",
      "ab",
      "Staging",
      "-x-",
      "a_b_c",
      "prod",
      "production2",
      "x".repeat(30),
    ]) {
      expect(() => stageKind(bad), bad).toThrow();
    }
  });

  it("refuses the production stage unless CI set the variable and CI=true", () => {
    expect(() => assertDeployAllowed("production", {})).toThrow(/production/);
    expect(() =>
      assertDeployAllowed("production", { [PRODUCTION_CI_VARIABLE]: "ci-approved" }),
    ).toThrow();
    expect(() =>
      assertDeployAllowed("production", { CI: "true", [PRODUCTION_CI_VARIABLE]: "yes" }),
    ).toThrow();
    expect(() =>
      assertDeployAllowed("production", { CI: "true", [PRODUCTION_CI_VARIABLE]: "ci-approved" }),
    ).not.toThrow();
    expect(() => assertDeployAllowed("staging", {})).not.toThrow();
  });

  it("refuses the fake switches in every stage, production included", () => {
    for (const name of ["TC_EPS", "TC_IDP", "TC_SMS"]) {
      expect(() => assertNoFakeSwitches({ [name]: "fake" })).toThrow(name);
      expect(() => assertDeployAllowed("staging", { [name]: "fake" })).toThrow(name);
      expect(() => assertDeployAllowed("staging", { [name]: "anything" })).toThrow(name);
    }
    expect(() => assertNoFakeSwitches({ TC_EPS: "" })).not.toThrow();
  });

  it("builds names that fit the AWS limits and rejects odd parts", () => {
    expect(resourceName("staging", "app-sg")).toBe("tc-staging-app-sg");
    expect(roleName("production", "web")).toBe("tc-production-web-role");
    expect(() => resourceName("staging", "Bad")).toThrow();
    expect(() => resourceName("staging", "x".repeat(42))).toThrow();
    expect(() => resourceName("a".repeat(21), "x".repeat(40))).toThrow(/64/);
  });

  it("reads the configuration from the environment and fails closed", () => {
    const config = readStageConfig("staging", env);
    expect(config.tcStage).toBe("staging");
    expect(config.alarmEmails).toEqual(["oncall@example.com", "second@example.com"]);
    expect(config.poolAccountIds).toHaveLength(2);
    for (const name of Object.keys(env)) {
      const partial = { ...env };
      delete partial[name];
      expect(() => readStageConfig("staging", partial), name).toThrow(name);
    }
    expect(() => readStageConfig("staging", { ...env, TC_DOMAIN_WEB: "not a host" })).toThrow();
    expect(() => readStageConfig("staging", { ...env, TC_ACCOUNT_ID: "12345" })).toThrow();
    expect(() => readStageConfig("staging", { ...env, TC_SES_IDENTITY_ARN: "x" })).toThrow();
    expect(() => readStageConfig("staging", { ...env, TC_EPS: "fake" })).toThrow();
    expect(() => readStageConfig("production", env)).toThrow(/production/);
  });

  it("retains data stores outside personal stages", () => {
    expect(removalPolicy("production")).toBe("retain");
    expect(removalPolicy("staging")).toBe("retain");
    expect(removalPolicy("track-b")).toBe("remove");
  });

  it("builds the assumable role ARNs from the environment only", () => {
    const config = readStageConfig("staging", env);
    expect(assumableRoleArns("TcProvisioner", config)).toEqual([
      "arn:aws:iam::222222222222:role/TcProvisioner",
      "arn:aws:iam::333333333333:role/TcProvisioner",
    ]);
    expect(assumableRoleArns("TcDnsReader", config)).toEqual([
      "arn:aws:iam::444444444444:role/TcDnsReader",
    ]);
    expect(assumableRoleArns("TcBillingReader", config)).toHaveLength(3);
    expect(() => assumableRoleArns("AdministratorAccess", config)).toThrow();
  });
});

// C.5: TC_PROBE_SOURCES and TC_VPC_CIDR are required stack configuration on the shared stages.
describe("probe sources and VPC CIDR of the provisioner", () => {
  it("are read into the stage configuration and into the provisioner environment only", () => {
    const config = readStageConfig("staging", env);
    expect(config.probeSources).toEqual(["198.51.100.10/32", "198.51.100.11/32"]);
    expect(config.vpcCidr).toBe("172.26.0.0/16");
    expect(provisionerNetworkEnvironment(config)).toEqual({
      TC_PROBE_SOURCES: "198.51.100.10/32,198.51.100.11/32",
      TC_VPC_CIDR: "172.26.0.0/16",
    });
    expect(provisionerNetworkEnvironment({ probeSources: [], vpcCidr: null })).toEqual({});
  });

  it("fail the synth with a message that names the variable when missing on staging and production", () => {
    for (const name of ["TC_PROBE_SOURCES", "TC_VPC_CIDR"]) {
      const partial = { ...env };
      delete partial[name];
      expect(() => readStageConfig("staging", partial), name).toThrow(
        new RegExp(`${name} is required`),
      );
      expect(() => readStageConfig("staging", { ...env, [name]: "  " }), name).toThrow(name);
      const production = {
        ...partial,
        CI: "true",
        TC_PRODUCTION_DEPLOY: "ci-approved",
      };
      expect(() => readStageConfig("production", production), name).toThrow(name);
    }
  });

  it("are optional on a personal stage, which then opens nothing, but are validated when set", () => {
    const partial = { ...env };
    delete partial["TC_PROBE_SOURCES"];
    delete partial["TC_VPC_CIDR"];
    const config = readStageConfig("track-b", partial);
    expect(config.probeSources).toEqual([]);
    expect(config.vpcCidr).toBeNull();
    expect(provisionerNetworkEnvironment(config)).toEqual({});
    expect(() => readStageConfig("track-b", { ...partial, TC_PROBE_SOURCES: "0.0.0.0/0" })).toThrow(
      /TC_PROBE_SOURCES/,
    );
  });

  it("refuse anything but at most ten public /16 or narrower IPv4 CIDRs (no 0.0.0.0/0)", () => {
    for (const bad of [
      "0.0.0.0/0",
      "198.51.100.0/15",
      "198.51.100.10",
      "198.51.100.10/33",
      "300.1.1.1/32",
      "10.0.0.1/32",
      "172.16.0.1/32",
      "192.168.1.1/32",
      "100.64.0.1/32",
      "127.0.0.1/32",
      "169.254.1.1/32",
      "224.0.0.1/32",
      "198.51.100.10/32,",
      "not-a-cidr",
      Array.from({ length: 11 }, (_, i) => `198.51.100.${i + 1}/32`).join(","),
    ]) {
      expect(() => parseProbeSourcesConfig(bad), bad).toThrow(/TC_PROBE_SOURCES/);
    }
    expect(parseProbeSourcesConfig("198.51.100.0/16")).toEqual(["198.51.100.0/16"]);
    expect(
      parseProbeSourcesConfig(
        Array.from({ length: 10 }, (_, i) => `198.51.100.${i + 1}/32`).join(","),
      ),
    ).toHaveLength(10);
  });

  it("accept exactly what the runtime parser of packages/aws accepts (same rules, same answers)", async () => {
    const { parseProbeSources } = await import("../../packages/aws/adapters/bootstrap-probe.ts");
    const samples = [
      "198.51.100.10/32",
      "198.51.100.10/32, 203.0.113.9/32",
      "198.51.100.0/16",
      "198.51.100.0/15",
      "0.0.0.0/0",
      "10.1.2.3/32",
      "172.31.0.1/32",
      "172.32.0.1/32",
      "100.63.0.1/32",
      "100.64.0.1/32",
      "192.0.2.1/32",
      "224.0.0.1/32",
      "1.2.3.4/33",
      "1.2.3/32",
      "256.1.1.1/32",
      "1.1.1.1/32,",
      Array.from({ length: 11 }, (_, i) => `198.51.100.${i + 1}/32`).join(","),
    ];
    for (const sample of samples) {
      const runtime = parseProbeSources(sample);
      let config = null;
      try {
        config = parseProbeSourcesConfig(sample);
      } catch {
        config = null;
      }
      expect(config === null, sample).toBe(runtime === null);
      if (runtime !== null) expect(config, sample).toEqual(runtime);
    }
  });

  it("accepts a private /16 to /28 network as TC_VPC_CIDR and nothing else", () => {
    expect(parseVpcCidrConfig("172.26.0.0/16")).toBe("172.26.0.0/16");
    expect(parseVpcCidrConfig(" 10.0.0.0/24 ")).toBe("10.0.0.0/24");
    for (const bad of [
      "0.0.0.0/0",
      "198.51.100.0/24",
      "10.0.0.0/8",
      "10.0.0.0/29",
      "10.0.0.1",
      "999.0.0.0/16",
      "",
    ]) {
      expect(() => parseVpcCidrConfig(bad), bad).toThrow(/TC_VPC_CIDR/);
    }
  });

  it("is wired into the provisioner only, by the function table helper (text of workers.ts)", () => {
    const workers = readFileSync(resolve(root, "infra/stacks/workers.ts"), "utf8");
    expect(workers).toContain("provisionerNetworkEnvironment(config)");
    expect(workers).toMatch(/spec\.dir === "provisioner"[^]*provisionerNetworkEnvironment/);
  });
});

// C.2: the outputs that scripts/post-deploy-check.mjs reads.
describe("stack outputs featureFlagDefaults and webRolePolicies", () => {
  it("lists the twelve flags of @tc/db, all false, in infra and in the check script", async () => {
    const { FEATURE_FLAG_KEYS_OF_INFRA, featureFlagDefaults } =
      await import("../../infra/lib/functions.ts");
    const { FEATURE_FLAG_KEYS } = await import("../../scripts/post-deploy-check.mjs");
    const source = readFileSync(
      resolve(root, "packages/db/repositories/config/feature-flags.ts"),
      "utf8",
    );
    const keys = [
      ...source.slice(source.indexOf("FEATURE_FLAG_KEYS = [")).matchAll(/"([a-z_]+)",/g),
    ]
      .map((m) => m[1])
      .slice(0, 12);
    expect(keys).toHaveLength(12);
    expect([...FEATURE_FLAG_KEYS_OF_INFRA]).toEqual(keys);
    expect(FEATURE_FLAG_KEYS).toEqual(keys);
    expect(Object.values(featureFlagDefaults()).every((v) => v === false)).toBe(true);
    expect(Object.keys(featureFlagDefaults())).toEqual(keys);
  });

  it("are returned by the SST app, from the permission lists the web and admin functions receive", () => {
    const config = readFileSync(resolve(root, "infra/sst.config.ts"), "utf8");
    expect(config).toContain("featureFlagDefaults: featureFlagDefaults(),");
    expect(config).toContain("webRolePolicies: apps.webRolePolicies,");
    const web = readFileSync(resolve(root, "infra/stacks/web.ts"), "utf8");
    expect(web.match(/permissions: record\(\[/g)).toHaveLength(2);
    expect(web).toContain("webRolePolicies,");
    expect(web).toContain("$jsonStringify");
  });
});

// C.13: the ledger check at 02:00 Asia/Dhaka and its alarms.
describe("ledger check schedule and alarms", () => {
  it("runs every day at 20:00 UTC, which is 02:00 in Dhaka (UTC+6, no daylight saving)", async () => {
    const { LEDGER_CHECK_SCHEDULE, LEDGER_CHECK_FUNCTION } =
      await import("../../infra/lib/functions.ts");
    expect(LEDGER_CHECK_SCHEDULE).toBe("cron(0 20 * * ? *)");
    const [minute, hour] = LEDGER_CHECK_SCHEDULE.slice(5, -1).split(" ");
    expect(((Number(hour) + 6) % 24) * 60 + Number(minute)).toBe(2 * 60);
    expect(LEDGER_CHECK_FUNCTION.dir).toBe("reconciler");
    expect(LEDGER_CHECK_FUNCTION.handlerExport).toBe("ledgerCheckHandler");
    expect(LEDGER_CHECK_FUNCTION.poolRoles).toEqual([]);
    expect(LEDGER_CHECK_FUNCTION.name).toBe("ledger-check");
    // the reconciler itself stays hourly
    expect(FUNCTIONS.find((f) => f.dir === "reconciler").trigger.schedule).toBe("rate(1 hour)");
    expect(FUNCTIONS.map((f) => f.dir)).not.toContain("ledger-check");
  });

  it("exports the handler the schedule names and logs the three messages the alarms match", () => {
    const index = readFileSync(resolve(root, "functions/reconciler/index.ts"), "utf8");
    expect(index).toContain("ledgerCheckHandler");
    const source = readFileSync(resolve(root, "functions/reconciler/ledger-check.ts"), "utf8");
    for (const msg of ["ledger_mismatch", "ledger_check_failed", "ledger_check_ok"]) {
      expect(source, msg).toContain(`"${msg}"`);
    }
  });

  it("wires a second cron with its own role name and the two alarms to the alarm topic", () => {
    const workers = readFileSync(resolve(root, "infra/stacks/workers.ts"), "utf8");
    expect(workers).toContain('crons["ledger-check"] = new sst.aws.CronV2(');
    expect(workers).toContain("schedule: LEDGER_CHECK_SCHEDULE");
    expect(workers).toContain("roleName(inputs.config.stage, spec.name ?? spec.dir)");
    const alarms = readFileSync(resolve(root, "infra/stacks/alarms.ts"), "utf8");
    expect(alarms).toContain('resourceName(stage, "ledger-mismatch")');
    expect(alarms).toContain('resourceName(stage, "ledger-check-silent")');
    expect(alarms.match(/alarmActions: \[topic\.arn\]/g)).toHaveLength(4);
    expect(alarms).toContain("LEDGER_LOG_MESSAGES.mismatch");
    expect(alarms).toContain("LEDGER_LOG_MESSAGES.failed");
    expect(alarms).toContain('treatMissingData: "breaching"');
    expect(alarms).toContain("aws.cloudwatch.LogMetricFilter");
  });
});

describe("admin allowlist", () => {
  it("parses and normalises IPv4 and IPv6 entries", () => {
    expect(parseAllowlist("203.0.113.7, 198.51.100.0/24,203.0.113.7")).toEqual({
      ipv4: ["198.51.100.0/24", "203.0.113.7/32"],
      ipv6: [],
    });
    expect(parseAllowlist("2001:DB8::/48").ipv6).toEqual(["2001:db8::/48"]);
  });

  it("fails closed", () => {
    for (const bad of [
      "",
      " , ",
      "0.0.0.0/0",
      "10.0.0.0/8",
      "::/0",
      "2001:db8::/16",
      "300.1.1.1",
      "1.2.3.4/33",
      "1.2.3",
      "example.com",
      "1.2.3.4/x",
      "2001:db8::/129",
      "1.2.3.4/",
    ]) {
      expect(() => parseAllowlist(bad), bad).toThrow();
    }
  });
});

describe("network table", () => {
  it("has two AZs of the control plane region", () => {
    expect(AZ_COUNT).toBe(2);
    expect(AVAILABILITY_ZONES).toEqual(["ap-southeast-1a", "ap-southeast-1b"]);
  });

  it("gives each stage kind its own /16 and no overlap", () => {
    const cidrs = Object.values(VPC_CIDR);
    for (const a of cidrs) {
      expect(a).toMatch(/\.0\.0\/16$/);
      for (const b of cidrs) if (a !== b) expect(cidrsOverlap(a, b)).toBe(false);
    }
  });

  it("puts the isolated subnets inside the VPC range, apart from each other, in the high octets", () => {
    for (const kind of Object.keys(VPC_CIDR)) {
      const plans = isolatedSubnets(kind);
      expect(plans.map((p) => p.az)).toEqual([...AVAILABILITY_ZONES]);
      for (const plan of plans) {
        expect(cidrContains(VPC_CIDR[kind], plan.cidr)).toBe(true);
        expect(plan.cidr).toMatch(/\.(200|201)\.0\/24$/);
      }
      expect(cidrsOverlap(plans[0].cidr, plans[1].cidr)).toBe(false);
    }
  });
});

describe("function table", () => {
  const dirs = readdirSync(resolve(root, "functions"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  it("covers exactly the folders of functions/", () => {
    expect(FUNCTIONS.map((f) => f.dir).sort()).toEqual(dirs);
    expect(new Set(FUNCTIONS.map((f) => f.component)).size).toBe(FUNCTIONS.length);
  });

  it("names a handler export that exists, except where the hand-off says it does not", () => {
    const missing = [];
    for (const spec of FUNCTIONS) {
      const index = resolve(root, "functions", spec.dir, "index.ts");
      expect(existsSync(index), spec.dir).toBe(true);
      const text = readFileSync(index, "utf8");
      const exported = new RegExp(
        `export (const|function|async function) ${spec.handlerExport}\\b|export \\{[^}]*\\b${spec.handlerExport}\\b`,
      ).test(text);
      expect(exported, `${spec.dir} ${spec.handlerExport}`).toBe(spec.exportExists);
      if (!spec.exportExists) missing.push(spec.dir);
    }
    expect(missing.sort()).toEqual([]);
  });

  it("lets only provisioner, reader, access-details, catalog-sync and reconciler assume pool roles (3.2, R1)", () => {
    expect([...POOL_ROLE_FUNCTIONS].sort()).toEqual([
      "access-details",
      "catalog-sync",
      "provisioner",
      "reader",
      "reconciler",
    ]);
    const roles = Object.fromEntries(FUNCTIONS.map((f) => [f.dir, [...f.poolRoles].sort()]));
    expect(roles["provisioner"]).toEqual(["TcDnsProvisioner", "TcProvisioner"]);
    expect(roles["reader"]).toEqual(["TcDnsReader", "TcReader"]);
    expect(roles["access-details"]).toEqual(["TcAccessDetails"]);
    expect(roles["catalog-sync"]).toEqual(["TcDnsReader", "TcReader"]);
    expect(roles["reconciler"]).toEqual(["TcBillingReader", "TcDnsReader", "TcReader"]);
    for (const dir of [
      "scheduler",
      "payments-sweeper",
      "notifier",
      "migrator",
      "invoice-renderer",
      "cognito-messages",
    ]) {
      expect(roles[dir], dir).toEqual([]);
    }
  });

  it("links secrets only where they are used", () => {
    const bySecret = new Map();
    for (const f of FUNCTIONS)
      for (const s of f.secrets) bySecret.set(s, [...(bySecret.get(s) ?? []), f.dir]);
    expect(bySecret.get("SmsApiKey")).toEqual(["notifier"]);
    for (const name of [
      "EpsMerchantId",
      "EpsStoreId",
      "EpsUsername",
      "EpsPassword",
      "EpsHashKey",
    ]) {
      expect(bySecret.get(name)).toEqual(["payments-sweeper"]);
    }
    // the four web-only keys are linked to no function
    for (const name of ["EpsLimitKey", "OrderDraftSecret", "AuthLimitKey", "OtpHashKey"]) {
      expect(bySecret.has(name), name).toBe(false);
    }
  });

  it("matches SecretName of apps/web/server/secrets.ts", () => {
    const text = readFileSync(resolve(root, "apps/web/server/secrets.ts"), "utf8");
    const block = /export type SecretName =([^;]+);/.exec(text)?.[1] ?? "";
    const names = [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect([...WEB_SECRETS].sort()).toEqual(names.sort());
  });

  it("gives only the migrator the master user and every other database function worker_rw", () => {
    for (const f of FUNCTIONS) {
      if (f.dir === "migrator") expect(f.dbRole).toBe("migrator");
      else if (["invoice-renderer", "cognito-messages"].includes(f.dir))
        expect(f.dbRole).toBe("none");
      else expect(f.dbRole, f.dir).toBe("worker_rw");
    }
    // 3.2: invoice-renderer and cognito-messages read no database
  });

  it("lists the four proxy roles of 3.3 and five password secrets", () => {
    expect([...PROXY_ROLES]).toEqual(["web_rw", "admin_rw", "worker_rw", "report_ro"]);
    expect(Object.keys(DB_PASSWORD_SECRET).sort()).toEqual([
      "admin_rw",
      "migrator",
      "report_ro",
      "web_rw",
      "worker_rw",
    ]);
  });

  it("matches the provisioning queue timing of @tc/core", async () => {
    const { PROVISIONING_QUEUE } = await import("../../packages/core/operations/queue-config.ts");
    const provisioner = FUNCTIONS.find((f) => f.dir === "provisioner");
    expect(provisioner.timeoutSeconds).toBe(PROVISIONING_QUEUE.functionTimeoutSeconds);
    expect(PROVISIONING_QUEUE.visibilityTimeoutSeconds).toBe(6 * provisioner.timeoutSeconds);
  });
});
