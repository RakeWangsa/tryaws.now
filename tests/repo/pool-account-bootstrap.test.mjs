// WPU-X4: the pool account bootstrap through the migrator. Static proof of the wiring of the optional
// stage value TC_POOL_EXTERNAL_ID (read by readStageConfig, handed to the migrator only, passed by every
// deploy job that runs sst) and of the runbooks. The behaviour of the decision is in
// functions/migrator/run.test.ts and packages/db/test/seed-pool-migrator.test.ts, the SQL in
// packages/db/test/seed-pool.test.ts. The 12-digit numbers are made up.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readStageConfig } from "../../infra/lib/stage.ts";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");
// The text without comment lines, so a comment cannot satisfy or break a rule.
const code = (path) =>
  read(path)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
    .join("\n");

const env = {
  TC_ALARM_EMAILS: "oncall@example.com",
  TC_SES_IDENTITY_ARN: "arn:aws:ses:ap-southeast-1:111111111111:identity/example.com",
  TC_SES_FROM_ADDRESS: "no-reply@example.com",
  TC_ACCOUNT_ID: "111111111111",
  TC_POOL_ACCOUNT_IDS: "222222222222",
  TC_DNS_ACCOUNT_ID: "444444444444",
  TC_DNS_EXTERNAL_ID: "external-id-value",
  TC_DOMAIN_WEB: "tryaws.now",
  TC_DOMAIN_ADMIN: "admin.tryaws.now",
  TC_ADMIN_ALLOWLIST: "203.0.113.0/24",
  TC_PROBE_SOURCES: "198.51.100.10/32",
  TC_VPC_CIDR: "172.26.0.0/16",
};

describe("readStageConfig: TC_POOL_EXTERNAL_ID", () => {
  it("is optional: null when unset or blank, never a failure of the deploy", () => {
    expect(readStageConfig("staging", env).poolExternalId).toBeNull();
    expect(readStageConfig("staging", { ...env, TC_POOL_EXTERNAL_ID: "  " }).poolExternalId).toBe(
      null,
    );
  });

  it("is read trimmed, as a plain value", () => {
    const config = readStageConfig("staging", {
      ...env,
      TC_POOL_EXTERNAL_ID: " tc-pool-ext-placeholder-0001 ",
    });
    expect(config.poolExternalId).toBe("tc-pool-ext-placeholder-0001");
  });
});

describe("infra/stacks/workers.ts", () => {
  const workers = code("infra/stacks/workers.ts");

  it("hands TC_POOL_EXTERNAL_ID and the pool id list to the migrator only", () => {
    expect(workers.match(/TC_POOL_EXTERNAL_ID/g)).toHaveLength(1);
    expect(workers.match(/config\.poolExternalId/g)).toHaveLength(2);
    expect(workers.match(/env\.TC_POOL_ACCOUNT_IDS/g)).toHaveLength(1);
    const branch = workers.slice(workers.indexOf('if (spec.dir === "migrator") {'));
    const body = branch.slice(0, branch.indexOf("\n  }\n"));
    expect(body).toContain('env.TC_POOL_ACCOUNT_IDS = config.poolAccountIds.join(",");');
    expect(body).toContain(
      "if (config.poolExternalId !== null) env.TC_POOL_EXTERNAL_ID = config.poolExternalId;",
    );
  });

  it("no app, other stack or other function reads it", () => {
    for (const path of [
      "infra/stacks/web.ts",
      "infra/stacks/database.ts",
      "infra/stacks/auth.ts",
      "infra/app.ts",
      "functions/provisioner/index.ts",
      "functions/catalog-sync/config.ts",
    ]) {
      expect(read(path), path).not.toMatch(/TC_POOL_EXTERNAL_ID|poolExternalId/);
    }
  });
});

describe("the seed-pool module (review M1)", () => {
  it("is a subpath export of @tc/db, not part of the root that the apps import", () => {
    const pkg = JSON.parse(read("packages/db/package.json"));
    expect(pkg.exports["./seed-pool"]).toBe("./seed-pool.ts");
    expect(code("packages/db/index.ts")).not.toMatch(
      /seed-pool|seedPoolAccount|poolAccountDecision/,
    );
  });

  it("is imported by the migrator through the subpath only, and the CLI still loads the file", () => {
    for (const path of ["functions/migrator/run.ts", "functions/migrator/index.ts"]) {
      expect(code(path), path).toMatch(/from "@tc\/db\/seed-pool";/);
    }
    expect(read("scripts/seed-pool-account.mjs")).toContain('from "../packages/db/seed-pool.ts";');
    // seed-pool.ts has no import at run time (the CLI loads it with Node's type stripping)
    expect(code("packages/db/seed-pool.ts")).not.toMatch(/^import /m);
  });

  it("the migrator asks for the audit row; the CLI does not", () => {
    expect(code("functions/migrator/index.ts")).toMatch(/\},\s*input,\s*\{ audit: true \},?\s*\)/);
    expect(read("scripts/seed-pool-account.mjs")).not.toContain("audit");
  });
});

describe("the migrator", () => {
  it("reads the raw values and lets @tc/db decide", () => {
    const config = code("functions/migrator/config.ts");
    expect(config).toContain("poolExternalId: text(env.TC_POOL_EXTERNAL_ID),");
    expect(config).toContain("poolAccountIds: text(env.TC_POOL_ACCOUNT_IDS),");
    const run = code("functions/migrator/run.ts");
    expect(run).toContain('step = "pool_account";');
    expect(run).toContain("const poolPlan = poolAccountDecision({");
    // the log holds the last 4 digits at most, never the ExternalId or the full id
    expect(run).toContain("accountSuffix: suffix");
    expect(run).not.toMatch(/log\(\{[^}]*externalId/i);
    expect(run).not.toMatch(/log\(\{[^}]*awsAccountId/);
    // the same SQL as the CLI: no statement on pool_accounts in the migrator
    for (const path of ["functions/migrator/run.ts", "functions/migrator/index.ts"]) {
      expect(read(path), path).not.toMatch(/insert into pool_|update pool_/i);
    }
    expect(code("functions/migrator/index.ts")).toContain("return await seedPoolAccount(");
  });
});

describe("the deploy workflows", () => {
  // Every job that runs sst with the stage block (deploy, plan, diff, and the removal of staging, which
  // mirrors the deploy block) passes the variable next to the ExternalId of tc-dns.
  for (const [path, jobs] of [
    [".github/workflows/deploy-staging.yml", 1],
    [".github/workflows/deploy-production.yml", 2],
    [".github/workflows/remove-staging.yml", 1],
  ]) {
    it(`${path} passes TC_POOL_EXTERNAL_ID in every stage env block`, () => {
      const text = read(path);
      const dns = text.match(/TC_DNS_EXTERNAL_ID: \$\{\{ vars\.TC_DNS_EXTERNAL_ID \}\}/g) ?? [];
      expect(dns).toHaveLength(jobs);
      const pairs = text.match(
        /TC_DNS_EXTERNAL_ID: \$\{\{ vars\.TC_DNS_EXTERNAL_ID \}\}\n\s+TC_POOL_EXTERNAL_ID: \$\{\{ vars\.TC_POOL_EXTERNAL_ID \}\}/g,
      );
      expect(pairs).toHaveLength(jobs);
      // a variable, never a secret
      expect(text).not.toMatch(/secrets\.TC_POOL_EXTERNAL_ID/);
    });
  }
});

describe("the runbooks", () => {
  it("pool-account-single.md names the migrator path, the variable and the log line, and keeps the CLI", () => {
    const page = read("docs/runbooks/pool-account-single.md");
    for (const text of [
      "TC_POOL_EXTERNAL_ID",
      "migrator_pool_account",
      "skipped: exists",
      "skipped: differs",
      "pool account bootstrap",
      "sst diff",
      "pnpm seed:pool-account",
    ]) {
      expect(page, text).toContain(text);
    }
    expect(page).not.toContain("refused: conflict");
  });

  it("go-live.md sets the variable and checks the log line", () => {
    const page = read("docs/runbooks/go-live.md");
    expect(page).toContain("TC_POOL_EXTERNAL_ID");
    expect(page).toContain("migrator_pool_account");
    expect(page).toContain("skipped: differs");
    expect(page).not.toContain("refused: conflict");
  });
});
