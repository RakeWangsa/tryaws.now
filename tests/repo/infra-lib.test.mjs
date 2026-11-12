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
    expect(missing.sort()).toEqual(["cognito-messages", "notifier"]);
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
