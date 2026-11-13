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
const STAGE_OF = { production: "production", staging: "staging", personal: "track-b" };

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
    expect(sstTags("ticon-cloud", "staging")).toEqual({
      "sst:app": "ticon-cloud",
      "sst:stage": "staging",
    });
    expect(Object.isFrozen(sstTags("ticon-cloud", "production"))).toBe(true);
  });
});
