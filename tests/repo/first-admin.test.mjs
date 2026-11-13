// WPU-Z18: the first superadmin after the first deploy. Static proof of the wiring of the optional SST
// secret FirstAdminSub (declared with a placeholder, linked to the migrator only, the same names and
// placeholder in infra, the migrator and @tc/db) and of the order of the go-live runbook. The behaviour
// of the decision is in functions/migrator/run.test.ts, the SQL in packages/db/test/first-admin.test.ts,
// the owner script in tests/repo/golive.test.mjs.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_SECRETS,
  ALL_SECRETS,
  FIRST_ADMIN_SUB_SECRET,
  FUNCTIONS,
  OPTIONAL_SECRET_PLACEHOLDER,
  WEB_SECRETS,
} from "../../infra/lib/functions.ts";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");
// The text without comment lines, so a comment cannot satisfy or break a rule.
const code = (path) =>
  read(path)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("the secret FirstAdminSub", () => {
  it("has one name and one placeholder in infra, the migrator and @tc/db", () => {
    expect(FIRST_ADMIN_SUB_SECRET).toBe("FirstAdminSub");
    expect(OPTIONAL_SECRET_PLACEHOLDER).toBe("not-configured");
    expect(code("functions/migrator/config.ts")).toContain(
      'export const FIRST_ADMIN_SUB_SECRET = "FirstAdminSub";',
    );
    expect(code("packages/db/repositories/system/first-admin.ts")).toContain(
      'export const FIRST_ADMIN_NOT_CONFIGURED = "not-configured";',
    );
    // the same literal as the EPS placeholder of the owner script
    expect(read("scripts/golive/stage-secrets.sh")).toContain(
      'readonly PLACEHOLDER="not-configured"',
    );
  });

  it("is declared once, with the placeholder, outside the app and database secret sets", () => {
    const secrets = code("infra/stacks/secrets.ts");
    expect(secrets).toContain(
      "const firstAdminSub = new sst.Secret(FIRST_ADMIN_SUB_SECRET, OPTIONAL_SECRET_PLACEHOLDER);",
    );
    expect(secrets).toContain("return { app, db, firstAdminSub };");
    expect(secrets.match(/FIRST_ADMIN_SUB_SECRET/g)).toHaveLength(2); // the import and the declaration
    expect(ALL_SECRETS).not.toContain("FirstAdminSub");
    expect(WEB_SECRETS).not.toContain("FirstAdminSub");
    expect(ADMIN_SECRETS).not.toContain("FirstAdminSub");
    for (const f of FUNCTIONS) expect(f.secrets, f.dir).not.toContain("FirstAdminSub");
  });

  it("is linked to the migrator only", () => {
    const workers = code("infra/stacks/workers.ts");
    const uses = [...workers.matchAll(/secrets\.firstAdminSub/g)];
    expect(uses).toHaveLength(1);
    const branch = workers.slice(workers.indexOf('if (spec.dbRole === "migrator") {'));
    expect(branch.slice(0, branch.indexOf("return links;"))).toContain(
      "links.push(db.postgres, ...DB_ROLES.map((role) => secrets.db[role]), secrets.firstAdminSub);",
    );
    expect(FUNCTIONS.filter((f) => f.dbRole === "migrator").map((f) => f.dir)).toEqual([
      "migrator",
    ]);
    // no app and no other stack names it
    for (const path of [
      "infra/stacks/web.ts",
      "infra/stacks/database.ts",
      "infra/stacks/auth.ts",
      "infra/app.ts",
    ]) {
      expect(read(path), path).not.toMatch(/firstAdminSub|FirstAdminSub|FIRST_ADMIN/);
    }
  });

  it("is read by the migrator as an optional raw value and decided in @tc/db, never logged in full", () => {
    expect(code("functions/migrator/config.ts")).toContain(
      "firstAdminSub: secretValue(links(FIRST_ADMIN_SUB_SECRET)),",
    );
    // review M1: the migrator pins READ COMMITTED, and the bootstrap refuses any other level
    expect(code("functions/migrator/index.ts")).toMatch(
      /db\.transaction\(\(tx\) => bootstrapFirstSuperadmin\(tx, sub\), \{\s*isolationLevel: "read committed",\s*\}\)/,
    );
    expect(code("packages/db/repositories/system/first-admin.ts")).toContain(
      "sql`select current_setting('transaction_isolation') as level`",
    );
    const run = code("functions/migrator/run.ts");
    expect(run).toContain("const plan = firstAdminDecision(config.firstAdminSub);");
    expect(run).toContain("subPrefix: subPrefix(plan.sub)");
    expect(run).not.toMatch(/log\(\{[^}]*\bsub: /);
    expect(code("packages/db/repositories/system/first-admin.ts")).toContain(
      "return sub.slice(0, 8);",
    );
    // only the migrator calls the bootstrap: no app, no other function
    const callers = spawnSync(
      "git",
      ["grep", "-l", "bootstrapFirstSuperadmin", "--", "apps", "functions", "packages"],
      { cwd: root, encoding: "utf8" },
    )
      .stdout.split("\n")
      .filter(Boolean)
      .sort();
    expect(callers).toEqual([
      "functions/migrator/index.ts",
      "functions/migrator/run.ts",
      "packages/db/index.ts",
      "packages/db/repositories/system/first-admin.ts",
      "packages/db/test/first-admin-sub.test.ts",
      "packages/db/test/first-admin.test.ts",
    ]);
  });
});

describe("docs/runbooks/go-live.md, step 9.2", () => {
  const page = read("docs/runbooks/go-live.md");

  it("names the exact order: Cognito admin with TOTP, its sub, the secret, redeploy, sign in, leave it", () => {
    const order = [
      "leave empty until the Cognito admin exists (step 9.2)",
      "aws cognito-idp admin-create-user",
      "aws cognito-idp verify-software-token",
      "admin-set-user-mfa-preference",
      "aws cognito-idp admin-get-user --user-pool-id <adminPoolId> --username <owner e-mail> --query \"UserAttributes[?Name=='sub'].Value\" --output text",
      "Set the secret `FirstAdminSub`: run `scripts/golive/stage-secrets.sh production` again",
      "git push origin v0.1.2",
      "first superadmin bootstrap",
      "`migrator_first_admin`",
      "Sign in on `https://admin.tryaws.now/`",
      "it never fires again",
      "four eyes",
    ];
    let at = -1;
    for (const step of order) {
      const next = page.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    expect(page).not.toContain("no tool writes it yet");
  });
});
