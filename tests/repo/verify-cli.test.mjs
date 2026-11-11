import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { GATES, TASKS, quickChecks } from "../../verify/checks.mjs";

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
  [["--gate", "M3"], "Gate M3 has no checks yet", "gate-M3"],
  [["--gate", "M9"], "Gate M9 does not exist", "gate-M9"],
  [["--task", "WP10-T2"], "Task WP10-T2 has no proof yet", "task-WP10-T2"],
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
    "WP1-T1",
    "WP1-T2",
    "WP1-T4",
    "WP2-T1",
    "WP2-T3",
    "WP3-T1",
    "WP3-T2",
    "WP4-T1",
    "WP4-T2",
    "WP4-T3",
    "WPU-T1",
    "WPU-T2",
    "WPU-T3",
    "WPU-T4",
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
