import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { GATES, TASKS, quickChecks } from "../../verify/checks.mjs";
import { MANUAL_PROOFS } from "../../verify/manual-proofs.mjs";

const verify = (...args) =>
  spawnSync("node", ["scripts/verify.mjs", ...args], { encoding: "utf8" });

it("gate M0 and task WP0-T1 are the same six checks", () => {
  expect(GATES.M0.map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "format",
    "typecheck",
    "test",
  ]);
  expect(TASKS["WP0-T1"]).toEqual(GATES.M0);
  expect(GATES.M0.map((c) => c.command.join(" "))).toEqual([
    "pnpm spec:check",
    "pnpm baseline:check",
    "pnpm lint",
    "pnpm format:check",
    "pnpm typecheck",
    "pnpm test",
  ]);
});
it.each([
  [["--gate", "M9"], "Gate M9 does not exist", "gate-M9"],
  [["--task", "WP10-T1"], "Task WP10-T1 has no proof yet", "task-WP10-T1"],
])("fails closed for %j", (args, title, name) => {
  rmSync(`verify/report-${name}.json`, { force: true });
  const result = verify(...args);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(title);
  const report = JSON.parse(readFileSync(`verify/report-${name}.json`, "utf8"));
  expect(report).toMatchObject({ name, passed: false });
  expect(report.results[0]).toMatchObject({ id: "not-defined", passed: false });
});
it("fails closed with no mode and with two modes", () => {
  rmSync("verify/report-usage.json", { force: true });
  expect(verify().status).toBe(1);
  const report = JSON.parse(readFileSync("verify/report-usage.json", "utf8"));
  expect(report).toMatchObject({ name: "usage", passed: false });
  expect(report.results[0]).toMatchObject({
    id: "not-defined",
    title: "Choose one of --quick, --task <id> or --gate <gate>",
  });
  expect(verify("--quick", "--gate", "M0").status).toBe(1);
});
it.each([
  [["@tc/core"], "pnpm --filter ...@tc/core typecheck"],
  [["@tc/core", "@tc/web"], "pnpm --filter ...@tc/core --filter ...@tc/web typecheck"],
])("--quick type-checks %j and every package that depends on it", (packages, command) => {
  const commands = quickChecks(packages).map((c) => c.command.join(" "));
  expect(commands).toContain(command);
});
it("--quick never selects only what a changed package depends on", () => {
  const words = quickChecks(["@tc/core", "@tc/web"]).flatMap((c) => c.command);
  expect(words.filter((word) => word.endsWith("..."))).toEqual([]);
});

it("task WP1-T1 is proven by the checks of M0 plus Prettier, the schema tests and the repository tests", () => {
  expect(TASKS["WP1-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WP0-T1"]).toEqual(GATES.M0);
});

it("task WP4-T1 is proven by lint, types, format, the aws and core tests and the repository tests", () => {
  expect(TASKS["WP4-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // every other key of TASKS is unchanged
  expect(Object.keys(TASKS).sort()).toEqual([
    "WP0-T1",
    "WP0-T2",
    "WP0-T3",
    "WP0-T3b",
    "WP0-T4",
    "WP0-T5",
    "WP0-T6",
    "WP1-T1",
    "WP1-T2",
    "WP1-T3",
    "WP1-T4",
    "WP1-T5",
    "WP10-T2",
    "WP2-T1",
    "WP2-T2",
    "WP2-T3",
    "WP2-T4",
    "WP2-T5",
    "WP3-T1",
    "WP3-T2",
    "WP3-T3",
    "WP3-T4",
    "WP3-T5",
    "WP4-T1",
    "WP4-T2",
    "WP4-T3",
    "WP4-T4",
    "WP4-T5",
    "WP4-T6",
    "WP4-T7",
    "WP5-T1",
    "WP5-T2",
    "WP5-T3",
    "WP5-T4",
    "WP5-T5",
    "WP5-T6",
    "WP5-T6b",
    "WP5-T6c",
    "WP6-T1",
    "WP6-T1b",
    "WP6-T2",
    "WP6-T2s",
    "WP6-T3",
    "WP6-T4",
    "WP6-T4s",
    "WP7-T1",
    "WP7-T2",
    "WP7-T3",
    "WP7-T4",
    "WP7-T5",
    "WP7-T6",
    "WP8-T1",
    "WP8-T2",
    "WP8-T3",
    "WP8-T4",
    "WP8-T5",
    "WP8-T6",
    "WP8-T7",
    "WP9-T1",
    "WP9-T2",
    "WP9-T3",
    "WP9-T4",
    "WP9-T4b",
    "WP9-T5",
    "WP9-T6",
    "WPA-P1",
    "WPA-P2",
    "WPP-T1",
    "WPP-T2",
    "WPP-T3",
    "WPP-T4",
    "WPU-B1",
    "WPU-B2",
    "WPU-B3",
    "WPU-B4",
    "WPU-B5",
    "WPU-B6",
    "WPU-B7",
    "WPU-B8",
    "WPU-C1",
    "WPU-D1",
    "WPU-D2",
    "WPU-D3",
    "WPU-D4",
    "WPU-F1",
    "WPU-G1",
    "WPU-G10",
    "WPU-G11",
    "WPU-G2",
    "WPU-G3",
    "WPU-G4",
    "WPU-G5",
    "WPU-G6",
    "WPU-G7",
    "WPU-G8",
    "WPU-G9",
    "WPU-H1",
    "WPU-I1",
    "WPU-I2",
    "WPU-I3",
    "WPU-I4",
    "WPU-I5",
    "WPU-M1",
    "WPU-M2",
    "WPU-M3",
    "WPU-M4",
    "WPU-M5",
    "WPU-M6",
    "WPU-M7",
    "WPU-M8",
    "WPU-N1",
    "WPU-N2",
    "WPU-R1",
    "WPU-S1",
    "WPU-S2",
    "WPU-S3",
    "WPU-S4",
    "WPU-S5",
    "WPU-S6",
    "WPU-S7",
    "WPU-S8",
    "WPU-T1",
    "WPU-T2",
    "WPU-T3",
    "WPU-T4",
    "WPU-X6",
    "WPU-Z0",
    "WPU-Z1",
    "WPU-Z10",
    "WPU-Z11",
    "WPU-Z12",
    "WPU-Z13",
    "WPU-Z14",
    "WPU-Z15",
    "WPU-Z16",
    "WPU-Z17",
    "WPU-Z18",
    "WPU-Z2",
    "WPU-Z3",
    "WPU-Z4",
    "WPU-Z5",
    "WPU-Z6",
    "WPU-Z7",
    "WPU-Z8",
    "WPU-Z9",
  ]);
});

it("the WPU-Z tasks of the owner decisions round 3 name their proofs", () => {
  const ids = (task) => TASKS[task].map((c) => c.id);
  expect(ids("WPU-Z0")).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "repo",
  ]);
  expect(ids("WPU-Z1")).toEqual(expect.arrayContaining(["core", "scheduler", "repo"]));
  expect(ids("WPU-Z2")).toEqual(
    expect.arrayContaining(["core", "db", "cross-tenant", "web", "repo"]),
  );
  expect(ids("WPU-Z3")).toEqual(
    expect.arrayContaining(["notify", "notifier-fn", "web", "infra-lib", "repo"]),
  );
  expect(ids("WPU-Z4")).toEqual(expect.arrayContaining(["db", "admin", "repo"]));
  expect(ids("WPU-Z8")).toEqual(
    expect.arrayContaining([
      "web-brand",
      "admin-brand",
      "notify-brand",
      "cognito-messages",
      "repo",
    ]),
  );
  expect(ids("WPU-Z9")).toEqual(expect.arrayContaining(["sst-types", "infra-rules", "repo"]));
  expect(ids("WPU-Z12")).toEqual(expect.arrayContaining(["core", "db", "scheduler", "repo"]));
  expect(ids("WPU-Z5")).toEqual(
    expect.arrayContaining(["db", "cross-tenant", "admin", "web", "repo"]),
  );
  expect(ids("WPU-Z6")).toEqual(
    expect.arrayContaining(["db", "cross-tenant", "ui", "web", "repo"]),
  );
  expect(ids("WPU-Z10")).toEqual(expect.arrayContaining(["sst-types", "infra-rules", "repo"]));
  expect(ids("WPU-Z11")).toEqual(expect.arrayContaining(["web", "repo"]));
  expect(ids("WPU-Z13")).toEqual(expect.arrayContaining(["core", "admin", "repo"]));
  expect(ids("WPU-Z14")).toEqual(
    expect.arrayContaining(["core", "db", "cross-tenant", "web", "repo"]),
  );
  expect(ids("WPU-Z15")).toEqual(expect.arrayContaining(["db", "web", "admin", "links", "repo"]));
  expect(ids("WPU-Z16")).toEqual(expect.arrayContaining(["web", "repo"]));
  expect(ids("WPU-Z18")).toEqual(expect.arrayContaining(["migrator", "first-admin", "repo"]));
  expect(ids("WPU-Z17")).toEqual(expect.arrayContaining(["repo"]));
  expect(ids("WPU-Z7")).toEqual(
    expect.arrayContaining(["wpp-pages", "wpp-mockup-anchors", "wpp-messages", "web", "repo"]),
  );
});

it("task WPU-X6 is proven by lint, types, format, the axe browser smoke and the repository tests; the smoke fails when it cannot run", () => {
  expect(TASKS["WPU-X6"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["a11y-smoke", "node scripts/smoke-a11y.mjs"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WPU-X6"].find((c) => c.id === "a11y-smoke").timeoutMs).toBe(1_800_000);
  for (const [file, part] of [
    ["scripts/smoke-a11y.mjs", "BLOCKED"],
    ["scripts/smoke-a11y.mjs", "exitCodeFor"],
    ["tests/e2e/a11y.spec.ts", "AxeBuilder"],
    ["tests/e2e/a11y.config.ts", "width: 360"],
    ["tests/e2e/a11y.config.ts", "width: 1280"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-G1 is proven by lint, types, format, the aws, core, db, provisioner and web tests and the repository tests", () => {
  expect(TASKS["WPU-G1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G2 is proven by lint, types, format, the core, aws, web and repository tests", () => {
  expect(TASKS["WPU-G2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G3 is proven by lint, types, format, the core, aws, db, catalog-sync, provisioner, ui, web, admin and repository tests", () => {
  expect(TASKS["WPU-G3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["catalog-sync", "pnpm test --filter @tc/fn-catalog-sync --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G10 is proven by lint, types, format, the core, aws, db, catalog-sync, ui, web, admin and repository tests", () => {
  expect(TASKS["WPU-G10"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["catalog-sync", "pnpm test --filter @tc/fn-catalog-sync --no-passWithNoTests"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof tests of WPU-G10 exist: the key made in the browser, the plan check, the tier limits and the dated config price", () => {
  for (const [file, title] of [
    [
      "apps/web/app/[locale]/(panel)/servers/new/ssh-keygen.test.ts",
      "the seed signs and the public key verifies",
    ],
    [
      "tests/repo/ssh-keygen-openssh.test.mjs",
      "is read by ssh-keygen and gives the same public key",
    ],
    [
      "apps/web/app/[locale]/(panel)/servers/new/KeyStep.test.tsx",
      "is not ready until the private key was downloaded",
    ],
    ["apps/web/server/wizard-key.test.ts", "a private key in the public field is refused"],
    ["packages/core/orders/image-min-power-order.test.ts", "refuses a 512 MB plan for an app"],
    [
      "packages/core/orders/tier-limits-order.test.ts",
      "a row that does not parse refuses the order",
    ],
    [
      "packages/core/orders/config-price-order.test.ts",
      "no entry has started yet: nothing is sold",
    ],
    ["packages/db/test/admin-config-prices.test.ts", "a later start is a scheduled change"],
    ["packages/db/test/admin-tier-limits.test.ts", "only superadmin and ops read and write"],
    [
      "packages/db/test/image-min-power.test.ts",
      "an admin sets the minimum of an image with a reason",
    ],
    ["apps/admin/server/admin-sweep.test.ts", "the config-price flow authorizes in its one write"],
  ]) {
    const text = readFileSync(file, "utf8");
    expect(text, file).toContain(title);
  }
});

it("task WPU-H1 is proven by lint, types, format, the ledger-at-the-database proof, the core and db tests and the repository tests", () => {
  expect(TASKS["WPU-H1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["ledger-unbalanced", "pnpm test --filter @tc/core ledger/unbalanced-db --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof test of WPU-H1 exists and covers the three application roles", () => {
  const text = readFileSync("packages/core/ledger/unbalanced-db.test.ts", "utf8");
  expect(text).toContain('const ROLES = ["web_rw", "worker_rw", "admin_rw"]');
  for (const part of [
    "single-sided",
    "1 paisa",
    "zero amount",
    "negative amount",
    "two currencies",
    "reversal",
    "append-only",
  ]) {
    expect(text, part).toContain(part);
  }
});

it("task WPU-I1 is proven by lint, types, format, the core, db, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-I1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-I4 is proven by lint, types, format, the core, db, scheduler, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-I4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-I4 exists: both snapshots, the buyer read at issue, the grants and the reprint", () => {
  for (const [file, part] of [
    ["packages/db/test/invoice-buyer-merge.test.ts", "admin_rw cannot read buyer"],
    [
      "packages/core/invoices/charge.db.test.ts",
      "issued after the customer entered billing details carries both snapshots",
    ],
    [
      "packages/core/invoices/charge.db.test.ts",
      "a backlog invoice carries the buyer current at ISSUE",
    ],
    [
      "packages/core/invoices/charge.db.test.ts",
      "a purchase with no billing details stores no buyer",
    ],
    [
      "apps/web/server/invoice-document.test.ts",
      "a reprint shows both snapshots of the day of issue",
    ],
    [
      "packages/db/migrations/0017_customer_billing_profile.sql",
      "REVOKE SELECT ON invoices FROM admin_rw",
    ],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-D2 is proven by lint, types, format, the migrator and hash tests and the infra and runbook tests", () => {
  expect(TASKS["WPU-D2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["migrator", "pnpm test --filter @tc/fn-migrator --no-passWithNoTests"],
    ["migration-hashes", "pnpm test --filter @tc/db test/migration-hashes --no-passWithNoTests"],
    ["infra-lib", "pnpm test --filter repo infra-lib --no-passWithNoTests"],
    ["infra-org", "pnpm test --filter repo infra-org --no-passWithNoTests"],
    ["infra-ci-oidc", "pnpm test --filter repo infra-ci-oidc --no-passWithNoTests"],
    ["infra-rules", "pnpm test --filter repo infra-rules --no-passWithNoTests"],
    ["ci-deploy", "pnpm test --filter repo ci-deploy --no-passWithNoTests"],
    ["runbooks", "pnpm test --filter repo runbooks --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-D2 exists: sst pinned, outputs, role names, OIDC bounds, probe sources, ledger alarms, hashes", () => {
  expect(JSON.parse(readFileSync("package.json", "utf8")).devDependencies.sst).toBe("4.17.2");
  for (const [file, part] of [
    ["infra/app.ts", "featureFlagDefaults: featureFlagDefaults(),"],
    ["infra/app.ts", "webRolePolicies: apps.webRolePolicies,"],
    ["infra/org/pool-roles.yaml", "tc-${ControlPlaneStage}-provisioner-role"],
    ["infra/org/ci-deploy-production.yaml", "TcCiRoleBoundary"],
    ["infra/org/ci-plan-production.yaml", "NoLogsMessagesItemsOrDatabaseData"],
    ["infra/lib/stage.ts", "TC_PROBE_SOURCES entry"],
    ["infra/lib/functions.ts", 'LEDGER_CHECK_SCHEDULE = "cron(0 20 * * ? *)"'],
    ["infra/stacks/alarms.ts", 'resourceName(stage, "ledger-mismatch")'],
    ["functions/migrator/run.ts", "an applied migration changed"],
    ["functions/migrator/index.ts", "ensureSystemAccounts"],
    ["docs/runbooks/ledger-check-failed.md", "tc-<stage>-ledger-mismatch"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-D3 is proven by lint, types, format, the core, db, aws, eps, sweeper, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-D3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["eps", "pnpm test --filter @tc/eps --no-passWithNoTests"],
    ["payments-sweeper", "pnpm test --filter @tc/fn-payments-sweeper --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-D3 exists: no NID, the DNS price and margin, the guards on payments, the KYC index, the redirect list, the alert, the address", () => {
  for (const [file, part] of [
    ["packages/db/migrations/0019_drop_customer_nid.sql", 'DROP COLUMN "customer_nid"'],
    ["packages/db/test/billing-profile.test.ts", "the NID column and its checks are gone"],
    ["packages/core/invoices/buyer.test.ts", "never returned"],
    ["packages/core/orders/config-price-order.test.ts", "the seeded book is a 15 percent margin"],
    [
      "packages/core/orders/config-price-order.test.ts",
      "with no book row the price is the base only",
    ],
    ["packages/db/test/dns-seed-migration.test.ts", "never overwrites an edited price"],
    ["packages/db/test/payments-guards.test.ts", "a credited payment is final"],
    ["packages/db/test/kyc-repo.test.ts", "one pending submission per customer"],
    ["packages/eps/test/redirect.test.ts", "the test host is refused by default"],
    ["packages/eps/test/verify.test.ts", "raises credit_blocked"],
    ["packages/eps/test/verify.test.ts", "after the credit transaction has committed"],
    ["packages/aws/test/linux-instance.test.ts", "written to the resource config at create"],
    [
      "packages/aws/test/container-service.test.ts",
      "stores the public host in the resource config",
    ],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-I5 is proven by lint, types, format, the core, db, scheduler, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-I5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-I5 exists: the VAT base, reversed charges, the order, no lost charge, one buyer rule, one instant", () => {
  for (const [file, part] of [
    ["packages/core/pricing/vat-check.test.ts", "rounds a half up"],
    ["packages/core/invoices/render-vat.test.ts", "vector 44 USD"],
    ["packages/core/invoices/render-vat.test.ts", "is refused, not printed"],
    ["packages/core/invoices/buyer-limits.test.ts", "a 150-character profile name"],
    [
      "packages/core/invoices/order-guards.db.test.ts",
      "queued, not issued, while an older charge waits",
    ],
    ["packages/core/invoices/order-guards.db.test.ts", "stops at the first refusal"],
    ["packages/core/invoices/order-guards.db.test.ts", "is never invoiced"],
    ["packages/core/invoices/order-guards.db.test.ts", "a credit-note notice is written once"],
    ["packages/core/invoices/order-guards.db.test.ts", "2027-06-30T17:59:59.9Z"],
    ["packages/core/invoices/order-guards.db.test.ts", "is marked unreadable and skipped"],
    ["packages/db/test/invoice-order-guards.test.ts", "the boundary of 1 July in Dhaka"],
    ["packages/db/migrations/0018_invoice_order_and_reversal.sql", "invoice_backlog_blocked"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-C1 is proven by lint, types, format, the core, db, scheduler, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-C1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-C1 exists: the supply date, the credit note, its numbers, the refusals and the tenant scope", () => {
  for (const [file, part] of [
    [
      "packages/core/invoices/credit-note-render.test.ts",
      "a normal invoice shows the same date twice",
    ],
    [
      "packages/core/invoices/credit-note-render.test.ts",
      "the customer's document is marked Original",
    ],
    [
      "packages/core/invoices/credit-note-render.test.ts",
      "repeats the rows of the original in full",
    ],
    ["packages/core/invoices/credit-note.db.test.ts", "is issued for a reversed order"],
    ["packages/core/invoices/credit-note.db.test.ts", "is issued for a reversed renewal"],
    [
      "packages/core/invoices/credit-note.db.test.ts",
      "gap-free per fiscal year under a failed issue",
    ],
    [
      "packages/core/invoices/credit-note.db.test.ts",
      "a repeat of the run makes no second credit note",
    ],
    ["packages/core/invoices/credit-note.db.test.ts", "does not equal the invoice total"],
    ["packages/core/invoices/credit-note.db.test.ts", "a backlog invoice shows the charge date"],
    [
      "packages/core/invoices/credit-note.db.test.ts",
      "another customer's reversal answers not_found",
    ],
    [
      "apps/web/server/credit-note-view.test.ts",
      "another customer's credit note answers like a missing one",
    ],
    ["packages/db/migrations/0023_invoice_supply_date_and_credit_notes.sql", "WPU-C1"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-B2 is proven by lint, types, format, the core, db, aws, provisioner, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-B2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-B2 exists: the Route 53 Domains client, the three domain actions, the status sync, the unique name, the web cores and the zone lifecycle", () => {
  for (const [file, part] of [
    ["packages/aws/test/domains-client.test.ts", "maps DuplicateRequest to a conflict"],
    [
      "packages/aws/test/domain-actions.test.ts",
      "a repeat of the start after the renewal went through",
    ],
    ["packages/aws/test/domain-actions.test.ts", "validates the payload before any call"],
    [
      "packages/core/domains/sync.test.ts",
      "a row that is already past the registration is never downgraded",
    ],
    ["packages/core/domains/nameservers.test.ts", "refuses everything else with one code"],
    ["functions/provisioner/domain-hooks.test.ts", "a create that failed gives the name back"],
    ["packages/db/test/domain-sync.test.ts", "holds a name once on the platform"],
    ["packages/db/migrations/0024_domain_name_active_unique.sql", "WPU-B2"],
    [
      "apps/web/server/domain-ops.test.ts",
      "another customer's domain and a missing one are one answer",
    ],
    [
      "packages/core/lifecycle/zone-lifecycle.test.ts",
      "destroy needs a retained subscription and no snapshot",
    ],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("the journal holds 0024 at idx 22 right after 0023, and its snapshot is the child of 0023 (WPU-B2; later migrations may follow)", () => {
  const dir = "packages/db/migrations";
  const journal = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8"));
  const at = journal.entries.findIndex((e) => e.tag === "0024_domain_name_active_unique");
  expect(at).toBeGreaterThan(0);
  expect(journal.entries[at]).toMatchObject({ idx: 22, tag: "0024_domain_name_active_unique" });
  expect(journal.entries[at - 1].tag).toBe("0023_invoice_supply_date_and_credit_notes");
  const parent = JSON.parse(readFileSync(`${dir}/meta/0023_snapshot.json`, "utf8"));
  const child = JSON.parse(readFileSync(`${dir}/meta/0024_snapshot.json`, "utf8"));
  expect(child.prevId).toBe(parent.id);
  expect(JSON.stringify(child)).toContain("domains_name_active_unique");
});

it("task WPU-M6 is proven by the checks of both merged sides: lint, types, format, the core, db, scheduler, aws, eps, sweeper, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-M6"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["eps", "pnpm test --filter @tc/eps --no-passWithNoTests"],
    ["payments-sweeper", "pnpm test --filter @tc/fn-payments-sweeper --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-M6 exists: one journal in order and one snapshot chain over 0018, 0019 to 0021 and 0023", () => {
  const dir = "packages/db/migrations";
  const journal = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8"));
  const tags = journal.entries.map((e) => e.tag);
  // WPU-B2 appended 0024 after 0023: the window is the five tags of this proof, not the last five.
  const start = tags.indexOf("0018_invoice_order_and_reversal");
  const window = tags.slice(start, start + 5);
  expect(window).toEqual([
    "0018_invoice_order_and_reversal",
    "0019_drop_customer_nid",
    "0020_dns_zone_price_and_kyc_open_index",
    "0021_payments_gateway_id_unique_and_credited_guard",
    "0023_invoice_supply_date_and_credit_notes",
  ]);
  journal.entries.forEach((e, i) => {
    expect(e.idx, e.tag).toBe(i);
    if (i > 0) expect(e.when, e.tag).toBeGreaterThan(journal.entries[i - 1].when);
    expect(existsSync(`${dir}/${e.tag}.sql`), e.tag).toBe(true);
  });
  const snap = (tag) =>
    JSON.parse(readFileSync(`${dir}/meta/${tag.slice(0, 4)}_snapshot.json`, "utf8"));
  const chain = window.map(snap);
  chain.forEach((s, i) => {
    if (i > 0) expect(s.prevId, window[i]).toBe(chain[i - 1].id);
  });
  const invoices = chain[4].tables["public.invoices"] ?? chain[4].tables.public?.invoices;
  expect(JSON.stringify(chain[4])).not.toContain("customer_nid");
  expect(JSON.stringify(chain[4])).toContain("invoices_fiscal_year_kind_number_unique");
  expect(invoices).toBeDefined();
});

it("task WPU-I3 is proven by lint, types, format, the core, db, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-I3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-I3 exists: the validation, the buyer snapshot, the repository, the action and the sweep entry", () => {
  for (const [file, part] of [
    ["packages/core/validation/billing-profile.test.ts", "a BIN is exactly 13 digits"],
    ["packages/core/invoices/buyer.test.ts", "parseBuyerSnapshot reads a stored snapshot"],
    ["packages/db/test/billing-profile.test.ts", "one customer's write never touches another"],
    ["packages/db/migrations/0017_customer_billing_profile.sql", "WPU-I3"],
    [
      "apps/web/server/billing-actions.test.ts",
      "keeps the name, the address and the tax ids out of the audit entry",
    ],
    ["apps/web/server/invoice-document.test.ts", "from the snapshot stored on the invoice"],
    ["apps/web/server/endpoint-sweep.cases.ts", "updateBillingAction"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("the proof of WPU-I1 exists: the renderer, the seller rules, the refusal to issue and the admin page", () => {
  for (const [file, part] of [
    ["packages/core/invoices/render.test.ts", "Mushak-6.3"],
    ["packages/core/invoices/seller.test.ts", "BIN is exactly 13 Latin digits"],
    ["packages/core/invoices/words.test.ts", "amountInWords"],
    ["packages/db/test/invoices-repo.test.ts", "seller_details_missing"],
    ["packages/db/test/admin-invoice-seller.test.ts", "nothing is seeded"],
    ["apps/web/server/invoice-document.test.ts", "503"],
    ["apps/admin/server/invoice-seller-flow.test.ts", "denied"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-I2 is proven by lint, types, format, the core, db, scheduler, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-I2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-I2 exists: the rate, the seller snapshot, the invoice of a charge and the queue", () => {
  for (const [file, part] of [
    ["packages/core/pricing/quote.test.ts", "every step carries its rate"],
    ["packages/core/invoices/charge.test.ts", "the VAT rate prints in the rate cell"],
    ["packages/core/invoices/charge.db.test.ts", "never fails the charge"],
    ["packages/core/invoices/charge.db.test.ts", "a backlog is issued in the order of the charge"],
    ["packages/db/test/invoice-snapshot-backlog.test.ts", "keeps the seller of the day of issue"],
    ["apps/web/server/invoice-document.test.ts", "a reprint shows the seller of the day of issue"],
    ["apps/admin/server/invoice-seller-data.test.ts", "wait for the seller details"],
    ["functions/scheduler/handler.test.ts", "invoice_backlog_run"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-G4 is proven by lint, types, format, the core, db, aws, web and repository tests", () => {
  expect(TASKS["WPU-G4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G6 is proven by lint, types, format, the core, db, aws, provisioner, web and repository tests", () => {
  expect(TASKS["WPU-G6"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-D4 is proven by lint, types, format, the core, db, aws, notify, notifier, provisioner, scheduler, admin and repository tests", () => {
  expect(TASKS["WPU-D4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["notify", "pnpm test --filter @tc/notify --no-passWithNoTests"],
    ["notifier-fn", "pnpm test --filter @tc/fn-notifier --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-M8 is proven by lint, types, format and the suites that both merged sides touch", () => {
  expect(TASKS["WPU-M8"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["notify", "pnpm test --filter @tc/notify --no-passWithNoTests"],
    ["notifier-fn", "pnpm test --filter @tc/fn-notifier --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["invoice-renderer", "pnpm test --filter @tc/fn-invoice-renderer --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-S1 is proven by lint, types, format, the core, db and repository tests", () => {
  expect(TASKS["WPU-S1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-S2 is proven by lint, types, format, the core, aws, provisioner, scheduler and repository tests", () => {
  expect(TASKS["WPU-S2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-S3 is proven by lint, types, format, the core, db, aws, scheduler, web and repository tests", () => {
  expect(TASKS["WPU-S3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-M1 is proven by lint, types, format, the core, db, aws, scheduler, web, admin and repository tests", () => {
  expect(TASKS["WPU-M1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-M2 is proven by lint, types, format, the core, db, scheduler, web and repository tests", () => {
  expect(TASKS["WPU-M2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-M3 is proven by lint, types, format, the core, db, admin, notify and repository tests", () => {
  expect(TASKS["WPU-M3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["notify", "pnpm test --filter @tc/notify --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-M4 is proven by lint, types, format, the core, db, aws, admin and repository tests", () => {
  expect(TASKS["WPU-M4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-M5 is proven by lint, types, format, the core, db, admin and repository tests", () => {
  expect(TASKS["WPU-M5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-S8 is proven by lint, types, format, the core, renderer, web and repository tests", () => {
  expect(TASKS["WPU-S8"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["invoice-renderer", "pnpm test --filter @tc/fn-invoice-renderer --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-S8 exists: the admin grants, the fresh sign-in for the BIN, no NID and the renderer check", () => {
  for (const [file, part] of [
    ["tests/repo/infra-rules.test.mjs", "away from the admin role (WPU-S8)"],
    ["apps/web/server/billing-actions.test.ts", "the BIN needs a fresh sign-in (WPU-S8)"],
    ["apps/web/app/[locale]/(panel)/settings/settings.test.tsx", "the loader carries no NID field"],
    ["packages/core/validation/billing-profile.test.ts", "there is no NID"],
    [
      "functions/invoice-renderer/handler.test.ts",
      "renders the customer's own text as escaped text",
    ],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-D1 is proven by lint, types, format, the renderer and repository tests", () => {
  expect(TASKS["WPU-D1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["invoice-renderer", "pnpm test --filter @tc/fn-invoice-renderer --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-B3 is proven by lint, types, format, core, db, reconciler, scheduler, provisioner, web, admin and the repository tests", () => {
  expect(TASKS["WPU-B3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["reconciler", "pnpm test --filter @tc/fn-reconciler --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-B3 exists: the cleanup follow-up, the release alarm, the stuck credit note, the usage writer, the polls and the alerts", () => {
  for (const [file, part] of [
    ["packages/core/orders/failed-create-follow-up.test.ts", "cleanupOperationFor"],
    ["packages/core/lifecycle/guard.test.ts", "cleanup_failed_create"],
    ["packages/core/capacity/release-alarm.test.ts", "malformed_record"],
    ["packages/core/invoices/credit-note-stuck.test.ts", "escalates every run"],
    ["packages/core/metering/usage-writer.test.ts", "refuses two samples for one resource"],
    ["packages/core/lifecycle/polling.test.ts", "queues read_db_parameters once"],
    ["packages/db/test/polling.db.test.ts", "certificatesToRefresh"],
    ["functions/reconciler/usage.test.ts", "fails closed"],
    ["tests/repo/infra-alerts.test.mjs", "exist in the code that writes them"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-B1 is proven by lint, types, format, the core, notify, web, admin and ui tests and the repository tests", () => {
  expect(TASKS["WPU-B1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core-brand", "pnpm test --filter @tc/core invoices --no-passWithNoTests"],
    ["notify-brand", "pnpm test --filter @tc/notify --no-passWithNoTests"],
    ["web-brand", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin-brand", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-B1 exists: the repository test that bans the old brand in customer-facing files", () => {
  expect(readFileSync("tests/repo/brand.test.mjs", "utf8")).toContain(
    "no customer-facing message, template, logo or invoice text says TiCON Cloud",
  );
});

it("task WPU-F1 is proven by lint, types, format, the digit helper, mail, renderer and ui tests and the repository tests", () => {
  expect(TASKS["WPU-F1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    [
      "core-fonts",
      "pnpm test --filter @tc/core invoices/digit-one invoices/render invoices/credit-note-render invoices/buyer.test --no-passWithNoTests",
    ],
    [
      "notify-fonts",
      "pnpm test --filter @tc/notify test/digit-one test/templates test/wording --no-passWithNoTests",
    ],
    ["invoice-renderer", "pnpm test --filter @tc/fn-invoice-renderer --no-passWithNoTests"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-B5 is proven by lint, types, format, the aws, core, db, provisioner, catalog-sync, web and admin tests and the repository tests", () => {
  expect(TASKS["WPU-B5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["catalog-sync", "pnpm test --filter @tc/fn-catalog-sync --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-B5 exists: the admin mark, the restore, the CDN and database catalog, and the disk from a snapshot", () => {
  for (const [file, part] of [
    [
      "functions/provisioner/admin-suspended.test.ts",
      "is cleared when a resume with adminSuspended false succeeds",
    ],
    ["packages/db/test/admin-abuse-restore.test.ts", "restoreResource writes one resume operation"],
    [
      "packages/aws/test/catalog-cdn-db.test.ts",
      "distributionBundles: reads GetDistributionBundles in us-east-1",
    ],
    ["functions/catalog-sync/handler.test.ts", "CDN bundles and database engines (WPU-B5)"],
    ["packages/aws/test/disk-restore.test.ts", "calls CreateDiskFromSnapshot with generated names"],
    [
      "packages/core/orders/disk-restore-order.test.ts",
      "another customer's snapshot answers like a missing one",
    ],
    ["apps/web/server/disk-restore-actions.test.ts", "restoreDiskDraftCore"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-B6 is proven by lint, types, format, the db and notify tests of the caps and the form, web, admin, ui and the repository tests", () => {
  expect(TASKS["WPU-B6"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    [
      "db-b6",
      "pnpm test --filter @tc/db test/visitor-support test/market-settings --no-passWithNoTests",
    ],
    [
      "notify-b6",
      "pnpm test --filter @tc/notify test/otp-daily-cap test/sms-cap --no-passWithNoTests",
    ],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-B6 exists: the schemas, the honeypot form, the caps, the numerals and the picker", () => {
  for (const [file, part] of [
    ["apps/admin/server/schemas.test.ts", "takaToMinor is integer arithmetic"],
    ["apps/web/server/public/support-form.test.ts", "a filled honeypot answers done"],
    ["apps/web/server/public/catalog.test.ts", "carries the numerals setting of the market"],
    ["packages/db/test/visitor-support.test.ts", "is idempotent"],
    ["packages/db/test/market-settings.test.ts", "a bad value are null"],
    ["packages/notify/test/otp-daily-cap.test.ts", "the 4th send in a day is refused"],
    ["packages/notify/test/sms-cap.test.ts", "refuses an SMS over the cap"],
    ["apps/web/app/[locale]/(panel)/support/new/related-resource.test.tsx", "escapes the name"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("the proof of WPU-F1 exists: the digit helper, the invoice stack and spans, the mail, the packaged fonts, the web unicode-range and U3", () => {
  for (const [file, part] of [
    ["packages/core/invoices/digit-one.test.ts", "is idempotent"],
    [
      "packages/core/invoices/render.test.ts",
      "Hind Siliguri first, the digit rule in the style block",
    ],
    ["packages/notify/test/digit-one.test.ts", "escapes first and wraps after"],
    ["functions/invoice-renderer/engines.test.ts", "the digit font is required too"],
    [
      "functions/invoice-renderer/handler.test.ts",
      "accepts the Bengali templates with the digit-one span",
    ],
    ["packages/ui/components/digit-one.test.tsx", "never touches the Latin 1"],
    [
      "packages/ui/theme/tc-fonts.test.ts",
      "draws the Bengali digit one, and only it, with Noto Sans Bengali, by unicode-range alone",
    ],
    ["packages/ui/theme/tc-fonts.test.ts", "no third-party font origin anywhere (U3)"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-N2 is proven by lint, types, format, aws, access-details, web and repository tests", () => {
  expect(TASKS["WPU-N2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["secrets-aws", "pnpm test --filter @tc/aws access-n2 --no-passWithNoTests"],
    ["access-details", "pnpm test --filter @tc/fn-access-details --no-passWithNoTests"],
    [
      "secrets-web",
      "pnpm test --filter @tc/web server/bucket-keys server/bucket-actions server/auth/context --no-passWithNoTests",
    ],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-B7 is proven by lint, types, format, the eps, web, access-details and renderer tests and the repository tests", () => {
  expect(TASKS["WPU-B7"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["eps", "pnpm test --filter @tc/eps --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["access-details", "pnpm test --filter @tc/fn-access-details --no-passWithNoTests"],
    ["invoice-renderer", "pnpm test --filter @tc/fn-invoice-renderer --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-B7 exists: zod cores, the real tenant read, the DB-level cross-tenant test, the alias, the limits and the log words", () => {
  for (const [file, part] of [
    [
      "apps/web/server/windows-access.test.ts",
      "customer B asking for customer A's server gets the answer of a missing id, and the tenant read ran (R8)",
    ],
    [
      "functions/access-details/test/proof-cross-tenant.test.ts",
      "answers B asking for A's server exactly as a missing id, in one transaction (the tenant read)",
    ],
    ["apps/web/server/bucket-keys.test.ts", "validates with zod: only the named fields are read"],
    ["apps/web/server/bucket-keys.test.ts", "L5: key_not_created is a public answer of its own"],
    ["apps/web/server/domain-actions.test.ts", "reads only name, requestId and enabled with zod"],
    ["apps/web/server/rate-limit-names.test.ts", "gives every web name the suffix .web"],
    ["apps/web/server/log.test.ts", "drops free text under reason and state, keeps the event"],
    ["packages/eps/test/log.test.ts", "drops free text under reason and state"],
    [
      "functions/invoice-renderer/handler.test.ts",
      "accepts exactly the alias web and nothing else",
    ],
    ["tests/repo/security-batch-b7.test.mjs", "has no sqs action and no queue URL"],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("the proof of WPU-N2 exists", () => {
  for (const file of [
    "packages/aws/test/access-n2.test.ts",
    "functions/access-details/secrets.test.ts",
    "apps/web/server/bucket-keys.test.ts",
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain("it(");
  }
});

it("the proof of WPU-D1 exists: the engine with fakes, the store, and the renderer network and role rules", () => {
  for (const [file, part] of [
    [
      "functions/invoice-renderer/engines.test.ts",
      "disables JavaScript, goes offline and intercepts requests before the content is set",
    ],
    [
      "functions/invoice-renderer/engines.test.ts",
      "aborts every request: an external URL, a data URL, a file URL and an about URL",
    ],
    [
      "functions/invoice-renderer/engines.test.ts",
      "sends exactly one PutObject with the derived key",
    ],
    [
      "tests/repo/infra-rules.test.mjs",
      "gives invoice-renderer no internet egress and no S3 action but PutObject (WPU-D1)",
    ],
  ]) {
    expect(readFileSync(file, "utf8"), file).toContain(part);
  }
});

it("task WPU-S7 is proven by lint, types, format, the core, db, aws, scheduler, web and repository tests", () => {
  expect(TASKS["WPU-S7"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-S6 is proven by lint, types, format, the core, aws, reader, web and repository tests", () => {
  expect(TASKS["WPU-S6"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["reader", "pnpm test --filter @tc/fn-reader --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});
it("task WPU-S4 is proven by lint, types, format, the core, db, aws, scheduler, web and repository tests", () => {
  expect(TASKS["WPU-S4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-S5 is proven by lint, types, format, the core, db, aws, scheduler, web and repository tests", () => {
  expect(TASKS["WPU-S5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G7 is proven by lint, types, format, the core, db, aws, web, admin and repository tests", () => {
  expect(TASKS["WPU-G7"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G8 is proven by lint, types, format, the core, db, aws, web, admin and repository tests", () => {
  expect(TASKS["WPU-G8"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G11 is proven by lint, types, format, the core, db, aws, web, admin and repository tests", () => {
  expect(TASKS["WPU-G11"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof tests of WPU-G11 exist: the whitelist, the adapters, the typed domain with a fresh sign-in, the forms and the allow-list", () => {
  for (const [file, title] of [
    [
      "packages/core/products/db-parameters.test.ts",
      "never lists a parameter that can lock the customer out",
    ],
    [
      "packages/db/test/operation-kinds.test.ts",
      "customer kinds that are not destructive in the sense of R13",
    ],
    [
      "packages/aws/test/cdn.test.ts",
      "detaches it from the distribution, deletes it and clears the saved certificate",
    ],
    [
      "packages/aws/test/container-service.test.ts",
      "takes the domain off the service, deletes the certificate",
    ],
    ["packages/aws/test/load-balancer.test.ts", "turns the HTTPS redirect off first"],
    [
      "packages/aws/test/database-g11.test.ts",
      "applies a dynamic parameter at once and a static one at the next reboot",
    ],
    [
      "apps/web/server/console-actions-g11.test.ts",
      "needs a fresh sign-in before anything else, and the typed domain",
    ],
    [
      "apps/web/server/console-actions-g11.test.ts",
      "another customer's resource, a missing one and a wrong family give one answer",
    ],
    [
      "apps/web/app/[locale]/(panel)/_console/console-g11.test.tsx",
      "shows the last known list with its date",
    ],
    [
      "tests/repo/infra-org.test.mjs",
      "TcProvisioner allows exactly the commands of the provisioning adapters",
    ],
  ]) {
    const text = readFileSync(file, "utf8");
    expect(text, `${file}: ${title}`).toContain(title);
  }
});

it("task WPU-G9 is proven by lint, types, format, the core, db, aws, web, admin and repository tests", () => {
  expect(TASKS["WPU-G9"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-G5 is proven by lint, types, format, the core, web and repository tests", () => {
  expect(TASKS["WPU-G5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-T4 is proven by lint, types, format, the ui, web and admin tests, the repository tests and the smoke script", () => {
  expect(TASKS["WPU-T4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
    ["apps-smoke", "node scripts/smoke-apps.mjs"],
  ]);
});

it("tasks WPU-T2 and WPU-T3 share one proof: the kit tests with real path filters", () => {
  expect(TASKS["WPU-T2"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "ui",
    "ui-kit",
    "repo",
  ]);
  expect(TASKS["WPU-T3"]).toEqual(TASKS["WPU-T2"]);
  const kit = TASKS["WPU-T2"].find((c) => c.id === "ui-kit");
  expect(kit.command).toEqual([
    "pnpm",
    "test",
    "--filter",
    "@tc/ui",
    "components/",
    "messages/",
    "test/",
    "--no-passWithNoTests",
  ]);
  for (const file of [
    "packages/ui/components/Button.test.tsx",
    "packages/ui/messages/messages.test.ts",
    "packages/ui/test/render.test.tsx",
  ])
    expect(existsSync(file), file).toBe(true);
});

it("task WPU-T1 is proven by lint, types, format, the ui tests, the two theme checks and the repository tests", () => {
  expect(TASKS["WPU-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["theme-import", "pnpm theme:sync --stage import --check"],
    ["theme-publish", "pnpm theme:sync --stage publish"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WP1-T2 is proven by the checks of WP1-T1, the cross-tenant proof and the tests of @tc/core", () => {
  expect(TASKS["WP1-T2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["cross-tenant", "pnpm test --filter @tc/db test/cross-tenant --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // the filter must keep matching real files
  for (const f of [
    "packages/db/test/cross-tenant.test.ts",
    "packages/db/test/cross-tenant-helper.test.ts",
  ])
    expect(existsSync(f), f).toBe(true);
});

it("task WP3-T1 is proven by the checks of WP1-T1, the files of the ledger by name, the proof and its concurrency test, and the reconciler and repository tests", () => {
  expect(TASKS["WP3-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    [
      "ledger-rules",
      "pnpm test --filter @tc/core ledger/rules ledger/kinds ledger/keys --no-passWithNoTests",
    ],
    [
      "ledger-engine",
      "pnpm test --filter @tc/core ledger/accounts ledger/balance ledger/post.test ledger/reverse ledger/check ledger/nightly --no-passWithNoTests",
    ],
    ["ledger-proof", "pnpm test --filter @tc/core ledger/proof --no-passWithNoTests"],
    [
      "ledger-concurrency",
      "pnpm test --filter @tc/core ledger/post-concurrency --no-passWithNoTests",
    ],
    ["reconciler", "pnpm test --filter @tc/fn-reconciler --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on: the filters must keep matching real files
  for (const f of [
    "packages/core/ledger/rules.test.ts",
    "packages/core/ledger/kinds.test.ts",
    "packages/core/ledger/keys.test.ts",
    "packages/core/ledger/accounts.test.ts",
    "packages/core/ledger/balance.test.ts",
    "packages/core/ledger/post.test.ts",
    "packages/core/ledger/reverse.test.ts",
    "packages/core/ledger/check.test.ts",
    "packages/core/ledger/nightly.test.ts",
    "packages/core/ledger/proof.test.ts",
    "packages/core/ledger/post-concurrency.test.ts",
    "tests/repo/ledger-writers.test.mjs",
  ]) {
    expect(existsSync(f), f).toBe(true);
  }
});

it("task WP3-T2 is proven by the checks of WP1-T1, core, db, the EPS suite, the proof on its own line, the tenancy tests and the repository tests", () => {
  expect(TASKS["WP3-T2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["eps", "pnpm test --filter @tc/eps --no-passWithNoTests"],
    [
      "eps-credits-nothing-extra",
      "pnpm test --filter @tc/eps test/proof-credits-nothing-extra --no-passWithNoTests",
    ],
    [
      "eps-tenancy",
      "pnpm test --filter @tc/db test/payments-repo test/payments-system test/cross-tenant --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WP3-T2"].find((c) => c.id === "eps-credits-nothing-extra").title).toBe(
    "WP3-T2: replay, forged success URL, amount mismatch and double callback credit nothing extra",
  );
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "packages/eps/test/proof-credits-nothing-extra.test.ts",
    "packages/db/test/payments-repo.test.ts",
    "packages/db/test/payments-system.test.ts",
    "packages/db/test/cross-tenant.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP3-T4 is proven by the shared checks, one test line for each layer, the build check and the Playwright run", () => {
  expect(TASKS["WP3-T4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["wallet-amount", "pnpm test --filter @tc/core topup-amount --no-passWithNoTests"],
    ["wallet-db", "pnpm test --filter @tc/db wallet-repo cross-tenant --no-passWithNoTests"],
    ["wallet-eps", "pnpm test --filter @tc/eps recheck redirect --no-passWithNoTests"],
    ["wallet-web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
    ["wallet-build", "node scripts/smoke-apps.mjs --app web"],
    ["wallet-e2e", "node scripts/smoke-wallet.mjs"],
  ]);
  expect(TASKS["WP3-T4"].find((c) => c.id === "wallet-e2e").title).toBe(
    "WP3-T4: Playwright against fakes shows the balance after a faked EPS success",
  );
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "packages/core/validation/topup-amount.test.ts",
    "packages/db/test/wallet-repo.test.ts",
    "packages/db/test/cross-tenant.test.ts",
    "packages/eps/test/recheck.test.ts",
    "packages/eps/test/redirect.test.ts",
    "apps/web/app/[locale]/(panel)/wallet/topup/actions.test.ts",
    "apps/web/app/[locale]/(panel)/wallet/mockup-anchors.test.tsx",
    "scripts/lib/wallet-checks.test.mjs",
    "scripts/smoke-wallet.mjs",
    "tests/e2e/wallet.spec.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP3-T5 is proven by the shared checks, the core and db suites and the invoice-renderer suite", () => {
  expect(TASKS["WP3-T5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["invoice-renderer", "pnpm test --filter @tc/fn-invoice-renderer --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "functions/invoice-renderer/handler.test.ts",
    "functions/invoice-renderer/boundaries.test.ts",
    "packages/core/invoices/invoices.test.ts",
    "packages/core/invoices/render.test.ts",
    "packages/db/test/invoices-repo.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP3-T3 is proven by the checks of WP3-T2, the sweeper suite and the proof on its own line", () => {
  expect(TASKS["WP3-T3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["eps", "pnpm test --filter @tc/eps --no-passWithNoTests"],
    ["payments-sweeper", "pnpm test --filter @tc/fn-payments-sweeper --no-passWithNoTests"],
    [
      "payments-sweeper-credits-once",
      "pnpm test --filter @tc/fn-payments-sweeper test/proof-sweeper --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WP3-T3"].find((c) => c.id === "payments-sweeper-credits-once").title).toBe(
    "WP3-T3: a payment whose browser never returned is credited by the sweeper once; old ones expire",
  );
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "functions/payments-sweeper/test/proof-sweeper.test.ts",
    "functions/payments-sweeper/handler.test.ts",
    "functions/payments-sweeper/boundaries.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP8-T1 is proven by the db, auth, admin and core suites and three proof lines of the backlog sentence", () => {
  expect(TASKS["WP8-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    [
      "admin-audited-active-actor",
      "pnpm test --filter @tc/db admin-audited-active admin-repos admin-operations --no-passWithNoTests",
    ],
    ["auth", "pnpm test --filter @tc/auth --no-passWithNoTests"],
    [
      "admin-no-mfa-no-sign-in",
      "pnpm test --filter @tc/auth test/admin-signin test/admin.test --no-passWithNoTests",
    ],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    [
      "admin-outside-allowlist-403",
      "pnpm test --filter @tc/admin proxy.test server/gate route.test --no-passWithNoTests",
    ],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "packages/auth/test/admin-signin.test.ts",
    "packages/auth/test/admin.test.ts",
    "apps/admin/proxy.test.ts",
    "apps/admin/server/gate.test.ts",
    "apps/admin/app/api/csp-report/route.test.ts",
    "packages/db/test/admin-audited-active.test.ts",
    "packages/db/test/admin-repos.test.ts",
    "packages/db/test/admin-operations.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP8-T2 is proven by the db and admin suites and the line of the KYC document sentence", () => {
  expect(TASKS["WP8-T2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["admin-customers-repo", "pnpm test --filter @tc/db admin-customers --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    [
      "kyc-document-short-lived-never-cached",
      "pnpm test --filter @tc/admin server/kyc-documents --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "packages/db/test/admin-customers.test.ts",
    "apps/admin/server/kyc-documents.test.ts",
    "apps/admin/customers-pages.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP8-T3 is proven by the db, core and admin suites and the line of the second-approval sentence", () => {
  expect(TASKS["WP8-T3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    [
      "adjustment-above-limit-waits-for-second-admin",
      "pnpm test --filter @tc/db admin-wallets --no-passWithNoTests",
    ],
    [
      "admin-money-repos",
      "pnpm test --filter @tc/db admin-payments admin-repos --no-passWithNoTests",
    ],
    [
      "admin-money-ledger-invariant",
      "pnpm test --filter @tc/core test/admin-money --no-passWithNoTests",
    ],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "packages/db/test/admin-wallets.test.ts",
    "packages/db/test/admin-payments.test.ts",
    "packages/db/test/admin-repos.test.ts",
    "packages/core/test/admin-money.db.test.ts",
    "apps/admin/money-pages.test.tsx",
    "apps/admin/server/money-flow.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP8-T4 is proven by the admin suite, the preview-first line, the two-person FX line and the catalog read", () => {
  expect(TASKS["WP8-T4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["catalog-admin-read", "pnpm test --filter @tc/db catalog-admin-list --no-passWithNoTests"],
    ["fx-second-admin", "pnpm test --filter @tc/db admin-fx-changes --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    [
      "pricing-preview-before-save",
      "pnpm test --filter @tc/admin pricing-pages pricing-flow --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/db/test/admin-fx-changes.test.ts",
    "packages/db/test/catalog-admin-list.test.ts",
    "apps/admin/pricing-pages.test.tsx",
    "apps/admin/server/pricing-flow.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP8-T5 is proven by the db read and decision suites and the admin flow and screen suites", () => {
  expect(TASKS["WP8-T5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    [
      "admin-ops-repos",
      "pnpm test --filter @tc/db admin-ops-reads admin-operations operation-approval --no-passWithNoTests",
    ],
    [
      "admin-ops-app",
      "pnpm test --filter @tc/admin ops-map ops-flow capacity-flow ops-pages ops-messages --no-passWithNoTests",
    ],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/db/test/admin-ops-reads.test.ts",
    "apps/admin/server/ops-flow.test.ts",
    "apps/admin/ops-pages.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP8-T6 is proven by the db audit and admin-users suites, the completeness test and the admin suite", () => {
  expect(TASKS["WP8-T6"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["every-admin-action-audited", "pnpm test --filter @tc/db admin-repos --no-passWithNoTests"],
    ["admin-users-rules", "pnpm test --filter @tc/db admin-users --no-passWithNoTests"],
    ["audit-read-only-masked", "pnpm test --filter @tc/db admin-audit.test --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/db/test/admin-repos.test.ts",
    "packages/db/test/admin-users.test.ts",
    "packages/db/test/admin-audit.test.ts",
    "apps/admin/audit-admins-pages.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP8-T7 is proven by the db case suites and the admin flow, screen and message suites", () => {
  expect(TASKS["WP8-T7"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    [
      "admin-case-repos",
      "pnpm test --filter @tc/db admin-support admin-abuse admin-reconciliation reconciliation-details admin-repos --no-passWithNoTests",
    ],
    [
      "admin-case-app",
      "pnpm test --filter @tc/admin case-flows cases-pages cases-messages --no-passWithNoTests",
    ],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/db/test/admin-support.test.ts",
    "packages/db/test/admin-abuse.test.ts",
    "packages/db/test/admin-reconciliation.test.ts",
    "apps/admin/server/case-flows.test.ts",
    "apps/admin/cases-pages.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP2-T1 is proven by the checks of WP1-T1, the db suite, the tests of @tc/auth and the repository tests", () => {
  expect(TASKS["WP2-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["auth", "pnpm test --filter @tc/auth --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of ["packages/auth/test/request.test.ts", "tests/repo/auth-boundaries.test.mjs"]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP5-T3 is proven by the db, core and aws suites, the reader suite and the cross-tenant proof on its own line", () => {
  expect(TASKS["WP5-T3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["reader", "pnpm test --filter @tc/fn-reader --no-passWithNoTests"],
    [
      "reader-cross-tenant",
      "pnpm test --filter @tc/fn-reader test/proof-cross-tenant --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WP5-T3"].find((c) => c.id === "reader-cross-tenant").title).toBe(
    "WP5-T3: customer A cannot read customer B's metrics",
  );
  // passWithNoTests is on: the filter must keep matching a real file
  for (const f of [
    "functions/reader/test/proof-cross-tenant.test.ts",
    "functions/reader/handler.test.ts",
    "packages/db/test/operation-reader.test.ts",
    "packages/aws/test/reader-source.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP5-T4 is proven by the same checks as WP4-T2: the lifecycle scenario runs in core, the handler in scheduler, the purge in db", () => {
  expect(TASKS["WP5-T4"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "db",
    "core",
    "aws",
    "provisioner",
    "scheduler",
    "repo",
  ]);
  expect(TASKS["WP5-T4"].find((c) => c.id === "core").command.join(" ")).toBe(
    "pnpm test --filter @tc/core --no-passWithNoTests",
  );
  expect(TASKS["WP5-T4"].find((c) => c.id === "scheduler").command.join(" ")).toBe(
    "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests",
  );
});

it("task WP7-T3 is proven by lint, types, format, the core and aws tests and the repository tests", () => {
  expect(TASKS["WP7-T3"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "core",
    "aws",
    "repo",
  ]);
});

it("task WP7-T5 is proven by lint, types, format, the db, core and scheduler tests and the repository tests", () => {
  expect(TASKS["WP7-T5"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "db",
    "core",
    "scheduler",
    "repo",
  ]);
});

it("task WP7-T6 is proven by lint, types, format, the db, core and reconciler tests and the repository tests", () => {
  expect(TASKS["WP7-T6"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "db",
    "core",
    "reconciler",
    "repo",
  ]);
});

it("task WP4-T2 is proven by the checks of WP1-T1, the tests of core, aws and the two functions, and the repository tests", () => {
  expect(TASKS["WP4-T2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["provisioner", "pnpm test --filter @tc/fn-provisioner --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on: the filters must keep matching real files
  // paths are built from the location of this file, so they hold whatever the working directory of Vitest is
  for (const f of [
    "functions/provisioner/test/scenario.test.ts",
    "functions/provisioner/step-failures.test.ts",
    "functions/provisioner/reject.test.ts",
    "functions/scheduler/handler.test.ts",
    "packages/db/test/operation-insert.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP1-T5 is proven by the suites of core, db, aws, the catalog-sync function and its proof on its own line", () => {
  expect(TASKS["WP1-T5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["catalog-sync", "pnpm test --filter @tc/fn-catalog-sync --no-passWithNoTests"],
    [
      "catalog-sync-proof",
      "pnpm test --filter @tc/fn-catalog-sync test/proof-catalog --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // The proof covers the instance half only: the title must not claim loaded TLD prices (not proven).
  expect(TASKS["WP1-T5"].find((c) => c.id === "catalog-sync-proof").title).toBe(
    "WP1-T5: catalog holds plans with BDT prices; no active instance plan is IPv6-only; TLD prices not proven (skipped)",
  );
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "functions/catalog-sync/test/proof-catalog.test.ts",
    "packages/core/products/catalog-sync.test.ts",
    "packages/aws/test/catalog.test.ts",
    "packages/db/test/catalog-sync.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP1-T4 is proven by the checks of WP1-T1, the two halves of the backlog proof and the tests of @tc/core", () => {
  expect(TASKS["WP1-T4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["stored-order", "pnpm test --filter @tc/core rates/stored-order --no-passWithNoTests"],
    [
      "preview",
      "pnpm test --filter @tc/core pricing/preview rates/preview-equals-engine --no-passWithNoTests",
    ],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on: the filters must keep matching real files
  for (const f of [
    "packages/core/rates/stored-order.test.ts",
    "packages/core/pricing/preview.test.ts",
    "packages/core/rates/preview-equals-engine.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP2-T2 is proven by the checks of WP1-T1, the core, db, auth, notify and web suites, the two lines of the proof and the repository tests", () => {
  expect(TASKS["WP2-T2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["auth", "pnpm test --filter @tc/auth --no-passWithNoTests"],
    ["notify-otp", "pnpm test --filter @tc/notify --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["auth-pages", "pnpm test --filter @tc/web server/auth auth-pages --no-passWithNoTests"],
    ["auth-smoke", "node scripts/smoke-auth.mjs"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WP2-T2"].find((c) => c.id === "auth-smoke").timeoutMs).toBe(1_800_000);
  // passWithNoTests is on in vitest.config.mjs: the filters must keep matching real files
  for (const f of [
    "packages/core/validation/auth-forms.test.ts",
    "packages/db/test/registration.test.ts",
    "packages/auth/test/identity-cognito.test.ts",
    "packages/auth/test/sign-in.test.ts",
    "apps/web/server/auth/enumeration.test.ts",
    "apps/web/server/auth/forged-forwarded-for.test.ts",
    "apps/web/server/auth/order.test.ts",
    "apps/web/app/[locale]/(auth)/auth-pages.test.tsx",
    "tests/e2e/auth.spec.ts",
    "scripts/smoke-auth.mjs",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP2-T3 is proven by the checks of WP1-T1, the tests of core, db and notify, and the two lines of the proof", () => {
  expect(TASKS["WP2-T3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["notify-otp", "pnpm test --filter @tc/notify --no-passWithNoTests"],
    ["otp-limits", "pnpm test --filter @tc/notify test/otp-limits --no-passWithNoTests"],
    [
      "otp-tenancy",
      "pnpm test --filter @tc/db test/rate-limit test/otp-repo test/cross-tenant --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // the filters must keep matching real files
  for (const f of [
    "packages/notify/test/otp-limits.test.ts",
    "packages/db/test/rate-limit.test.ts",
    "packages/db/test/rate-limit-tenancy.test.ts",
    "packages/db/test/otp-repo.test.ts",
    "packages/db/test/cross-tenant.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP2-T4 is proven by the checks of WP1-T1, core, db and web, and four lines of the proof", () => {
  expect(TASKS["WP2-T4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["kyc-rules", "pnpm test --filter @tc/core kyc/rules --no-passWithNoTests"],
    [
      "kyc-web-role",
      "pnpm test --filter @tc/db test/kyc-repo test/cross-tenant --no-passWithNoTests",
    ],
    [
      "kyc-actions",
      "pnpm test --filter @tc/web server/kyc-actions server/kyc-view kyc/ --no-passWithNoTests",
    ],
    ["kyc-seed", "pnpm test scripts/lib/seed-kyc-verified.test.mjs --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/core/kyc/rules.test.ts",
    "packages/db/test/kyc-repo.test.ts",
    "packages/db/test/cross-tenant.test.ts",
    "apps/web/server/kyc-actions.test.ts",
    "apps/web/server/kyc-view.test.ts",
    "scripts/lib/seed-kyc-verified.test.mjs",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP2-T5 is proven by the checks of WP1-T1, db and web, and the lines of the proof", () => {
  expect(TASKS["WP2-T5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    [
      "settings-profile-repo",
      "pnpm test --filter @tc/db test/profile-email test/cross-tenant --no-passWithNoTests",
    ],
    [
      "settings-fresh-sign-in",
      "pnpm test --filter @tc/web server/settings-actions --no-passWithNoTests",
    ],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/db/test/profile-email.test.ts",
    "apps/web/server/settings-actions.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP4-T3 is proven by the checks of WP1-T1, the race for the last slot on its own line and the tests of @tc/core", () => {
  expect(TASKS["WP4-T3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    ["capacity-race", "pnpm test --filter @tc/core capacity/race"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on: the filter must keep matching a real file
  expect(
    existsSync(resolve(import.meta.dirname, "../..", "packages/core/capacity/race.test.ts")),
  ).toBe(true);
});

it("task WP4-T5 is proven by the adapter, bootstrap and isolation tests, each filter naming a real file", () => {
  expect(TASKS["WP4-T5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["linux-adapter", "pnpm test --filter @tc/aws linux-instance --no-passWithNoTests"],
    ["bootstrap-firewall", "pnpm test --filter @tc/aws bootstrap --no-passWithNoTests"],
    ["isolation-local", "pnpm test --filter isolation --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/aws/test/linux-instance.test.ts",
    "packages/aws/test/bootstrap.test.ts",
    "tests/isolation/plan.test.ts",
    "tests/isolation/isolation.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP4-T7 is proven by the action, page, anchor and smoke tests, each filter naming a real file", () => {
  expect(TASKS["WP4-T7"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["server-action-cores", "pnpm test --filter @tc/web server/order-actions --no-passWithNoTests"],
    ["server-key-actions", "pnpm test --filter @tc/web server/key-actions --no-passWithNoTests"],
    ["server-pages", "pnpm test --filter @tc/web servers/pages --no-passWithNoTests"],
    [
      "server-mockup-anchors",
      "pnpm test --filter @tc/web servers/mockup-anchors --no-passWithNoTests",
    ],
    ["server-smoke-blocked", "pnpm test --filter repo servers-smoke --no-passWithNoTests"],
    ["catalog-list", "pnpm test --filter @tc/db catalog-repo --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "apps/web/server/order-actions.test.ts",
    "apps/web/server/key-actions.test.ts",
    "apps/web/app/[locale]/(panel)/servers/pages.test.tsx",
    "apps/web/app/[locale]/(panel)/servers/mockup-anchors.test.tsx",
    "tests/repo/servers-smoke.test.mjs",
    "packages/db/test/catalog-repo.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("tasks WP5-T1 and WP5-T2 are proven by the adapter, row and wiring tests, each filter naming a real file", () => {
  expect(TASKS["WP5-T1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["backup-adapter", "pnpm test --filter @tc/aws backup --no-passWithNoTests"],
    ["backup-rows", "pnpm test --filter @tc/db backups-repo --no-passWithNoTests"],
    ["backup-wiring", "pnpm test --filter @tc/fn-provisioner backup --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  expect(TASKS["WP5-T2"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "disk-adapter",
    "backup-rows",
    "backup-wiring",
    "aws",
    "repo",
  ]);
  for (const f of [
    "packages/aws/test/backup.test.ts",
    "packages/aws/test/disk.test.ts",
    "packages/db/test/backups-repo.test.ts",
    "functions/provisioner/backup.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("tasks WPP-T1 to WPP-T4 are proven by the shared checks and the public-site tests, and the filters match real files", () => {
  const ids = (task) => TASKS[task].map((c) => c.id);
  expect(ids("WPP-T1")).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "wpp-catalog",
    "wpp-pages",
    "wpp-mockup-anchors",
    "wpp-messages",
    "repo",
  ]);
  expect(ids("WPP-T2")).toContain("wpp-pages");
  expect(ids("WPP-T3")).toContain("wpp-seo");
  expect(ids("WPP-T4")).toEqual(
    expect.arrayContaining(["wpp-notify-me", "wpp-visitor-waitlist", "wpp-pages"]),
  );
  expect(TASKS["WPP-T3"].find((c) => c.id === "wpp-seo").command.join(" ")).toBe(
    "pnpm test --filter @tc/web server/public/seo server/public/sitemap proxy-indexing pages.test --no-passWithNoTests",
  );
  for (const f of [
    "apps/web/server/public/catalog.test.ts",
    "apps/web/server/public/seo.test.ts",
    "apps/web/server/public/sitemap.test.ts",
    "apps/web/server/public/notify-me.test.ts",
    "apps/web/proxy-indexing.test.ts",
    "apps/web/pages.test.tsx",
    "apps/web/server/endpoint-sweep.test.ts",
    "apps/web/messages/public-messages.test.ts",
    "apps/web/app/[locale]/(public)/public-pages.test.tsx",
    "apps/web/app/[locale]/(public)/public-anchors.test.tsx",
    "packages/db/test/visitor-waitlist.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP5-T6 is proven by the shared checks, core, db, the cross-tenant test, the Destroy proof, the screens, the anchors and the messages", () => {
  expect(TASKS["WP5-T6"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["cross-tenant", "pnpm test --filter @tc/db test/cross-tenant --no-passWithNoTests"],
    ["extras-cores", "pnpm test --filter @tc/web server/extras-actions --no-passWithNoTests"],
    ["extras-guard", "pnpm test --filter @tc/core lifecycle/guard --no-passWithNoTests"],
    ["extras-repos", "pnpm test --filter @tc/db extras-repos --no-passWithNoTests"],
    ["extras-views", "pnpm test --filter @tc/web server/extras-view --no-passWithNoTests"],
    ["extras-pages", "pnpm test --filter @tc/web _extras/pages --no-passWithNoTests"],
    [
      "extras-mockup-anchors",
      "pnpm test --filter @tc/web _extras/mockup-anchors --no-passWithNoTests",
    ],
    ["extras-messages", "pnpm test --filter @tc/web messages/extras --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // the filters must keep matching real files
  for (const f of [
    "apps/web/server/extras-actions.test.ts",
    "apps/web/server/extras-view.test.ts",
    "apps/web/app/[locale]/(panel)/_extras/pages.test.tsx",
    "apps/web/app/[locale]/(panel)/_extras/mockup-anchors.test.tsx",
    "apps/web/messages/extras-messages.test.ts",
    "packages/db/test/extras-repos.test.ts",
    "packages/core/lifecycle/guard.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP5-T6b is proven by core, the renewal and restore database tests, the action cores, the screens and the sweep", () => {
  expect(TASKS["WP5-T6b"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["renew-now", "pnpm test --filter @tc/core lifecycle/renew-now --no-passWithNoTests"],
    ["restore-order", "pnpm test --filter @tc/core restore --no-passWithNoTests"],
    [
      "order-kinds-cores",
      "pnpm test --filter @tc/web server/extras-actions server/order-actions --no-passWithNoTests",
    ],
    ["extras-pages", "pnpm test --filter @tc/web _extras/pages --no-passWithNoTests"],
    [
      "extras-mockup-anchors",
      "pnpm test --filter @tc/web _extras/mockup-anchors --no-passWithNoTests",
    ],
    ["extras-messages", "pnpm test --filter @tc/web messages/extras --no-passWithNoTests"],
    ["order-kinds-sweep", "pnpm test --filter @tc/web server/endpoint-sweep --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/core/lifecycle/renew-now.db.test.ts",
    "packages/core/orders/restore-order.test.ts",
    "packages/core/products/restore.test.ts",
    "apps/web/server/extras-actions.test.ts",
    "apps/web/server/order-actions.test.ts",
    "apps/web/server/endpoint-sweep.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WPA-P1 is proven by the engine, the rates, the db and the admin suites of the price list, and every filter matches a real file", () => {
  expect(TASKS["WPA-P1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    [
      "price-book-engine",
      "pnpm test --filter @tc/core pricing/book pricing/quote --no-passWithNoTests",
    ],
    [
      "price-book-rates",
      "pnpm test --filter @tc/core rates/price-book-in-force rates/preview-book --no-passWithNoTests",
    ],
    [
      "price-book-db",
      "pnpm test --filter @tc/db admin-price-book admin-gates admin-repos --no-passWithNoTests",
    ],
    [
      "price-book-admin",
      "pnpm test --filter @tc/admin server/price-book-flow server/price-book-draft price-book-pages price-book-messages server/admin-sweep --no-passWithNoTests",
    ],
    ["db", "pnpm test --filter @tc/db"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/core/pricing/book.test.ts",
    "packages/core/rates/price-book-in-force.test.ts",
    "packages/core/rates/preview-book.test.ts",
    "packages/db/test/admin-price-book.test.ts",
    "packages/db/test/admin-gates.test.ts",
    "packages/db/migrations/0010_admin_price_book.sql",
    "apps/admin/server/price-book-flow.test.ts",
    "apps/admin/server/price-book-draft.test.ts",
    "apps/admin/price-book-pages.test.tsx",
    "apps/admin/price-book-messages.test.ts",
    "apps/admin/server/admin-sweep.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WPA-P2 is proven by the db, aws, admin, order and metering suites of the plan state and the config prices, and every filter matches a real file", () => {
  expect(TASKS["WPA-P2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    [
      "plan-mark-db",
      "pnpm test --filter @tc/db admin-plan-mark admin-gates operation-kinds --no-passWithNoTests",
    ],
    [
      "plan-mark-aws",
      "pnpm test --filter @tc/aws container-service cdn adapter-types --no-passWithNoTests",
    ],
    [
      "plan-mark-admin",
      "pnpm test --filter @tc/admin server/plan-mark-flow plan-change-pages plan-change-messages server/admin-sweep server/wpu-g10-data --no-passWithNoTests",
    ],
    [
      "config-price-orders",
      "pnpm test --filter @tc/core products/config-price-source orders/config-price-families orders/disk-order --no-passWithNoTests",
    ],
    [
      "snapshot-metering",
      "pnpm test --filter @tc/core metering products/snapshot-price --no-passWithNoTests",
    ],
    ["db", "pnpm test --filter @tc/db"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["aws", "pnpm test --filter @tc/aws --no-passWithNoTests"],
    ["admin", "pnpm test --filter @tc/admin --no-passWithNoTests"],
    ["scheduler", "pnpm test --filter @tc/fn-scheduler --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/db/test/admin-plan-mark.test.ts",
    "packages/db/test/admin-gates.test.ts",
    "packages/db/test/operation-kinds.test.ts",
    "packages/aws/test/container-service.test.ts",
    "packages/aws/test/cdn.test.ts",
    "packages/aws/test/adapter-types.test.ts",
    "apps/admin/server/plan-mark-flow.test.ts",
    "apps/admin/plan-change-pages.test.tsx",
    "apps/admin/plan-change-messages.test.ts",
    "apps/admin/server/admin-sweep.test.ts",
    "apps/admin/server/wpu-g10-data.test.ts",
    "packages/core/products/config-price-source.test.ts",
    "packages/core/orders/config-price-families.test.ts",
    "packages/core/orders/disk-order.test.ts",
    "packages/core/metering/run.test.ts",
    "packages/core/metering/metering.db.test.ts",
    "packages/core/products/snapshot-price.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP5-T6c is proven by core, the disk order and the catalog guard in core and db, the action core, the offer, the order links and the sweep", () => {
  expect(TASKS["WP5-T6c"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["disk-products", "pnpm test --filter @tc/core products/disk --no-passWithNoTests"],
    ["disk-order", "pnpm test --filter @tc/core orders/disk-order --no-passWithNoTests"],
    [
      "disk-catalog-guard",
      "pnpm test --filter @tc/core products/catalog-sync --no-passWithNoTests",
    ],
    ["disk-catalog-write", "pnpm test --filter @tc/db test/catalog-sync --no-passWithNoTests"],
    ["disk-cores", "pnpm test --filter @tc/web server/disk-actions --no-passWithNoTests"],
    ["disk-views", "pnpm test --filter @tc/web server/extras-view --no-passWithNoTests"],
    ["disk-order-links", "pnpm test --filter @tc/web orders/family-links --no-passWithNoTests"],
    ["extras-pages", "pnpm test --filter @tc/web _extras/pages --no-passWithNoTests"],
    ["extras-messages", "pnpm test --filter @tc/web messages/extras --no-passWithNoTests"],
    ["order-kinds-sweep", "pnpm test --filter @tc/web server/endpoint-sweep --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/core/products/disk.test.ts",
    "packages/core/orders/disk-order.test.ts",
    "packages/core/products/catalog-sync.test.ts",
    "packages/db/test/catalog-sync.test.ts",
    "packages/db/migrations/0008_disk_anchor.sql",
    "apps/web/server/disk-actions.test.ts",
    "apps/web/server/extras-view.test.ts",
    "apps/web/server/endpoint-sweep.test.ts",
    "apps/web/app/[locale]/(panel)/orders/family-links.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP5-T5 is proven by the shared checks, core, db, notify, the two sentences of the proof and the notifier handler", () => {
  expect(TASKS["WP5-T5"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["db", "pnpm test --filter @tc/db"],
    ["notify", "pnpm test --filter @tc/notify --no-passWithNoTests"],
    [
      "triggers-send-once",
      "pnpm test --filter @tc/notify test/run.test test/trigger-map --no-passWithNoTests",
    ],
    [
      "no-secret",
      "pnpm test --filter @tc/notify test/guards test/templates test/notify.test --no-passWithNoTests",
    ],
    ["notifier-fn", "pnpm test --filter @tc/fn-notifier --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // the filters must keep matching real files
  for (const f of [
    "packages/notify/test/run.test.ts",
    "packages/notify/test/trigger-map.test.ts",
    "packages/notify/test/guards.test.ts",
    "packages/notify/test/templates.test.ts",
    "packages/notify/test/notify.test.ts",
    "functions/notifier/handler.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP6-T1 is proven by the Windows adapter, the access-details function and the Access tab tests, each naming real files", () => {
  expect(TASKS["WP6-T1"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "windows-adapter",
    "access-details",
    "windows-access-web",
    "aws",
    "repo",
  ]);
  const line = (id) => TASKS["WP6-T1"].find((c) => c.id === id).command.join(" ");
  expect(line("windows-adapter")).toBe("pnpm test --filter @tc/aws windows --no-passWithNoTests");
  expect(line("access-details")).toBe(
    "pnpm test --filter @tc/fn-access-details --no-passWithNoTests",
  );
  for (const f of [
    "packages/aws/test/windows-instance.test.ts",
    "packages/aws/test/windows-access.test.ts",
    "packages/aws/test/bootstrap-windows.test.ts",
    "functions/access-details/handler.test.ts",
    "apps/web/server/windows-access.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP6-T1b is proven by the wiring tests, each naming real files", () => {
  expect(TASKS["WP6-T1b"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "windows-provisioner",
    "windows-order",
    "windows-resolve",
    "windows-detail",
    "repo",
  ]);
  for (const f of [
    "functions/provisioner/windows.test.ts",
    "packages/core/orders/windows-purchase.test.ts",
    "packages/core/products/instance.test.ts",
    "apps/web/server/servers-view-windows.test.ts",
    "apps/web/app/[locale]/(panel)/servers/[id]/windows-access.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("tasks WP6-T4 and WP7-T1 are proven by the adapter tests, each filter naming a real test file", () => {
  const ids = (t) => TASKS[t].map((c) => c.id);
  expect(ids("WP6-T4")).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "operation-kinds",
    "storage-core-rules",
    "bucket-adapter",
    "bucket-secret-once",
    "storage-wiring",
    "aws",
    "repo",
  ]);
  expect(ids("WP7-T1")).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "operation-kinds",
    "storage-core-rules",
    "container-adapter",
    "storage-wiring",
    "aws",
    "repo",
  ]);
  const line = (t, id) => TASKS[t].find((c) => c.id === id).command.join(" ");
  expect(line("WP6-T4", "bucket-secret-once")).toBe(
    "pnpm test --filter @tc/aws bucket-access --no-passWithNoTests",
  );
  expect(line("WP7-T1", "container-adapter")).toBe(
    "pnpm test --filter @tc/aws container-service --no-passWithNoTests",
  );
  for (const f of [
    "packages/aws/test/bucket.test.ts",
    "packages/aws/test/bucket-access.test.ts",
    "packages/aws/test/container-service.test.ts",
    "packages/core/products/bucket.test.ts",
    "packages/core/products/container.test.ts",
    "functions/provisioner/storage-wiring.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP6-T4s is proven by the core and web tests of the bucket and container screens, each filter naming a real test file", () => {
  expect(TASKS["WP6-T4s"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "storage-screens-core",
    "storage-screens-web",
    "repo",
  ]);
  const line = (id) => TASKS["WP6-T4s"].find((c) => c.id === id).command.join(" ");
  expect(line("storage-screens-core")).toBe(
    "pnpm test --filter @tc/core products/bucket-resolve products/container-resolve orders/exports --no-passWithNoTests",
  );
  expect(line("storage-screens-web")).toBe(
    "pnpm test --filter @tc/web bucket container family-screens --no-passWithNoTests",
  );
  for (const f of [
    "packages/core/products/bucket-resolve.test.ts",
    "packages/core/products/container-resolve.test.ts",
    "packages/core/orders/exports.test.ts",
    "apps/web/server/bucket-actions.test.ts",
    "apps/web/server/bucket-keys.test.ts",
    "apps/web/server/bucket-view.test.ts",
    "apps/web/server/container-actions.test.ts",
    "apps/web/server/container-view.test.ts",
    "apps/web/server/family-screens.test.ts",
    "apps/web/messages/bucket-messages.test.ts",
    "apps/web/app/[locale]/(panel)/storage/bucket.test.tsx",
    "apps/web/app/[locale]/(panel)/storage/bucket-anchors.test.tsx",
    "apps/web/app/[locale]/(panel)/containers/container.test.tsx",
    "apps/web/app/[locale]/(panel)/containers/container-anchors.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP7-T4 is proven by the core, adapter, wiring and web tests, each filter naming a real test file", () => {
  expect(TASKS["WP7-T4"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "domain-core",
    "domain-adapter",
    "domain-wiring",
    "domain-web",
    "aws",
    "repo",
  ]);
  const line = (id) => TASKS["WP7-T4"].find((c) => c.id === id).command.join(" ");
  expect(line("domain-adapter")).toBe(
    "pnpm test --filter @tc/aws test/domain.test --no-passWithNoTests",
  );
  for (const f of [
    "packages/core/domains/rules.test.ts",
    "packages/core/orders/domain-purchase.test.ts",
    "packages/aws/test/domain.test.ts",
    "functions/provisioner/domain-wiring.test.ts",
    "apps/web/server/domain-actions.test.ts",
    "apps/web/server/domain-tenancy.test.ts",
    "apps/web/messages/domains-messages.test.ts",
    "apps/web/app/[locale]/(panel)/domains/mockup-anchors.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP7-T2 is proven by the core, adapter, wiring and web tests, each filter naming a real test file", () => {
  expect(TASKS["WP7-T2"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "cdn-core",
    "cdn-adapter",
    "cdn-wiring",
    "cdn-web",
    "aws",
    "repo",
  ]);
  const line = (id) => TASKS["WP7-T2"].find((c) => c.id === id).command.join(" ");
  expect(line("cdn-adapter")).toBe("pnpm test --filter @tc/aws test/cdn.test --no-passWithNoTests");
  expect(line("cdn-wiring")).toBe(
    "pnpm test --filter @tc/fn-provisioner cdn-wiring --no-passWithNoTests",
  );
  for (const f of [
    "packages/aws/test/cdn.test.ts",
    "packages/core/products/cdn.test.ts",
    "packages/core/orders/cdn-origin-ownership.test.ts",
    "functions/provisioner/cdn-wiring.test.ts",
    "apps/web/server/cdn-actions.test.ts",
    "apps/web/server/cdn-view.test.ts",
    "apps/web/messages/cdn-messages.test.ts",
    "apps/web/app/[locale]/(panel)/cdn/cdn.test.tsx",
    "apps/web/app/[locale]/(panel)/cdn/mockup-anchors.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("tasks WP6-T2 and WP6-T3 are proven by the adapter, core and ownership tests, each filter naming a real file", () => {
  expect(TASKS["WP6-T2"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "database-adapter",
    "database-product",
    "aws",
    "repo",
  ]);
  expect(TASKS["WP6-T3"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "load-balancer-adapter",
    "lb-target-rule",
    "lb-target-ownership",
    "aws",
    "repo",
  ]);
  for (const f of [
    "packages/aws/test/database.test.ts",
    "packages/aws/test/load-balancer.test.ts",
    "packages/core/products/database.test.ts",
    "packages/core/products/load-balancer.test.ts",
    "packages/core/orders/lb-target-ownership.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP6-T2s is proven by the cores, the views and the screens of databases and load balancers, each filter naming a real file", () => {
  expect(TASKS["WP6-T2s"].map((c) => c.id)).toEqual([
    "spec-sync",
    "baseline-sync",
    "lint",
    "typecheck",
    "format",
    "db-lb-cores",
    "db-lb-views",
    "db-lb-screens",
    "repo",
  ]);
  const line = (id) => TASKS["WP6-T2s"].find((c) => c.id === id).command.join(" ");
  expect(line("db-lb-cores")).toBe(
    "pnpm test --filter @tc/web family-actions databases-actions databases-access load-balancers-actions --no-passWithNoTests",
  );
  expect(line("db-lb-views")).toBe(
    "pnpm test --filter @tc/web databases-view load-balancers-view --no-passWithNoTests",
  );
  expect(line("db-lb-screens")).toContain("(panel)/databases (panel)/load-balancers");
  for (const f of [
    "apps/web/server/family-actions.test.ts",
    "apps/web/server/databases-actions.test.ts",
    "apps/web/server/databases-access.test.ts",
    "apps/web/server/databases-view.test.ts",
    "apps/web/server/load-balancers-actions.test.ts",
    "apps/web/server/load-balancers-view.test.ts",
    "apps/web/messages/databases-messages.test.ts",
    "apps/web/messages/load-balancers-messages.test.ts",
    "apps/web/app/[locale]/(panel)/databases/databases.test.tsx",
    "apps/web/app/[locale]/(panel)/databases/mockup-anchors.test.tsx",
    "apps/web/app/[locale]/(panel)/load-balancers/load-balancers.test.tsx",
    "apps/web/app/[locale]/(panel)/load-balancers/mockup-anchors.test.tsx",
    "apps/web/app/[locale]/(panel)/orders/family-links.test.tsx",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP4-T4 is proven by the shared checks, the db suite, and the three sentences of the proof", () => {
  expect(TASKS["WP4-T4"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["db", "pnpm test --filter @tc/db"],
    [
      "orders-double-submit",
      "pnpm test --filter @tc/core orders/double-submit --no-passWithNoTests",
    ],
    [
      "orders-failed-create",
      "pnpm test --filter @tc/core orders/failed-create --no-passWithNoTests",
    ],
    ["orders-kyc-gate", "pnpm test --filter @tc/core orders/kyc-gate --no-passWithNoTests"],
    ["core", "pnpm test --filter @tc/core --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  // passWithNoTests is on in some filters: every proof filter must keep matching a real file
  for (const f of [
    "packages/core/orders/double-submit.test.ts",
    "packages/core/orders/failed-create.test.ts",
    "packages/core/orders/kyc-gate.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP9-T2 is proven by the customer and admin repository sweeps, the admin source scan and the web register", () => {
  expect(TASKS["WP9-T2"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["sweep-customer-repos", "pnpm test --filter @tc/db test/cross-tenant --no-passWithNoTests"],
    ["sweep-admin-repos", "pnpm test --filter @tc/db admin-gates --no-passWithNoTests"],
    ["sweep-admin-app", "pnpm test --filter @tc/admin admin-sweep --no-passWithNoTests"],
    [
      "sweep-web-endpoints",
      "pnpm test --filter @tc/web endpoint-sweep loaders-tenancy --no-passWithNoTests",
    ],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/db/test/admin-gates.test.ts",
    "apps/admin/server/admin-sweep.test.ts",
    "apps/web/server/endpoint-sweep.test.ts",
    "apps/web/server/endpoint-sweep.cases.ts",
    "apps/web/server/loaders-tenancy.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP9-T3 is proven by the order storm, the parallel top-up and the restore drill (BLOCKED is a failure)", () => {
  expect(TASKS["WP9-T3"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    [
      "purchase-concurrency",
      "pnpm test --filter @tc/core orders/purchase-concurrency --no-passWithNoTests",
    ],
    [
      "topup-parallel-credit",
      "pnpm test --filter @tc/eps proof-parallel-credit --no-passWithNoTests",
    ],
    ["restore-drill-logic", "pnpm test --filter repo restore-drill --no-passWithNoTests"],
    ["restore-drill", "node scripts/restore-drill.mjs --allow-empty"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
  for (const f of [
    "packages/core/orders/purchase-concurrency.test.ts",
    "packages/eps/test/proof-parallel-credit.test.ts",
    "scripts/restore-drill.mjs",
    "scripts/lib/restore-drill.test.mjs",
    "docs/runbooks/restore-drill.md",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("task WP0-T3b is proven by the handler suites, the url test, the infra env test, and runs no deploy", () => {
  const commands = TASKS["WP0-T3b"].map((c) => c.command.join(" "));
  expect(commands).toEqual(
    expect.arrayContaining([
      "pnpm test --filter @tc/db test/database-url --no-passWithNoTests",
      "pnpm test --filter @tc/fn-migrator --no-passWithNoTests",
      "pnpm test --filter @tc/fn-notifier --no-passWithNoTests",
      "pnpm test --filter @tc/fn-cognito-messages --no-passWithNoTests",
      "pnpm test --filter @tc/notify test/cognito --no-passWithNoTests",
      "pnpm test --filter repo infra-lib --no-passWithNoTests",
      "pnpm test --filter repo infra-rules --no-passWithNoTests",
    ]),
  );
  expect(commands.join("\n")).not.toMatch(/\bsst\b/);
  // a filter that names a file must name one that exists (passWithNoTests could hide a typo)
  for (const f of [
    "packages/db/test/database-url.test.ts",
    "packages/notify/test/cognito.test.ts",
  ]) {
    expect(existsSync(resolve(import.meta.dirname, "../..", f)), f).toBe(true);
  }
});

it("tasks WP0-T2, WP0-T3 and WP0-T4 are proven by the infra tests, and no check runs a deploy", () => {
  for (const id of ["WP0-T2", "WP0-T3", "WP0-T4"]) {
    const commands = TASKS[id].map((c) => c.command.join(" "));
    expect(commands, id).toEqual(
      expect.arrayContaining([
        "pnpm test --filter repo infra-lib --no-passWithNoTests",
        "pnpm test --filter repo infra-rules --no-passWithNoTests",
        "pnpm test --filter repo infra-tooling --no-passWithNoTests",
      ]),
    );
    expect(commands.join("\n"), id).not.toMatch(/\bsst\b/);
  }
  for (const f of ["infra-lib", "infra-rules", "infra-tooling"]) {
    expect(existsSync(resolve(import.meta.dirname, `${f}.test.mjs`)), f).toBe(true);
  }
});

it("task WP0-T6 is proven by the ci-deploy test and runs no deploy", () => {
  const commands = TASKS["WP0-T6"].map((c) => c.command.join(" "));
  expect(commands).toContain("pnpm test --filter repo ci-deploy --no-passWithNoTests");
  expect(commands.join("\n")).not.toMatch(/\bsst\b|\baws\b/);
  expect(existsSync(resolve(import.meta.dirname, "ci-deploy.test.mjs"))).toBe(true);
});

const GATE_NAMES = ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"];
const manualChecks = (gate) => GATES[gate].filter((c) => c.id.startsWith("manual-"));
const proofIdOf = (check) => check.command[2];
const manualRun = (...args) =>
  spawnSync("node", ["scripts/manual-proof.mjs", ...args], { encoding: "utf8" });
const recordsFile = (content) => {
  const dir = mkdtempSync(join(tmpdir(), "tc-manual-proof-"));
  const file = join(dir, "records.json");
  writeFileSync(file, content);
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
};
const VALID_RECORD = {
  evidence: "Seen on staging by two people, written in JOURNEY.md",
  recordedAt: "2026-11-10T21:05:00+06:00",
  recordedBy: "Moshiur Rahman",
};

it("every gate M0 to M7 has checks", () => {
  expect(Object.keys(GATES).sort()).toEqual(GATE_NAMES);
  for (const gate of GATE_NAMES) expect(GATES[gate].length, gate).toBeGreaterThan(0);
});
it("no gate lists a check id twice, and no check id has two different commands anywhere", () => {
  const commands = new Map();
  for (const gate of GATE_NAMES) {
    const ids = GATES[gate].map((c) => c.id);
    expect(new Set(ids).size, `${gate} lists an id twice`).toBe(ids.length);
  }
  for (const check of [...Object.values(TASKS).flat(), ...Object.values(GATES).flat()]) {
    const command = check.command.join(" ");
    expect(commands.get(check.id) ?? command, check.id).toBe(command);
    commands.set(check.id, command);
  }
});
it("gate M7 holds every check of M0 to M6", () => {
  const ids = new Set(GATES.M7.map((c) => c.id));
  for (const gate of GATE_NAMES.slice(0, 7)) {
    for (const check of GATES[gate]) expect(ids.has(check.id), `${gate}/${check.id}`).toBe(true);
  }
});
it("each gate holds the checks of its tasks (the plan of docs/spec/I-timeline.md)", () => {
  const holds = (gate, tasks) => {
    const ids = new Set(GATES[gate].map((c) => c.id));
    for (const task of tasks) {
      for (const check of TASKS[task])
        expect(ids.has(check.id), `${gate}/${task}/${check.id}`).toBe(true);
    }
  };
  holds("M1", [
    "WP0-T1",
    "WP0-T2",
    "WP0-T3",
    "WP0-T3b",
    "WP0-T4",
    "WP0-T5",
    "WP1-T1",
    "WP1-T2",
    "WP1-T4",
    "WP1-T5",
    "WP2-T1",
    "WP2-T2",
    "WP2-T3",
    "WP2-T4",
    "WP2-T5",
    "WPU-T1",
    "WPU-T2",
    "WPU-T3",
    "WPU-T4",
  ]);
  holds("M2", [
    "WP3-T1",
    "WP3-T2",
    "WP3-T3",
    "WP3-T4",
    "WP3-T5",
    "WP4-T1",
    "WP4-T2",
    "WP4-T3",
    "WP4-T4",
    "WP4-T5",
  ]);
  holds("M3", [
    "WP0-T6",
    "WP4-T7",
    "WP5-T1",
    "WP5-T2",
    "WP5-T3",
    "WP5-T4",
    "WP5-T5",
    "WP5-T6",
    "WP5-T6b",
    "WP5-T6c",
  ]);
  holds("M4", [
    "WP6-T1",
    "WP6-T1b",
    "WP6-T2",
    "WP6-T2s",
    "WP6-T3",
    "WP6-T4",
    "WP6-T4s",
    "WP8-T1",
    "WP8-T2",
    "WP8-T3",
    "WP8-T4",
    "WP8-T5",
    "WP8-T6",
    "WPP-T1",
    "WPP-T2",
    "WPP-T3",
    "WPP-T4",
  ]);
  holds("M5", ["WP7-T1", "WP7-T2", "WP7-T3", "WP7-T4", "WP7-T5", "WP7-T6", "WP8-T7"]);
  holds("M6", ["WP9-T2", "WP9-T3", "WP9-T4", "WP9-T4b", "WP9-T5"]);
  expect(GATES.M1.map((c) => c.id)).toContain("core");
});
it("the production deploy gate M5 holds no proof that a production deploy exists", () => {
  const text = JSON.stringify(GATES.M5);
  expect(text).not.toMatch(/tag-deploy|wp0-t6|wp9-t6|wp10/);
  expect(manualChecks("M3").map(proofIdOf)).toContain("wp0-t6-production-tag-deploy");
  expect(manualChecks("M6").map(proofIdOf)).toContain("wp9-t6-production-tag-deploy");
  expect(readFileSync(".github/workflows/deploy-production.yml", "utf8")).toContain(
    "pnpm verify --gate M5",
  );
});
it("every manual-proof check runs the script on a catalogue id with no extra argument", () => {
  const used = new Set();
  for (const gate of GATE_NAMES) {
    for (const check of manualChecks(gate)) {
      expect(check.command.slice(0, 2), check.id).toEqual(["node", "scripts/manual-proof.mjs"]);
      expect(check.command.length, check.id).toBe(3);
      expect(check.id).toBe(`manual-${proofIdOf(check)}`);
      expect(Object.hasOwn(MANUAL_PROOFS, proofIdOf(check)), check.id).toBe(true);
      used.add(proofIdOf(check));
    }
  }
  // every catalogue entry is used by a gate, and its first gate is the gate that lists it first
  expect([...used].sort()).toEqual(Object.keys(MANUAL_PROOFS).sort());
  for (const [id, entry] of Object.entries(MANUAL_PROOFS)) {
    const first = GATE_NAMES.find((gate) => manualChecks(gate).some((c) => proofIdOf(c) === id));
    expect(entry.gate, id).toBe(first);
    expect(entry.description.length, id).toBeGreaterThan(20);
  }
});
it("verify/manual-proofs.json is committed empty: no gate passes on a recorded proof by default", () => {
  expect(JSON.parse(readFileSync("verify/manual-proofs.json", "utf8"))).toEqual({});
});
it.each(Object.keys(MANUAL_PROOFS))(
  "manual proof %s is BLOCKED (exit 2) with an empty json",
  (id) => {
    const empty = recordsFile("{}");
    try {
      const result = manualRun(id, "--records", empty.file);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("BLOCKED");
      expect(result.stdout).toContain(id);
    } finally {
      empty.remove();
    }
    expect(manualRun(id).status).toBe(2);
  },
);
it.each(Object.keys(MANUAL_PROOFS))("manual proof %s passes only with a valid record", (id) => {
  const valid = recordsFile(JSON.stringify({ [id]: VALID_RECORD }));
  const other = recordsFile(JSON.stringify({ "some-other-id": VALID_RECORD }));
  const broken = recordsFile(JSON.stringify({ [id]: { ...VALID_RECORD, evidence: "ok" } }));
  try {
    const passed = manualRun(id, "--records", valid.file);
    expect(passed.status).toBe(0);
    expect(passed.stdout).not.toContain("BLOCKED");
    expect(manualRun(id, "--records", other.file).status).toBe(2);
    expect(manualRun(id, "--records", broken.file).status).toBe(2);
  } finally {
    valid.remove();
    other.remove();
    broken.remove();
  }
});
it("manual-proof refuses an unknown id, no id, an unreadable file and a file that is not an object", () => {
  const list = recordsFile("[]");
  const bad = recordsFile("{ not json");
  try {
    expect(manualRun("no-such-proof").status).toBe(2);
    expect(manualRun().status).toBe(2);
    expect(
      manualRun("wp0-t2-staging-deploy", "--records", "/nonexistent/records.json").status,
    ).toBe(2);
    expect(manualRun("wp0-t2-staging-deploy", "--records", list.file).status).toBe(2);
    expect(manualRun("wp0-t2-staging-deploy", "--records", bad.file).status).toBe(2);
  } finally {
    list.remove();
    bad.remove();
  }
});
it("a gate with a manual proof and no record fails (BLOCKED is a failure, never a pass)", () => {
  // Run the manual-proof checks of M1 exactly as the gate runs them: each must exit 2.
  for (const check of manualChecks("M1")) {
    expect(spawnSync(check.command[0], check.command.slice(1), { encoding: "utf8" }).status).toBe(
      2,
    );
  }
});

it("task WPU-N1 is proven by lint, types, format, the web and ui tests and the repository tests", () => {
  expect(TASKS["WPU-N1"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["web", "pnpm test --filter @tc/web --no-passWithNoTests"],
    ["ui", "pnpm test --filter @tc/ui"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-N1 exists: the files of the task are in place", () => {
  for (const file of [
    "apps/web/server/invoice-pdf.ts",
    "apps/web/server/renewal-wait.ts",
    "apps/web/server/resource-history.ts",
    "apps/web/server/public/signed-in.ts",
  ]) {
    expect(readFileSync(file, "utf8").length, file).toBeGreaterThan(0);
  }
  expect(readFileSync("apps/web/server/family-actions.ts", "utf8")).toContain("own: {");
});

it("task WPU-M7 is proven by the renderer and migrator tests and the infra tests of both merged sides", () => {
  expect(TASKS["WPU-M7"].map((c) => [c.id, c.command.join(" ")])).toEqual([
    ["spec-sync", "pnpm spec:check"],
    ["baseline-sync", "pnpm baseline:check"],
    ["lint", "pnpm lint"],
    ["typecheck", "pnpm typecheck"],
    ["format", "pnpm format:check"],
    ["invoice-renderer", "pnpm test --filter @tc/fn-invoice-renderer --no-passWithNoTests"],
    ["migrator", "pnpm test --filter @tc/fn-migrator --no-passWithNoTests"],
    ["infra-lib", "pnpm test --filter repo infra-lib --no-passWithNoTests"],
    ["infra-org", "pnpm test --filter repo infra-org --no-passWithNoTests"],
    ["infra-ci-oidc", "pnpm test --filter repo infra-ci-oidc --no-passWithNoTests"],
    ["infra-rules", "pnpm test --filter repo infra-rules --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the proof of WPU-M7 exists: the renderer settings and the provisioner network env live together in workers.ts", () => {
  const workers = readFileSync("infra/stacks/workers.ts", "utf8");
  for (const part of [
    "env.INVOICES_BUCKET = storage.invoices.name;",
    "provisionerNetworkEnvironment(config)",
    "@sparticuz/chromium",
  ]) {
    expect(workers, part).toContain(part);
  }
  expect(JSON.parse(readFileSync("package.json", "utf8")).devDependencies.sst).toBe("4.17.2");
});

// WPU-B4 (audit item 18): TASKS keys for the backlog rows that had none. A manual check is BLOCKED, never a pass.
const rows = (key) => TASKS[key].map((c) => [c.id, c.command.join(" ")]);
const STATIC = [
  ["spec-sync", "pnpm spec:check"],
  ["baseline-sync", "pnpm baseline:check"],
  ["lint", "pnpm lint"],
  ["format", "pnpm format:check"],
];
const TYPED = [STATIC[0], STATIC[1], STATIC[2], ["typecheck", "pnpm typecheck"], STATIC[3]];
const manualRow = (id) => [`manual-${id}`, `node scripts/manual-proof.mjs ${id}`];

it("task WP1-T3 is proven by the pricing tests of packages/core", () => {
  expect(rows("WP1-T3")).toEqual([
    ...TYPED,
    ["pricing", "pnpm test --filter @tc/core pricing --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WP4-T6 is proven by the firewall template and isolation case tests; the real pool is a BLOCKED manual proof", () => {
  expect(rows("WP4-T6")).toEqual([
    ...TYPED,
    ["bootstrap-firewall", "pnpm test --filter @tc/aws bootstrap --no-passWithNoTests"],
    ["isolation-local", "pnpm test --filter isolation --no-passWithNoTests"],
    manualRow("wp4-t6-isolation-pool-dev"),
  ]);
});

it("task WP9-T1 maps Section 15 to its tests and keeps the evidence a manual proof", () => {
  expect(rows("WP9-T1")).toEqual([
    ...STATIC,
    ["section15-local", "pnpm test --filter repo section15-local --no-passWithNoTests"],
    manualRow("wp9-t1-section15-evidence"),
  ]);
});

it("task WP9-T6 is proven by the deploy workflow tests; the deploy and the beta payments are manual proofs", () => {
  expect(rows("WP9-T6")).toEqual([
    ...STATIC,
    ["ci-deploy", "pnpm test --filter repo ci-deploy --no-passWithNoTests"],
    manualRow("wp9-t6-production-tag-deploy"),
    manualRow("wp9-t6-beta-payments"),
  ]);
});

it("task WP10-T2 has only static checks and the manual first-day report", () => {
  expect(rows("WP10-T2")).toEqual([...STATIC, manualRow("wp10-t2-first-day-report")]);
});

it("task WPU-R1 is proven by the zod form schema tests and the tier limit tests", () => {
  expect(rows("WPU-R1")).toEqual([
    ...TYPED,
    [
      "web-zod",
      "pnpm test --filter @tc/web server/form-schema server/disk-actions --no-passWithNoTests",
    ],
    ["tier-limits", "pnpm test --filter @tc/core orders/gates --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("task WPU-B4 is proven by the forward-only and temp-db tests and the repository tests", () => {
  expect(rows("WPU-B4")).toEqual([
    ...TYPED,
    ["db-forward-only", "pnpm test --filter @tc/db test/forward-only --no-passWithNoTests"],
    ["db-temp-db", "pnpm test --filter @tc/db test/temp-db --no-passWithNoTests"],
    ["repo", "pnpm test --filter repo --no-passWithNoTests"],
  ]);
});

it("the manual checks of the new keys exist in the catalogue and are in the gates already", () => {
  const manualIds = ["WP4-T6", "WP9-T1", "WP9-T6", "WP10-T2"]
    .flatMap((key) => TASKS[key])
    .filter((c) => c.id.startsWith("manual-"))
    .map((c) => c.id.slice("manual-".length));
  expect(manualIds).toHaveLength(5);
  for (const id of manualIds) {
    expect(Object.hasOwn(MANUAL_PROOFS, id), id).toBe(true);
    expect(
      GATES.M7.map((c) => c.id),
      id,
    ).toContain(`manual-${id}`);
  }
});
