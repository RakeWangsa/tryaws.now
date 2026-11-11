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
    "WP1-T5",
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
    "WP4-T7",
    "WP5-T1",
    "WP5-T2",
    "WP5-T3",
    "WP5-T4",
    "WP5-T5",
    "WP5-T6",
    "WP6-T1",
    "WP6-T1b",
    "WP6-T2",
    "WP6-T3",
    "WP6-T4",
    "WP7-T1",
    "WP7-T2",
    "WP7-T3",
    "WP7-T5",
    "WP8-T1",
    "WP8-T2",
    "WP8-T3",
    "WP8-T4",
    "WP8-T5",
    "WP8-T7",
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
