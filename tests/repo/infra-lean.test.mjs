// WPU-B8: the lean stage size (one AWS account, about 50 USD a month). The pure table is run;
// the stack files (not type-checked, SST is not installed) are proven by reading their text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEAN_BUDGET_USD,
  LEAN_BUDGET_THRESHOLDS_USD,
  STAGE_SIZES,
  logRetentionOf,
  parseStageSize,
  sizing,
} from "../../infra/lib/lean.ts";
import { InfraConfigError, readStageConfig } from "../../infra/lib/stage.ts";

const root = resolve(import.meta.dirname, "../..");
const raw = (file) => readFileSync(resolve(root, file), "utf8");
function source(file) {
  return raw(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ")
    .replace(/,\s*([\]})])/g, "$1");
}

const env = {
  TC_ALARM_EMAILS: "oncall@example.com",
  TC_SES_IDENTITY_ARN: "arn:aws:ses:ap-southeast-1:111111111111:identity/example.com",
  TC_SES_FROM_ADDRESS: "no-reply@example.com",
  TC_ACCOUNT_ID: "111111111111",
  TC_POOL_ACCOUNT_IDS: "111111111111",
  TC_DNS_ACCOUNT_ID: "111111111111",
  TC_DNS_EXTERNAL_ID: "external-id-value",
  TC_DOMAIN_WEB: "tryaws.now",
  TC_DOMAIN_ADMIN: "admin.tryaws.now",
  TC_ADMIN_ALLOWLIST: "203.0.113.0/24",
  TC_PROBE_SOURCES: "198.51.100.10/32",
  TC_VPC_CIDR: "172.26.0.0/16",
};

describe("WPU-B8: parseStageSize (fail closed)", () => {
  it("lists the two sizes", () => {
    expect([...STAGE_SIZES]).toEqual(["lean", "full"]);
  });

  it("maps unset and empty to full", () => {
    expect(parseStageSize(undefined)).toBe("full");
    expect(parseStageSize("")).toBe("full");
  });

  it("accepts the two words", () => {
    expect(parseStageSize("lean")).toBe("lean");
    expect(parseStageSize("full")).toBe("full");
  });

  it("refuses anything else, including spaces and other cases", () => {
    for (const bad of ["Lean", "FULL", " lean", "lean ", "small", "0", "true", "  "]) {
      expect(() => parseStageSize(bad), bad).toThrow(InfraConfigError);
    }
  });
});

describe("WPU-B8: the sizing table", () => {
  it("lean: t4g.micro, single AZ, 7 days of backups, whatever the stage kind", () => {
    for (const kind of ["production", "staging", "personal"]) {
      const { database } = sizing("lean", kind);
      expect(database).toEqual({
        instance: "t4g.micro",
        multiAz: false,
        storage: "20 GB",
        backupRetentionDays: 7,
      });
    }
  });

  it("full is exactly today's values: production t4g.medium Multi-AZ, others t4g.micro, 14 days", () => {
    expect(sizing("full", "production").database).toEqual({
      instance: "t4g.medium",
      multiAz: true,
      storage: "20 GB",
      backupRetentionDays: 14,
    });
    for (const kind of ["staging", "personal"]) {
      expect(sizing("full", kind).database).toEqual({
        instance: "t4g.micro",
        multiAz: false,
        storage: "20 GB",
        backupRetentionDays: 14,
      });
    }
  });

  it("network: one NAT instance in lean, managed gateways in full", () => {
    expect(sizing("lean", "staging").network.nat).toBe("ec2");
    expect(sizing("full", "staging").network.nat).toBe("managed");
    expect(sizing("full", "production").network.nat).toBe("managed");
  });

  it("WAF: lean keeps the Common group only, full keeps the three groups unchanged", () => {
    expect(sizing("lean", "staging").waf.managedGroups).toEqual([
      { name: "AWSManagedRulesCommonRuleSet", priority: 10 },
    ]);
    expect(sizing("full", "staging").waf.managedGroups).toEqual([
      { name: "AWSManagedRulesCommonRuleSet", priority: 10 },
      { name: "AWSManagedRulesKnownBadInputsRuleSet", priority: 20 },
      { name: "AWSManagedRulesAmazonIpReputationList", priority: 30 },
    ]);
  });

  it("Lambda log retention: 7 days lean, 14 days full, as SST strings", () => {
    expect(sizing("lean", "staging").logRetentionDays).toBe(7);
    expect(sizing("full", "staging").logRetentionDays).toBe(14);
    expect(logRetentionOf("lean")).toBe("1 week");
    expect(logRetentionOf("full")).toBe("2 weeks");
  });

  it("budget: 50 USD, notifications at 40 and 50 USD absolute", () => {
    expect(LEAN_BUDGET_USD).toBe(50);
    expect([...LEAN_BUDGET_THRESHOLDS_USD]).toEqual([40, 50]);
  });

  it("is frozen (a stack cannot change the table)", () => {
    expect(Object.isFrozen(sizing("lean", "staging"))).toBe(true);
    expect(Object.isFrozen(sizing("full", "production").database)).toBe(true);
  });
});

describe("WPU-B8: readStageConfig reads TC_STAGE_SIZE", () => {
  it("defaults to full", () => {
    expect(readStageConfig("staging", env).size).toBe("full");
    expect(readStageConfig("staging", { ...env, TC_STAGE_SIZE: "" }).size).toBe("full");
  });

  it("reads lean and refuses an unknown value", () => {
    expect(readStageConfig("staging", { ...env, TC_STAGE_SIZE: "lean" }).size).toBe("lean");
    expect(() => readStageConfig("staging", { ...env, TC_STAGE_SIZE: "tiny" })).toThrow(
      /TC_STAGE_SIZE/,
    );
  });
});

describe("WPU-B8: the stacks read config.size", () => {
  const network = source("infra/stacks/network.ts");
  const database = source("infra/stacks/database.ts");
  const waf = source("infra/stacks/waf.ts");
  const workers = source("infra/stacks/workers.ts");
  const sstConfig = source("infra/sst.config.ts");

  it("network.ts takes nat from the table, keeps two AZs", () => {
    expect(network).toContain("az: AZ_COUNT");
    expect(network).toContain("nat: sizing(config.size, config.kind).network.nat");
    expect(network).not.toMatch(/nat: "(managed|ec2)"/);
  });

  it("database.ts takes instance, multiAz, storage and backups from the table", () => {
    expect(database).toContain("const size = sizing(config.size, config.kind).database");
    expect(database).toContain("instance: size.instance");
    expect(database).toContain("multiAz: size.multiAz");
    expect(database).toContain("storage: size.storage");
    expect(database).toContain("args.backupRetentionPeriod = size.backupRetentionDays");
  });

  it("database.ts keeps the proxy, TLS, KMS, deletion protection and final snapshot in both sizes (R2, R13)", () => {
    for (const part of [
      "args.requireTls = true",
      "args.deletionProtection = true",
      "args.skipFinalSnapshot = false",
      "args.storageEncrypted = true",
      "args.kmsKeyId = key.arn",
      "args.publiclyAccessible = false",
      "proxy: {",
    ]) {
      expect(database).toContain(part);
    }
    expect(database).not.toMatch(/config\.size\s*[=!]==?\s*"lean"/);
  });

  it("waf.ts builds the managed groups from the table, in both web ACLs, and keeps the rate rules and the allowlist", () => {
    expect(waf).toContain("sizing(config.size, config.kind).waf.managedGroups");
    expect(waf.match(/\.\.\.managed\.map\(/g)).toHaveLength(2);
    expect(waf).not.toMatch(/managedGroup\("AWSManaged/);
    expect(waf).toContain("...rateRules(40)");
    expect(waf).toContain("parseAllowlist(config.adminAllowlist)");
    expect(waf).toContain('name: "block-outside-allowlist"');
    for (const rule of ["login", "signup", "otp-verify", "topup", "eps-return"]) {
      expect(waf).toContain(rule);
    }
  });

  it("workers.ts sets the log retention of every function from the size", () => {
    expect(workers).toContain("logging: { retention: logRetentionOf(inputs.config.size) }");
  });

  it("budget.ts: MONTHLY, USD, limit 50, two ACTUAL notifications at 40 and 50 to the alarm topic", () => {
    const budget = source("infra/stacks/budget.ts");
    expect(budget).toContain("new aws.budgets.Budget(");
    expect(budget).toContain('timeUnit: "MONTHLY"');
    expect(budget).toContain('limitUnit: "USD"');
    expect(budget).toContain("limitAmount: String(LEAN_BUDGET_USD)");
    expect(budget).toContain("LEAN_BUDGET_THRESHOLDS_USD.map(");
    expect(budget).toContain('notificationType: "ACTUAL"');
    expect(budget).toContain('thresholdType: "ABSOLUTE_VALUE"');
    expect(budget).toContain("subscriberSnsTopicArns: [topic.arn]");
    expect(budget).toContain("budgets.amazonaws.com");
    expect(raw("infra/stacks/budget.ts")).toContain("VERIFY:");
  });

  it("sst.config.ts calls budget only for lean, after the alarm topic exists", () => {
    expect(sstConfig).toContain('await import("./stacks/budget")');
    expect(sstConfig).toMatch(
      /const alarm = alarms\([^)]*\);[\s\S]*if \(config\.size === "lean"\) \{ budget\(config, alarm\.topic\); \}/,
    );
  });

  it("names every unconfirmed detail with VERIFY", () => {
    for (const file of [
      "infra/stacks/network.ts",
      "infra/stacks/budget.ts",
      "infra/stacks/workers.ts",
    ]) {
      expect(raw(file)).toContain("VERIFY");
    }
    expect(raw("infra/stacks/network.ts")).toMatch(/VERIFY[^\n]*nat: "ec2"/);
    expect(raw("infra/stacks/budget.ts")).toMatch(/VERIFY[^\n]*aws\.budgets/);
  });
});

describe("WPU-B8: the new files hold no account id and no secret", () => {
  const files = ["infra/lib/lean.ts", "infra/stacks/budget.ts"];

  it("has no 12-digit account id", () => {
    for (const file of files) {
      expect(raw(file), file).not.toMatch(/(?<![0-9])[0-9]{12}(?![0-9])/);
    }
  });

  it("has no secret-looking text", () => {
    for (const file of files) {
      const text = raw(file);
      expect(text, file).not.toMatch(/AKIA[0-9A-Z]{12,}/);
      expect(text, file).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, file).not.toMatch(/(secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/i);
      expect(text, file).not.toMatch(/arn:aws:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}/);
    }
  });
});
