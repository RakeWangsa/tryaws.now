// What `pnpm verify` runs. A gate or task that is not listed here has no proof and fails (R16).
import { resolve } from "node:path";
import { readWorkspacePackages } from "../scripts/lib/changed-packages.mjs";
import { MANUAL_PROOFS } from "./manual-proofs.mjs";

const root = resolve(import.meta.dirname, "..");

const specSync = {
  id: "spec-sync",
  title: "docs/spec matches the plan",
  command: ["pnpm", "spec:check"],
};
const baselineSync = {
  id: "baseline-sync",
  title: "verify/baseline.json matches the plan",
  command: ["pnpm", "baseline:check"],
};
const lint = { id: "lint", title: "ESLint", command: ["pnpm", "lint"] };
const format = { id: "format", title: "Prettier check", command: ["pnpm", "format:check"] };
const typecheck = {
  id: "typecheck",
  title: "TypeScript in every package",
  command: ["pnpm", "typecheck"],
};
const test = { id: "test", title: "Vitest, all projects", command: ["pnpm", "test"] };

// The kit and the CI workflow are proven by the repo tests that `test` runs. "CI green" of
// gate M0 is the result of the pull request itself, not a local check.
const WP0_T1 = [specSync, baselineSync, lint, format, typecheck, test];

const db = {
  id: "db",
  title: "packages/db: schema, constraints, triggers, grants, forward-only",
  command: ["pnpm", "test", "--filter", "@tc/db"],
};
const repo = {
  id: "repo",
  title: "Repository tests",
  command: ["pnpm", "test", "--filter", "repo", "--no-passWithNoTests"],
};

// The proofs aws, core and repo fail when their filter selects no test file: `--no-passWithNoTests`
// overrides passWithNoTests of vitest.config.mjs (which stays true for `verify --quick`, where
// packages without tests exist).
const aws = {
  id: "aws",
  title: "packages/aws: STS, Lightsail clients, error mapping, no network",
  command: ["pnpm", "test", "--filter", "@tc/aws", "--no-passWithNoTests"],
};
const core = {
  id: "core",
  title: "packages/core: pricing and AWS names and tags",
  command: ["pnpm", "test", "--filter", "@tc/core", "--no-passWithNoTests"],
};
// The proof of the backlog row of WP1-T2 on its own line: the cross-tenant test and the tests of its helper.
const crossTenant = {
  id: "cross-tenant",
  title: "R8: customer A cannot read or write the rows of customer B",
  command: ["pnpm", "test", "--filter", "@tc/db", "test/cross-tenant", "--no-passWithNoTests"],
};

const WP1_T1 = [specSync, baselineSync, lint, typecheck, format, db, repo];
const WP4_T1 = [specSync, baselineSync, lint, typecheck, format, aws, core, repo];
const WP1_T2 = [specSync, baselineSync, lint, typecheck, format, db, crossTenant, core, repo];

const ui = {
  id: "ui",
  title: "packages/ui: theme sync, fonts, tc.css and the build-output scan",
  command: ["pnpm", "test", "--filter", "@tc/ui"],
};
const themeImport = {
  id: "theme-import",
  title: "packages/ui/theme/assets is the 16.3 allow-list of the mockup",
  command: ["pnpm", "theme:sync", "--stage", "import", "--check"],
};
const themePublish = {
  id: "theme-publish",
  title: "public/theme of both apps is built from it and holds no file from assets/js",
  command: ["pnpm", "theme:sync", "--stage", "publish"],
};
const WPU_T1 = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  ui,
  themeImport,
  themePublish,
  repo,
];

export const TASKS = {
  "WP0-T1": WP0_T1,
  "WP1-T1": WP1_T1,
  "WP1-T2": WP1_T2,
  "WP4-T1": WP4_T1,
  "WPU-T1": WPU_T1,
};

// WP3-T1: the ledger. The ledger tests are run by file name, so that the report shows the proof of the backlog row on its own lines.
// `--no-passWithNoTests` (as in the checks aws, core and repo above) makes a filter that selects no file fail.
const ledgerRules = {
  id: "ledger-rules",
  title: "WP3-T1: the rules of a posting: shape, kinds, keys",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "ledger/rules",
    "ledger/kinds",
    "ledger/keys",
    "--no-passWithNoTests",
  ],
};
const ledgerEngine = {
  id: "ledger-engine",
  title: "WP3-T1: accounts, postTransaction, reverseTransaction and the nightly check",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "ledger/accounts",
    "ledger/balance",
    "ledger/post.test",
    "ledger/reverse",
    "ledger/check",
    "ledger/nightly",
    "--no-passWithNoTests",
  ],
};
const ledgerProof = {
  id: "ledger-proof",
  title: "WP3-T1: the balance equals the sum of the entries and a wallet never goes negative",
  command: ["pnpm", "test", "--filter", "@tc/core", "ledger/proof", "--no-passWithNoTests"],
};
const ledgerConcurrency = {
  id: "ledger-concurrency",
  title: "WP3-T1: two requests at once and a request interrupted half-way",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "ledger/post-concurrency",
    "--no-passWithNoTests",
  ],
};
const reconciler = {
  id: "reconciler",
  title: "functions/reconciler: the nightly ledger check",
  command: ["pnpm", "test", "--filter", "@tc/fn-reconciler", "--no-passWithNoTests"],
};
const WP3_T1 = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  ledgerRules,
  ledgerEngine,
  ledgerProof,
  ledgerConcurrency,
  reconciler,
  repo,
];
TASKS["WP3-T1"] = WP3_T1;

// WP3-T2: the EPS client and the payment state machine. The sentence of the backlog row (replay, forged
// success URL, amount mismatch, double callback) has its own line; the tenancy tests of the payments
// repositories have another. `--no-passWithNoTests` makes a filter that selects no file fail.
const epsAll = {
  id: "eps",
  title: "packages/eps: gateway, hash, state machine, startTopUp, verifyPayment, returns, sweeper",
  command: ["pnpm", "test", "--filter", "@tc/eps", "--no-passWithNoTests"],
};
const epsProof = {
  id: "eps-credits-nothing-extra",
  title:
    "WP3-T2: replay, forged success URL, amount mismatch and double callback credit nothing extra",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/eps",
    "test/proof-credits-nothing-extra",
    "--no-passWithNoTests",
  ],
};
const epsTenancy = {
  id: "eps-tenancy",
  title: "WP3-T2 R8: the payments repositories are tenant-scoped and the system module is closed",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "test/payments-repo",
    "test/payments-system",
    "test/cross-tenant",
    "--no-passWithNoTests",
  ],
};
const WP3_T2 = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  epsAll,
  epsProof,
  epsTenancy,
  repo,
];
TASKS["WP3-T2"] = WP3_T2;

// WP3-T3: the payments sweeper function. The sentence of the backlog row (a payment whose browser never
// returned is credited by the sweeper once; old ones expire) has its own line. The eps suite stays so
// that a regression in the logic the function relies on fails this task too.
const sweeperAll = {
  id: "payments-sweeper",
  title: "functions/payments-sweeper: handler, config, deps, boundaries, scenarios",
  command: ["pnpm", "test", "--filter", "@tc/fn-payments-sweeper", "--no-passWithNoTests"],
};
const sweeperProof = {
  id: "payments-sweeper-credits-once",
  title:
    "WP3-T3: a payment whose browser never returned is credited by the sweeper once; old ones expire",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/fn-payments-sweeper",
    "test/proof-sweeper",
    "--no-passWithNoTests",
  ],
};
const WP3_T3 = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  epsAll,
  sweeperAll,
  sweeperProof,
  repo,
];
TASKS["WP3-T3"] = WP3_T3;

// WP3-T4: the wallet screens. The sentences of the backlog row (a real top-up credits once and shows the new
// balance; locally Playwright against fakes shows the balance after a faked EPS success) are proven by the
// tests of each layer, the build (routes, no fake in the bundle) and the Playwright run. `--no-passWithNoTests`
// makes a filter that selects no file fail. A check that cannot run (no database, no browser) fails: a
// skipped proof is a failed proof (R16).
const walletCore = {
  id: "wallet-amount",
  title: "WP3-T4: whole-taka amount to paisa, no floats",
  command: ["pnpm", "test", "--filter", "@tc/core", "topup-amount", "--no-passWithNoTests"],
};
const walletDb = {
  id: "wallet-db",
  title: "WP3-T4: wallet repository and its cross-tenant cases",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "wallet-repo",
    "cross-tenant",
    "--no-passWithNoTests",
  ],
};
const walletEps = {
  id: "wallet-eps",
  title: "WP3-T4: recheck, redirect allow-list",
  command: ["pnpm", "test", "--filter", "@tc/eps", "recheck", "redirect", "--no-passWithNoTests"],
};
const walletWeb = {
  id: "wallet-web",
  title: "WP3-T4: screens, actions, return routes, mockup anchors",
  command: ["pnpm", "test", "--filter", "@tc/web", "--no-passWithNoTests"],
};
const walletBuild = {
  id: "wallet-build",
  title: "WP3-T4: next build lists every route as dynamic and /pay/eps/* are handlers",
  command: ["node", "scripts/smoke-apps.mjs", "--app", "web"],
};
const walletE2e = {
  id: "wallet-e2e",
  title: "WP3-T4: Playwright against fakes shows the balance after a faked EPS success",
  command: ["node", "scripts/smoke-wallet.mjs"],
};
const WP3_T4 = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  ui,
  walletCore,
  walletDb,
  walletEps,
  walletWeb,
  repo,
  walletBuild,
  walletE2e,
];
TASKS["WP3-T4"] = WP3_T4;

// WP3-T5: invoices and receipts. What a machine can prove: the numbering, the invoice lines, the HTML
// (packages/core/invoices), the tenant-scoped repository with its cross-tenant cases (the db suite) and the
// invoice-renderer handler behind its PDF port. The PDF layout against the sample and the shaping of Bengali
// text in the real engine are manual VERIFY steps recorded in JOURNEY.md.
const invoiceRenderer = {
  id: "invoice-renderer",
  title: "functions/invoice-renderer: handler, fake PDF engine, boundaries",
  command: ["pnpm", "test", "--filter", "@tc/fn-invoice-renderer", "--no-passWithNoTests"],
};
const WP3_T5 = [specSync, baselineSync, lint, typecheck, format, core, db, invoiceRenderer, repo];
TASKS["WP3-T5"] = WP3_T5;

// WPU-T2 and WPU-T3 (two backlog rows) share one proof: the component kit, its messages and the guard tests.
const uiKit = {
  id: "ui-kit",
  title: "packages/ui: component kit, messages and guard tests",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/ui",
    "components/",
    "messages/",
    "test/",
    "--no-passWithNoTests",
  ],
};
// WP0-T5: the templates of infra/org are authored, not applied. The static proof is the repository test
// tests/repo/infra-org.test.mjs; "DevOps confirms in JOURNEY.md" is the manual half of the backlog row.
const infraOrg = {
  id: "infra-org",
  title: "infra/org templates: SCPs, trust policies, boundaries, trail, adapters match (static)",
  command: ["pnpm", "test", "--filter", "repo", "infra-org", "--no-passWithNoTests"],
};
TASKS["WP0-T5"] = [specSync, baselineSync, lint, typecheck, format, infraOrg];
// WP0-T6: the deploy workflows are authored only. The proof is the static rules over .github and the
// behaviour of scripts/post-deploy-check.mjs. No check runs sst, a deploy or an AWS command.
const ciDeploy = {
  id: "ci-deploy",
  title:
    "WP0-T6: deploy workflows (OIDC, pinned actions, tag only, environments, sst diff before deploy) and the post-deploy check",
  command: ["pnpm", "test", "--filter", "repo", "ci-deploy", "--no-passWithNoTests"],
};
TASKS["WP0-T6"] = [specSync, baselineSync, lint, typecheck, format, ciDeploy];
TASKS["WPU-T2"] = [specSync, baselineSync, lint, typecheck, format, ui, uiKit, repo];
TASKS["WPU-T3"] = TASKS["WPU-T2"];

// WP4-T2: the operations engine. The two functions are proved by their own packages; the engine scenarios
// (functions/provisioner/test/scenario.test.ts) are part of the provisioner check. `--no-passWithNoTests`
// makes a filter that selects no file fail, as in the checks aws, core and repo.
const provisioner = {
  id: "provisioner",
  title: "functions/provisioner: claim, step runner, batch handler and the engine scenarios",
  command: ["pnpm", "test", "--filter", "@tc/fn-provisioner", "--no-passWithNoTests"],
};
const scheduler = {
  id: "scheduler",
  title: "functions/scheduler: the sweeper handler",
  command: ["pnpm", "test", "--filter", "@tc/fn-scheduler", "--no-passWithNoTests"],
};
TASKS["WP4-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  core,
  aws,
  provisioner,
  scheduler,
  repo,
];

// WP5-T4: the lifecycle engine. Its proof (the one-instance scenario on the test clock, the guard, the
// renewal rules) lives in packages/core/lifecycle and runs with the core check; the scheduler handler test
// and the purge of rate limits (packages/db) run with the scheduler and db checks of the same list.
TASKS["WP5-T4"] = TASKS["WP4-T2"];

// WP5-T3: the reader function. The sentence of the backlog row (customer A cannot read customer B's
// metrics) has its own line, run on PostgreSQL with the real tenant check. The db suite holds the test of
// loadReadTarget, the aws suite the Lightsail read source on the fake transport.
const readerAll = {
  id: "reader",
  title: "functions/reader: handler, invocation, config, boundaries, tenant check",
  command: ["pnpm", "test", "--filter", "@tc/fn-reader", "--no-passWithNoTests"],
};
const readerProof = {
  id: "reader-cross-tenant",
  title: "WP5-T3: customer A cannot read customer B's metrics",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/fn-reader",
    "test/proof-cross-tenant",
    "--no-passWithNoTests",
  ],
};
TASKS["WP5-T3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  core,
  aws,
  readerAll,
  readerProof,
  repo,
];

// WP6-T4 and WP7-T1: the bucket and container service adapters. Each filter names a real test file.
const kindsRules = {
  id: "operation-kinds",
  title: "WP6-T4: the four new action kinds are in the closed list",
  command: ["pnpm", "test", "--filter", "@tc/db", "operation-kinds", "--no-passWithNoTests"],
};
const storageCoreRules = {
  id: "storage-core-rules",
  title: "WP6-T4, WP7-T1: bucket and container config, access mode, public-image deployments",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "products/bucket",
    "products/container",
    "--no-passWithNoTests",
  ],
};
const bucketCycle = {
  id: "bucket-adapter",
  title: "WP6-T4: create, suspend removes access, resume, destroy, actions",
  command: ["pnpm", "test", "--filter", "@tc/aws", "test/bucket.test", "--no-passWithNoTests"],
};
const bucketSecret = {
  id: "bucket-secret-once",
  title: "WP6-T4: the secret key is returned once, never logged, never stored",
  command: ["pnpm", "test", "--filter", "@tc/aws", "bucket-access", "--no-passWithNoTests"],
};
const containerCycle = {
  id: "container-adapter",
  title: "WP7-T1: the cycle passes and no registry login is ever issued",
  command: ["pnpm", "test", "--filter", "@tc/aws", "container-service", "--no-passWithNoTests"],
};
const storageWiring = {
  id: "storage-wiring",
  title: "WP6-T4, WP7-T1: both adapters are registered in the provisioner",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/fn-provisioner",
    "storage-wiring",
    "--no-passWithNoTests",
  ],
};
TASKS["WP6-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  kindsRules,
  storageCoreRules,
  bucketCycle,
  bucketSecret,
  storageWiring,
  aws,
  repo,
];
TASKS["WP7-T1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  kindsRules,
  storageCoreRules,
  containerCycle,
  storageWiring,
  aws,
  repo,
];
// WP6-T4s: the customer screens of buckets (/storage) and container services (/containers). Each
// filter names a real test file.
const storageScreensCore = {
  id: "storage-screens-core",
  title: "WP6-T4s: the order seam of a bucket and of a container service",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "products/bucket-resolve",
    "products/container-resolve",
    "orders/exports",
    "--no-passWithNoTests",
  ],
};
const storageScreensWeb = {
  id: "storage-screens-web",
  title:
    "WP6-T4s: the action cores, the secret key core, the views, the messages and the screens with the mockup cross-check",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "bucket",
    "container",
    "family-screens",
    "--no-passWithNoTests",
  ],
};
TASKS["WP6-T4s"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  storageScreensCore,
  storageScreensWeb,
  repo,
];
// WP7-T2: the CDN adapter, the order seam and the customer screens. Each filter names a real test file.
const cdnCore = {
  id: "cdn-core",
  title: "WP7-T2: CDN config, origin rule, and the origin checked through the scoped repository",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "products/cdn",
    "orders/cdn-origin-ownership",
    "--no-passWithNoTests",
  ],
};
const cdnAdapterCycle = {
  id: "cdn-adapter",
  title: "WP7-T2: create, suspend, resume, enable, destroy against the fake Lightsail client",
  command: ["pnpm", "test", "--filter", "@tc/aws", "test/cdn.test", "--no-passWithNoTests"],
};
const cdnWiring = {
  id: "cdn-wiring",
  title: "WP7-T2: the adapter is registered in the provisioner and destroy passes the guard",
  command: ["pnpm", "test", "--filter", "@tc/fn-provisioner", "cdn-wiring", "--no-passWithNoTests"],
};
const cdnWeb = {
  id: "cdn-web",
  title:
    "WP7-T2: the action cores, the views, the messages and the screens with the mockup cross-check",
  command: ["pnpm", "test", "--filter", "@tc/web", "cdn", "--no-passWithNoTests"],
};
TASKS["WP7-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  cdnCore,
  cdnAdapterCycle,
  cdnWiring,
  cdnWeb,
  aws,
  repo,
];
// WP6-T2s: the customer screens of the databases (WP6-T2) and of the load balancers (WP6-T3). Each
// filter names a real test file.
const dbLbCores = {
  id: "db-lb-cores",
  title:
    "WP6-T2s: stop, start and destroy cores (R9, R13), the database password core (U9) and the load balancer target re-check (R8)",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "family-actions",
    "databases-actions",
    "databases-access",
    "load-balancers-actions",
    "--no-passWithNoTests",
  ],
};
const dbLbViews = {
  id: "db-lb-views",
  title:
    "WP6-T2s: the views read the customer's own rows and answer a missing one like a stranger's",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "databases-view",
    "load-balancers-view",
    "--no-passWithNoTests",
  ],
};
const dbLbScreens = {
  id: "db-lb-screens",
  title:
    "WP6-T2s: the screens in bn and en with the mockup cross-check, the messages and the order links",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "(panel)/databases",
    "(panel)/load-balancers",
    "databases-messages",
    "load-balancers-messages",
    "family-links",
    "--no-passWithNoTests",
  ],
};
TASKS["WP6-T2s"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  dbLbCores,
  dbLbViews,
  dbLbScreens,
  repo,
];
// WP6-T1: the Windows instance adapter, the access-details function and the Access tab. Each filter
// names a real test file.
const windowsAdapter = {
  id: "windows-adapter",
  title: "WP6-T1: Windows create from the blueprint, isolation bootstrap fails closed",
  command: ["pnpm", "test", "--filter", "@tc/aws", "windows", "--no-passWithNoTests"],
};
const accessDetailsFn = {
  id: "access-details",
  title:
    "WP6-T1: the password is returned once, no-store, never logged, not released without audit",
  command: ["pnpm", "test", "--filter", "@tc/fn-access-details", "--no-passWithNoTests"],
};
const windowsAccessWeb = {
  id: "windows-access-web",
  title: "WP6-T1: reveal core (R9 order, fresh sign-in, tenant) and the Access tab states",
  command: ["pnpm", "test", "--filter", "@tc/web", "windows-access", "--no-passWithNoTests"],
};
TASKS["WP6-T1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  windowsAdapter,
  accessDetailsFn,
  windowsAccessWeb,
  aws,
  repo,
];

// WP6-T1b: the wiring of the Windows product (provisioner registry, resolved family and the shared
// instance limit, the server detail). Each filter names real test files.
TASKS["WP6-T1b"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  {
    id: "windows-provisioner",
    title: "WP6-T1b: the Windows adapter sits in the provisioner registry and fails closed",
    command: ["pnpm", "test", "--filter", "@tc/fn-provisioner", "windows", "--no-passWithNoTests"],
  },
  {
    id: "windows-order",
    title:
      "WP6-T1b: a Windows plan is sold behind its flag, one transaction, shared instance limit",
    command: ["pnpm", "test", "--filter", "@tc/core", "windows-purchase", "--no-passWithNoTests"],
  },
  {
    id: "windows-resolve",
    title: "WP6-T1b: windows_instance resolves under its own family and platform",
    command: ["pnpm", "test", "--filter", "@tc/core", "products/instance", "--no-passWithNoTests"],
  },
  {
    id: "windows-detail",
    title:
      "WP6-T1b: the server detail returns Windows servers behind the flag with the access panel",
    command: ["pnpm", "test", "--filter", "@tc/web", "windows", "--no-passWithNoTests"],
  },
  repo,
];

// WP7-T3: DNS zones and the record editor. The validation rules are pure and live in packages/core/dns;
// the zone adapter and the fake Route 53 are in packages/aws (no Route 53 client is built yet).
TASKS["WP7-T3"] = [specSync, baselineSync, lint, typecheck, format, core, aws, repo];

// WP7-T4: domains. The pure rules (packages/core/domains), the order path with a real database
// (packages/core/orders/domain-purchase), the adapter against the fake Route 53 Domains (packages/aws),
// the wiring in the provisioner and the screens with the mockup cross-check. The real Route 53 Domains
// client is a manual VERIFY (JOURNEY: Needs decision).
const domainCore = {
  id: "domain-core",
  title: "WP7-T4: name, TLD policy, confirmation, contact, state machine, renewal, order path",
  command: ["pnpm", "test", "--filter", "@tc/core", "domain", "--no-passWithNoTests"],
};
const domainAdapter = {
  id: "domain-adapter",
  title: "WP7-T4: register, marker, zone binding and the refusal to destroy against the fake port",
  command: ["pnpm", "test", "--filter", "@tc/aws", "test/domain.test", "--no-passWithNoTests"],
};
const domainWiring = {
  id: "domain-wiring",
  title: "WP7-T4: the adapter is registered in the provisioner and the guard refuses a destroy",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/fn-provisioner",
    "domain-wiring",
    "--no-passWithNoTests",
  ],
};
const domainWeb = {
  id: "domain-web",
  title:
    "WP7-T4: the action cores, the views, the messages and the screens with the mockup cross-check",
  command: ["pnpm", "test", "--filter", "@tc/web", "domain", "--no-passWithNoTests"],
};
TASKS["WP7-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  domainCore,
  domainAdapter,
  domainWiring,
  domainWeb,
  aws,
  repo,
];

// WP7-T5: metering. The daily charge (packages/core/pricing/metering.ts), the metering run and its DB
// test (packages/core/metering) run with the core and db checks; the scheduler job with the scheduler check.
TASKS["WP7-T5"] = [specSync, baselineSync, lint, typecheck, format, db, core, scheduler, repo];

// WP7-T6: the reconciler. The pure comparison cores (packages/core/reconcile), the worker_rw repository
// (packages/db, its DB test) and the run with a fake inventory port (functions/reconciler) run with the
// db, core and reconciler checks. The real STS inventory is a manual VERIFY.
TASKS["WP7-T6"] = [specSync, baselineSync, lint, typecheck, format, db, core, reconciler, repo];

// WPU-T4: the two Next.js apps. Their tests run by package; the smoke script builds both apps,
// scans the output, starts `next start` and reads the headers and the HTML (no database needed).
const web = {
  id: "web",
  title: "apps/web: proxy, CSP, messages, pages",
  command: ["pnpm", "test", "--filter", "@tc/web", "--no-passWithNoTests"],
};
const admin = {
  id: "admin",
  title: "apps/admin: proxy, CSP, messages, pages",
  command: ["pnpm", "test", "--filter", "@tc/admin", "--no-passWithNoTests"],
};
const appsSmoke = {
  id: "apps-smoke",
  title:
    "next build routes are dynamic, scan of the output, CSP report-only with nonce, dev UI is 404 in production",
  command: ["node", "scripts/smoke-apps.mjs"],
  timeoutMs: 1_800_000,
};
TASKS["WPU-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  ui,
  web,
  admin,
  repo,
  appsSmoke,
];

// WPU-G1: the first Linux server finishes (bootstrap marker through the beacon), the web tier enqueues
// through its own SQS port, and one pool account serves every tier (seed script, disk anchor for us-east-1).
// The db suite needs the local PostgreSQL (pnpm db:up).
TASKS["WPU-G1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  aws,
  core,
  db,
  provisioner,
  web,
  repo,
];

// WPU-G2: the customer panel feels like the Lightsail console. Reboot, stop, start and rename, the
// firewall rules editor and the static IP attach and detach on the server page, and the Connect help
// with the real login user. The pure rules and the adapter actions are proven in core and aws, the
// Server Actions, the cross-tenant sweep, the messages and the render states in web.
TASKS["WPU-G2"] = [specSync, baselineSync, lint, typecheck, format, core, aws, web, repo];

// WPU-G5: the account overview pages of the customer panel: Snapshots (list, create, restore to a new
// server, delete), Static IPs, Billing and usage, the first-use guide of the dashboard and the disk
// mount help. The pure rules are proven in core, the loaders, the render states, the messages and the
// cross-tenant sweep in web. No migration, no new operation kind, no AWS call.
TASKS["WPU-G5"] = [specSync, baselineSync, lint, typecheck, format, core, web, repo];

// WPU-G7: the console actions of the load balancer, database, bucket and CDN screens: eight operation
// kinds (db), their adapter actions (aws), the input rules (core), the console cores with the
// cross-tenant sweep, the view models, messages and render states (web), the operation names (admin).
// No migration. The db suite needs the local PostgreSQL (pnpm db:up).
TASKS["WPU-G7"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  web,
  admin,
  repo,
];

// WPU-G8: container service and CDN console: the plan change that takes effect at the next renewal (the
// renewal quote and the apply operation, core with the database), four operation kinds (db), the adapter
// actions for plan, certificates, cache behaviours and origin (aws), the cache and container rules (core),
// the specs, views, forms and messages (web), the operation names (admin) and the role allow-list (repo).
// No migration. The core and db suites need the local PostgreSQL (pnpm db:up).
TASKS["WPU-G8"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  web,
  admin,
  repo,
];

// WPU-G9: database snapshots, restore to a new database (snapshot and point in time), connection facts and
// maintenance window; bucket access mode read-back and access for a server (with the suspend revoke);
// the default snapshot price (migration 0014). Rules (core), kinds and migration (db), adapters (aws),
// cores, views, messages and the cross-tenant sweep (web), operation names (admin). The db suite needs
// the local PostgreSQL (pnpm db:up).
TASKS["WPU-G9"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  web,
  admin,
  repo,
];

// WPU-G4: the Metrics tab reads the reader function through an invoke port and draws console-style SVG
// charts, /invoices and /invoices/[id] with a printable document, /dns and /dns/[id] with the record
// editor (kind change_dns_record). The record rules (core), the operation kinds (db), the zone adapter
// action (aws), the view models, Server Actions, cross-tenant sweep, messages and render states (web) and
// the boundary tests (repo) prove it. The db suite needs the local PostgreSQL (pnpm db:up).
TASKS["WPU-G4"] = [specSync, baselineSync, lint, typecheck, format, core, db, aws, web, repo];

// WPU-G6: the DNS zone create flow end to end. The zone rules and the order path (core, a zone is
// poolless and priced from the market's config price), migration 0011 and the tenant-scoped dns_zones
// repository (db), the zone adapter that saves the record list (aws), the provisioner that treats a zone
// as poolless and keeps the dns_zones row in step (provisioner), and the /dns create form, the name server
// display, the delete, the messages and the cross-tenant sweep (web). The db suite needs the local
// PostgreSQL (pnpm db:up). No AWS call: the Route 53 client is a port with a fake.
TASKS["WPU-G6"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  provisioner,
  web,
  repo,
];

// WPU-S1: the DNS zone name rules after the security review. Only a delegated zone is exclusive for a name
// (migration 0012 replaces the index of 0011), several customers may hold a pending zone for one name,
// and a name equal to or under a domain another customer holds is refused with the generic "taken" (core
// order path and db). The db suite needs the local PostgreSQL (pnpm db:up). No AWS call.
TASKS["WPU-S1"] = [specSync, baselineSync, lint, typecheck, format, core, db, repo];

// WPU-S2: the plan change of a renewal after the security review. The pending plan's price is quoted
// only when the apply operation can run in the resource's state (core, with the database), a failed
// apply (needs_attention) marks the pending plan failed and stops the discount (core hook, scheduler
// sweep, provisioner hooks), the adapter actions accept `active` only and clear the mark (aws), and the
// sweeper sends the queued apply rows that renewNow inserts (core, with the database). No AWS call. The
// core suite needs the local PostgreSQL (pnpm db:up).
TASKS["WPU-S2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  aws,
  provisioner,
  scheduler,
  repo,
];

// WPU-S3: the downgrade gaming path of the plan change. While the apply of a pending plan is queued or
// running, the customer cannot stop or destroy the resource or schedule another plan (busy, fail
// closed; web), the failure mark keeps {code, productId, period} and the customer cannot clear it: the
// same product is refused, another is allowed, a cancel leaves the mark (aws adapters, web), the next
// renewal after a failed apply charges the plan in force (core, with the database), and the plan tab
// shows a failed plan as failed (web). The lifecycle repository gained one read (db). No AWS call. The
// core and db suites need the local PostgreSQL (pnpm db:up).
TASKS["WPU-S3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  scheduler,
  web,
  repo,
];

// WPU-S4: the renewal never charges less than the plan the resource has: the quote is the catalog price
// of max(applied plan, pending plan) through the pricing engine (core, with the database), so a
// downgrade is charged at the current price for its term and a failed, stopped or raced apply cannot
// give a discount; the failure mark takes its product from the failed operation (core, db); the plan
// tab says the lower price starts from the following renewal (web, bn and en). No AWS call. The core
// and db suites need the local PostgreSQL (pnpm db:up).
TASKS["WPU-S4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  scheduler,
  web,
  repo,
];

// WPU-S5: the charge follows the delivered capacity. The scheduler queues the apply of a pending plan a
// fixed lead time before the renewal (core, with the database), the renewal prices exactly the applied
// plan and never the pending one, and renewNow queues no apply (core, db); the plan tab says the change
// lands shortly before the renewal (web, bn and en). No AWS call. The core and db suites need the
// local PostgreSQL (pnpm db:up).
TASKS["WPU-S5"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  scheduler,
  web,
  repo,
];

// WPU-S6: security hardening after the independent review. (1) The reader takes the tier from the alias
// of the invoked ARN: customerId only from "web", adminId only from "admin", and each role may invoke its
// own alias only (reader, repo). (2) A bucket remembers at most 20 instances: the 21st allow is refused
// before AWS is asked, here and at the console (core, aws, web). (3) The ownership of a row is checked
// before the rate limit in the console and snapshot cores (web). No AWS call.
TASKS["WPU-S6"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  aws,
  readerAll,
  web,
  repo,
];

// WPU-S7: the apply of a pending plan is bound to its period and to the money. The apply payload names the
// subscription and the period end and both adapters skip an apply for a period that has moved (aws); the
// renewal waits a bounded time for an apply of the current period, scheduler and renewNow (core, db); an
// upgrade is queued only when autoRenew is on and the wallet covers its price, a downgrade always (core,
// db). No AWS call. The core and db suites need the local PostgreSQL (pnpm db:up).
TASKS["WPU-S7"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  scheduler,
  web,
  repo,
];

// WPU-M1: an unattached static IP is charged as Amazon Lightsail does (free while attached, an hourly
// price once unattached for more than one hour). Money path: the config price row and its migration (db),
// the price through the pricing engine, the existing metered_charge posting once per IP and hour bucket,
// the empty wallet and the missing price (core, with the database), the detachedAt stamp of the detach
// and attach (aws), the hourly scheduler job (scheduler), the Static IPs page and the Networking tab in
// bn and en (web) and the config price in /pricing/config (admin). No AWS call. The core and db suites
// need the local PostgreSQL (pnpm db:up).
TASKS["WPU-M1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  scheduler,
  web,
  admin,
  repo,
];

// WPU-M2: a metered charge is split like a purchase (spec 9.1): the metered snapshot day and the
// unattached static IP hour post the base to revenue_aws_base and the VAT, fee and margin steps to their
// own accounts, from the steps of the engine's quote, through the one posting builder that the purchase
// and the renewal use. The price is read in the market of the customer's profile at the instant of the
// clock, and a price of zero is no price anywhere (R16). Money path: the pricing split, the builder,
// both metering jobs against the real ledger (core, with the database), the config price seed (db), the
// hourly and daily jobs (scheduler) and the screens that show the prices (web). No AWS call. The core
// and db suites need the local PostgreSQL (pnpm db:up).
TASKS["WPU-M2"] = [specSync, baselineSync, lint, typecheck, format, core, db, scheduler, web, repo];

// WP2-T1: packages/auth. The identity lookup test and the whole db suite run in the db check;
// `--no-passWithNoTests` makes a filter that selects no file fail.
const auth = {
  id: "auth",
  title: "packages/auth: tokens, cookies, session, refresh",
  command: ["pnpm", "test", "--filter", "@tc/auth", "--no-passWithNoTests"],
};
TASKS["WP2-T1"] = [specSync, baselineSync, lint, typecheck, format, db, auth, repo];

// WP8-T1: the admin app shell, the admin session and the active-admin rule of `audited` (H1). The
// three sentences of the backlog row have their own lines; what only WAF and the function URL can
// prove (the real 403 at CloudFront and at the Lambda URL) is a manual staging VERIFY step in
// JOURNEY.md. `--no-passWithNoTests` makes a filter that selects no file fail.
const adminNoMfa = {
  id: "admin-no-mfa-no-sign-in",
  title: "WP8-T1: no MFA means no sign-in (token claim, TOTP challenge, no cookie)",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/auth",
    "test/admin-signin",
    "test/admin.test",
    "--no-passWithNoTests",
  ],
};
const adminAllowlist = {
  id: "admin-outside-allowlist-403",
  title: "WP8-T1: outside the allowlist and without the CloudFront header the admin app gets 403",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/admin",
    "proxy.test",
    "server/gate",
    "route.test",
    "--no-passWithNoTests",
  ],
};
const adminActiveActor = {
  id: "admin-audited-active-actor",
  title: "WP8-T1: every admin writer refuses a disabled or missing admin and appends no audit row",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "admin-audited-active",
    "admin-repos",
    "admin-operations",
    "--no-passWithNoTests",
  ],
};
TASKS["WP8-T1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  adminActiveActor,
  auth,
  adminNoMfa,
  admin,
  adminAllowlist,
  core,
  repo,
];

// WP8-T2: customers and KYC review. The backlog sentence ("document images come through short-lived URLs
// and are never cached") has its own line; the rest is the db suite (repository, roles, audit rows,
// replays, masking) and the admin suite (R9 order, pages in bn and en, mockup cross-check). The real S3
// presigner is a manual VERIFY step in JOURNEY.md. `--no-passWithNoTests` makes a filter that selects no
// file fail.
const kycDocumentsNeverCached = {
  id: "kyc-document-short-lived-never-cached",
  title: "WP8-T2: KYC document images come through short-lived URLs and are never cached",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/admin",
    "server/kyc-documents",
    "--no-passWithNoTests",
  ],
};
const adminCustomersRepo = {
  id: "admin-customers-repo",
  title: "WP8-T2: KYC and customer decisions: roles, audit rows, replays, masked fields",
  command: ["pnpm", "test", "--filter", "@tc/db", "admin-customers", "--no-passWithNoTests"],
};
TASKS["WP8-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  adminCustomersRepo,
  admin,
  kycDocumentsNeverCached,
  repo,
];

// WP8-T3: wallets, payments and adjustments with a second approval. The backlog sentence ("an adjustment
// above the limit waits for a second admin") has its own line: the db suite of the wallet repository
// (pending above the limit, the requester refused, the 24 hour split rule, replays, audit rows). The
// ledger invariant with the real postTransaction is the core line; the screens, the R9 order and the
// mockup cross-check are the admin suite. `--no-passWithNoTests` makes a filter that selects no file fail.
const adjustmentWaitsForSecondAdmin = {
  id: "adjustment-above-limit-waits-for-second-admin",
  title:
    "WP8-T3: an adjustment above the limit waits for a second admin (and splitting does not help)",
  command: ["pnpm", "test", "--filter", "@tc/db", "admin-wallets", "--no-passWithNoTests"],
};
const adminMoneyRepos = {
  id: "admin-money-repos",
  title: "WP8-T3: payments, refunds and discrepancies: roles, audit rows, replays",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "admin-payments",
    "admin-repos",
    "--no-passWithNoTests",
  ],
};
const adminMoneyLedger = {
  id: "admin-money-ledger-invariant",
  title: "WP8-T3: the admin postings balance with the real postTransaction",
  command: ["pnpm", "test", "--filter", "@tc/core", "test/admin-money", "--no-passWithNoTests"],
};
TASKS["WP8-T3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  adjustmentWaitsForSecondAdmin,
  adminMoneyRepos,
  adminMoneyLedger,
  core,
  admin,
  repo,
];

// WP8-T4: pricing, catalog and flags. The backlog sentence ("saving a rule shows the five-product preview
// first") and the two-person rule of a large FX change have their own lines; the rest is the admin suite
// (flows in the order of R9, roles, pages in bn and en, mockup cross-check) and the db tests of the new
// reads and of the pending change. `--no-passWithNoTests` makes a filter that selects no file fail.
const pricingPreviewFirst = {
  id: "pricing-preview-before-save",
  title: "WP8-T4: the save form of a rule exists only under a good preview of five products",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/admin",
    "pricing-pages",
    "pricing-flow",
    "--no-passWithNoTests",
  ],
};
const fxSecondAdmin = {
  id: "fx-second-admin",
  title: "WP8-T4: a large FX change is approved by a different admin, never named by a request",
  command: ["pnpm", "test", "--filter", "@tc/db", "admin-fx-changes", "--no-passWithNoTests"],
};
const catalogAdminRead = {
  id: "catalog-admin-read",
  title: "WP8-T4: the catalog list for the admin is read-only (no write grant)",
  command: ["pnpm", "test", "--filter", "@tc/db", "catalog-admin-list", "--no-passWithNoTests"],
};
TASKS["WP8-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  catalogAdminRead,
  fxSecondAdmin,
  admin,
  pricingPreviewFirst,
  repo,
];

// WP8-T5: capacity and the operations queue. The backlog sentence ("a destructive operation runs only
// after approval") has the repository half (approve is the only way out of needs_approval, the reads are
// refused to anyone but an active ops or superadmin admin) and the app half (only moves of
// ADMIN_TRANSITIONS reach the repository, the approver is the session admin, the R9 order, the screens
// and the mockup cross-check). `--no-passWithNoTests` makes a filter that selects no file fail.
const adminOpsRepos = {
  id: "admin-ops-repos",
  title:
    "WP8-T5: queue, detail, counts, waitlist and capacity reads; approval and retry; role checks",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "admin-ops-reads",
    "admin-operations",
    "operation-approval",
    "--no-passWithNoTests",
  ],
};
const adminOpsApp = {
  id: "admin-ops-app",
  title:
    "WP8-T5: flows in the order of R9, ADMIN_TRANSITIONS only, mapped errors, screens and mockup",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/admin",
    "ops-map",
    "ops-flow",
    "capacity-flow",
    "ops-pages",
    "ops-messages",
    "--no-passWithNoTests",
  ],
};
TASKS["WP8-T5"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  adminOpsRepos,
  adminOpsApp,
  core,
  admin,
  repo,
];

// WP8-T6: audit search and admin users. The backlog sentence ("every admin action has an audit row") is
// the completeness test of the admin repositories (every write has a case that checks the audit row with
// actor, reason, IP and target); the rules of /admins (superadmin only, the actor is the session, the last
// superadmin stays) and the masked, read-only audit repository have their own db lines. The rest is the
// admin suite (flows in the order of R9, pages in bn and en, mockup cross-check, messages).
// `--no-passWithNoTests` makes a filter that selects no file fail.
const everyAdminActionAudited = {
  id: "every-admin-action-audited",
  title:
    "WP8-T6: every write of the admin repositories has an audit row with actor, reason, IP and target",
  command: ["pnpm", "test", "--filter", "@tc/db", "admin-repos", "--no-passWithNoTests"],
};
const adminUsersRules = {
  id: "admin-users-rules",
  title:
    "WP8-T6: admin users are changed by a superadmin only, never oneself, and the last one stays",
  command: ["pnpm", "test", "--filter", "@tc/db", "admin-users", "--no-passWithNoTests"],
};
const auditReadOnlyMasked = {
  id: "audit-read-only-masked",
  title: "WP8-T6: the audit repository is read only and masks secrets and personal data",
  command: ["pnpm", "test", "--filter", "@tc/db", "admin-audit.test", "--no-passWithNoTests"],
};
TASKS["WP8-T6"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  everyAdminActionAudited,
  adminUsersRules,
  auditReadOnlyMasked,
  admin,
  repo,
];

// WP8-T7: support, abuse and reconciliation (16.12, P1). The backlog proof is "listed in 16.12": the
// repository half (roles, audit rows with actor, reason, IP and target, replays, suspendResource writes
// an operation row and nothing else) and the app half (R9 order, the actor is the session admin, the
// screens in bn and en, the mockup cross-check). `--no-passWithNoTests` makes a filter that selects no
// file fail.
const adminCaseRepos = {
  id: "admin-case-repos",
  title: "WP8-T7: support, abuse and reconciliation repositories: roles, audit rows, replays",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "admin-support",
    "admin-abuse",
    "admin-reconciliation",
    "reconciliation-details",
    "admin-repos",
    "--no-passWithNoTests",
  ],
};
const adminCaseApp = {
  id: "admin-case-app",
  title: "WP8-T7: flows in the order of R9, screens, messages and mockup",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/admin",
    "case-flows",
    "cases-pages",
    "cases-messages",
    "--no-passWithNoTests",
  ],
};
TASKS["WP8-T7"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  adminCaseRepos,
  adminCaseApp,
  core,
  admin,
  repo,
];

// WP1-T4: the two halves of the backlog proof ("a new rate never changes a stored order", "preview equals
// engine output") on their own lines. `--no-passWithNoTests` makes a filter that selects no file fail.
const storedOrder = {
  id: "stored-order",
  title: "A new rate never changes a stored order",
  command: ["pnpm", "test", "--filter", "@tc/core", "rates/stored-order", "--no-passWithNoTests"],
};
const previewEqualsEngine = {
  id: "preview",
  title: "Preview equals engine output",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "pricing/preview",
    "rates/preview-equals-engine",
    "--no-passWithNoTests",
  ],
};
const WP1_T4 = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  storedOrder,
  previewEqualsEngine,
  core,
  repo,
];
TASKS["WP1-T4"] = WP1_T4;

// WP1-T5: the catalog-sync function. The proof covers the instance half (plans with BDT prices on read, no
// active IPv6-only plan, fail closed, idempotent) with a fake AWS client and the real database. The TLD half
// is NOT proven: the Route 53 Domains client is not installed, so the step is skipped with a log (JOURNEY).
const catalogSyncAll = {
  id: "catalog-sync",
  title: "functions/catalog-sync: handler, config, deps, boundaries",
  command: ["pnpm", "test", "--filter", "@tc/fn-catalog-sync", "--no-passWithNoTests"],
};
const catalogSyncProof = {
  id: "catalog-sync-proof",
  title:
    "WP1-T5: catalog holds plans with BDT prices; no active instance plan is IPv6-only; TLD prices not proven (skipped)",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/fn-catalog-sync",
    "test/proof-catalog",
    "--no-passWithNoTests",
  ],
};
const WP1_T5 = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  catalogSyncAll,
  catalogSyncProof,
  repo,
];
TASKS["WP1-T5"] = WP1_T5;

// WP2-T3: phone OTP. The two lines of the backlog row (limits, tenancy) are their own checks; the
// filters fail when they select no file (`--no-passWithNoTests`).
const notifyOtp = {
  id: "notify-otp",
  title: "packages/notify: SMS port and fake, OTP codes, send and verify",
  command: ["pnpm", "test", "--filter", "@tc/notify", "--no-passWithNoTests"],
};
const otpLimits = {
  id: "otp-limits",
  title: "WP2-T3: 5 attempts, 3 sends an hour per number and per IP, codes stored hashed",
  command: ["pnpm", "test", "--filter", "@tc/notify", "test/otp-limits", "--no-passWithNoTests"],
};
const otpTenancy = {
  id: "otp-tenancy",
  title: "WP2-T3: rate_limits and otp_challenges rows belong to their customer",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "test/rate-limit",
    "test/otp-repo",
    "test/cross-tenant",
    "--no-passWithNoTests",
  ],
};
TASKS["WP2-T3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  notifyOtp,
  otpLimits,
  otpTenancy,
  repo,
];

// WP2-T2: the five sign-in screens. The two lines of the backlog row are their own checks: the actions
// run in the R9 order, enumeration-safe, with a forged forwarded-for limited under the CloudFront
// address (auth-pages), and Playwright completes sign-up to sign-in in bn at 360 px against the fake
// identity provider (auth-smoke). The filters name real files; tests/repo/verify-cli.test.mjs asserts
// that they exist, because passWithNoTests is on. A missing browser, package, database or port makes
// auth-smoke print BLOCKED and fail: never a pass.
const authPages = {
  id: "auth-pages",
  title:
    "WP2-T2: the actions run in the R9 order, enumeration-safe, forged forwarded-for limited under the CloudFront address",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "server/auth",
    "auth-pages",
    "--no-passWithNoTests",
  ],
};
const authSmoke = {
  id: "auth-smoke",
  title:
    "WP2-T2: Playwright completes sign-up to sign-in in bn at 360 px against the fake identity provider",
  command: ["node", "scripts/smoke-auth.mjs"],
  timeoutMs: 1_800_000,
};
TASKS["WP2-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  auth,
  notifyOtp,
  web,
  authPages,
  authSmoke,
  repo,
];

// WP2-T4: /kyc. The sentences of the backlog row, each on its own line; every filter names files and
// `--no-passWithNoTests` makes an empty selection fail (tests/repo/verify-cli.test.mjs also asserts
// that the files exist). "No resource before verified" is proven in WP4-T4 (orders-kyc-gate).
const kycRules = {
  id: "kyc-rules",
  title: "WP2-T4: KYC document types, limits, status transitions, object keys, no number in a key",
  command: ["pnpm", "test", "--filter", "@tc/core", "kyc/rules", "--no-passWithNoTests"],
};
const kycWebRole = {
  id: "kyc-web-role",
  title:
    "WP2-T4: the web role cannot read a KYC object or its keys, one open submission, cross-tenant",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "test/kyc-repo",
    "test/cross-tenant",
    "--no-passWithNoTests",
  ],
};
const kycActions = {
  id: "kyc-actions",
  title: "WP2-T4: start upload and submit in R9 order, the port has no read, no number in a log",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "server/kyc-actions",
    "server/kyc-view",
    "kyc/",
    "--no-passWithNoTests",
  ],
};
const kycSeed = {
  id: "kyc-seed",
  title: "WP2-T4: the staging-only seed marks a test customer verified and refuses production",
  command: ["pnpm", "test", "scripts/lib/seed-kyc-verified.test.mjs", "--no-passWithNoTests"],
};
TASKS["WP2-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  kycRules,
  kycWebRole,
  kycActions,
  kycSeed,
  web,
  repo,
];

// WP2-T5: /settings/profile and /settings/security. "An e-mail or phone change needs a fresh sign-in
// and a new verification" has its own line.
const settingsFresh = {
  id: "settings-fresh-sign-in",
  title: "WP2-T5: e-mail, phone and password changes need a fresh sign-in and a new verification",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "server/settings-actions",
    "--no-passWithNoTests",
  ],
};
const settingsTenancy = {
  id: "settings-profile-repo",
  title: "WP2-T5: profile.setEmail changes only the session customer's row",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "test/profile-email",
    "test/cross-tenant",
    "--no-passWithNoTests",
  ],
};
TASKS["WP2-T5"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  settingsTenancy,
  settingsFresh,
  web,
  repo,
];

// WP0-T2, WP0-T3, WP0-T4: the SST app is authored but not deployed here (SST is not installed, and a
// deploy is a manual step, JOURNEY.md). The proof is the pure-logic tests of infra/lib, the static
// rule tests that read the source text of infra/stacks, and the tooling test (tsc of infra/lib, no
// account id or secret). The deployed outputs are listed by a person after `sst deploy --stage staging`.
const infraTest = (id, title, file) => ({
  id,
  title,
  command: ["pnpm", "test", "--filter", "repo", file, "--no-passWithNoTests"],
});
const infraLib = infraTest(
  "infra-lib",
  "infra/lib: stage guard (production refused outside CI, fake switches refused), CIDR and AZ table, allowlist, function table",
  "infra-lib",
);
const infraTooling = infraTest(
  "infra-tooling",
  "infra/lib type-checks; infra is linted and formatted; no account id, ARN or secret in infra/",
  "infra-tooling",
);
TASKS["WP0-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  infraLib,
  infraTest(
    "infra-edge-rules",
    "WP0-T2: VPC with two AZs and NAT, CloudFront with OAC and edge signing, WAF with the admin allowlist, HSTS, no sts in web (R1)",
    "infra-rules",
  ),
  infraTooling,
  repo,
];
TASKS["WP0-T3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  infraLib,
  infraTest(
    "infra-database-rules",
    "WP0-T3: private RDS, 14-day backups, deletion protection, TLS forced on instance and proxy, roles by the migrator only",
    "infra-rules",
  ),
  infraTooling,
  repo,
];
TASKS["WP0-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  infraLib,
  infraTest(
    "infra-identity-storage-rules",
    "WP0-T4: admin TOTP and no self sign-up, SES, FIFO queue with DLQ and alarm to SNS, private KMS buckets, kyc denied to web",
    "infra-rules",
  ),
  infraTooling,
  repo,
];

// WP0-T3b: the run-time glue that the SST stacks expect (handlers of migrator, notifier and
// cognito-messages, and the database URL built at run time from DB_* and the linked password secret).
// No check runs a deploy or calls AWS. The database test of the migrator (roles) uses temp databases
// of the local PostgreSQL.
const glueTest = (id, title, filter, ...files) => ({
  id,
  title,
  command: ["pnpm", "test", "--filter", filter, ...files, "--no-passWithNoTests"],
});
TASKS["WP0-T3b"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  glueTest(
    "database-url",
    "packages/db: databaseUrlFromEnv (R2, R3: TLS only, password from the linked secret, fixed error)",
    "@tc/db",
    "test/database-url",
  ),
  glueTest(
    "migrator",
    "functions/migrator: five roles with passwords from secrets, idempotent, TLS check, counts only",
    "@tc/fn-migrator",
  ),
  glueTest(
    "notifier",
    "functions/notifier: handler over ports, fails closed without SES, SMS rows stay pending",
    "@tc/fn-notifier",
  ),
  glueTest(
    "cognito-messages",
    "functions/cognito-messages: bn/en verification, reset and admin messages, locale, escaping",
    "@tc/fn-cognito-messages",
  ),
  glueTest(
    "cognito-templates",
    "packages/notify: the Cognito message templates hold only Cognito's placeholders",
    "@tc/notify",
    "test/cognito",
  ),
  infraLib,
  infraTest(
    "infra-runtime-env",
    "WP0-T3b: the environment names of the function table agree with the code (DB_PASSWORD_SECRET, MIGRATIONS_DIR, PANEL_ORIGIN, SES_FROM)",
    "infra-rules",
  ),
  repo,
];

// WP4-T3: capacity. The race for the last slot (10.2) on its own line; the filter names a file, and
// tests/repo/verify-cli.test.mjs asserts that the file exists, because passWithNoTests is on.
const capacityRace = {
  id: "capacity-race",
  title: "10.2: two concurrent orders for the last slot: one succeeds, one gets the waitlist",
  command: ["pnpm", "test", "--filter", "@tc/core", "capacity/race"],
};
TASKS["WP4-T3"] = [specSync, baselineSync, lint, typecheck, format, db, capacityRace, core, repo];

// WP4-T4: orders. The three sentences of the backlog row, each on its own line. Each filter names a
// file and `--no-passWithNoTests` makes an empty selection fail; tests/repo/verify-cli.test.mjs also
// asserts that the three files exist.
const ordersDoubleSubmit = {
  id: "orders-double-submit",
  title: "9.1: one draft, one key: the wallet is charged once, whatever the number of submits",
  command: ["pnpm", "test", "--filter", "@tc/core", "orders/double-submit", "--no-passWithNoTests"],
};
const ordersFailedCreate = {
  id: "orders-failed-create",
  title: "10.1: a failed create refunds once and gives the capacity back",
  command: ["pnpm", "test", "--filter", "@tc/core", "orders/failed-create", "--no-passWithNoTests"],
};
const ordersKycGate = {
  id: "orders-kyc-gate",
  title:
    "6.2 and 16.11: an order from a customer who is not verified creates no resource (full rows compared)",
  command: ["pnpm", "test", "--filter", "@tc/core", "orders/kyc-gate", "--no-passWithNoTests"],
};
// WP4-T5 / WP4-T6: the Linux instance adapter against a fake Lightsail, the bootstrap firewall text
// and the local part of tests/isolation. The real-pool isolation test and the staging proof are
// manual VERIFY steps (JOURNEY.md); the database-backed provisioner tests run in the db gate.
const linuxAdapter = {
  id: "linux-adapter",
  title: "10.3: key import, instance, bootstrap marker, static IP, ports; a retried step makes one",
  command: ["pnpm", "test", "--filter", "@tc/aws", "linux-instance", "--no-passWithNoTests"],
};
const bootstrapFirewall = {
  id: "bootstrap-firewall",
  title: "10.4: the fixed bootstrap template opens and closes exactly what it should",
  command: ["pnpm", "test", "--filter", "@tc/aws", "bootstrap", "--no-passWithNoTests"],
};
const isolationLocal = {
  id: "isolation-local",
  title: "10.4: tests/isolation case list; the real-pool part skips itself with a reason",
  command: ["pnpm", "test", "--filter", "isolation", "--no-passWithNoTests"],
};
TASKS["WP4-T5"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  linuxAdapter,
  bootstrapFirewall,
  isolationLocal,
  aws,
  repo,
];

// WP5-T1 / WP5-T2: the backup, restore and block storage adapters against a fake Lightsail, the
// database rows of the final backups and the registration in functions/provisioner. The staging proof
// (a real snapshot, a real restore, a real disk cycle in tc-pool-dev) is a manual VERIFY step (JOURNEY.md).
const backupAdapterCheck = {
  id: "backup-adapter",
  title:
    "10.3: backup, restore to a new server, automatic backups, final snapshot as a child backup row",
  command: ["pnpm", "test", "--filter", "@tc/aws", "backup", "--no-passWithNoTests"],
};
const diskAdapterCheck = {
  id: "disk-adapter",
  title:
    "10.3: block storage create, attach, detach, destroy cycle; a retried step makes one resource",
  command: ["pnpm", "test", "--filter", "@tc/aws", "disk", "--no-passWithNoTests"],
};
const backupRows = {
  id: "backup-rows",
  title:
    "R13: the final backup row is made once per operation and counts for the guard only when active",
  command: ["pnpm", "test", "--filter", "@tc/db", "backups-repo", "--no-passWithNoTests"],
};
const backupWiring = {
  id: "backup-wiring",
  title: "the provisioner registry holds the instance, backup and disk families",
  command: ["pnpm", "test", "--filter", "@tc/fn-provisioner", "backup", "--no-passWithNoTests"],
};
TASKS["WP5-T1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  backupAdapterCheck,
  backupRows,
  backupWiring,
  aws,
  repo,
];
TASKS["WP5-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  diskAdapterCheck,
  backupRows,
  backupWiring,
  aws,
  repo,
];

// WP6-T2 / WP6-T3: the managed database and load balancer adapters against a fake Lightsail, the pure
// target rule and the order-path ownership gate. The database-backed order test (lb-target-ownership)
// runs in the db gate; the real tc-pool-dev cycle is a manual VERIFY step (JOURNEY.md).
const databaseAdapter = {
  id: "database-adapter",
  title:
    "10.3: create, stop, start, snapshot, destroy; no password handled; a retried step makes one",
  command: ["pnpm", "test", "--filter", "@tc/aws", "test/database", "--no-passWithNoTests"],
};
const loadBalancerAdapter = {
  id: "load-balancer-adapter",
  title: "10.3: targets limited to the customer's own active instances in the same Region",
  command: ["pnpm", "test", "--filter", "@tc/aws", "test/load-balancer", "--no-passWithNoTests"],
};
const lbTargetRule = {
  id: "lb-target-rule",
  title: "R8: the pure target rule and the product seams of both families",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "products/load-balancer",
    "--no-passWithNoTests",
  ],
};
const dbProductSeam = {
  id: "database-product",
  title: "the database product seam holds no secret and needs one database slot",
  command: ["pnpm", "test", "--filter", "@tc/core", "products/database", "--no-passWithNoTests"],
};
TASKS["WP6-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  databaseAdapter,
  dbProductSeam,
  aws,
  repo,
];
TASKS["WP6-T3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  loadBalancerAdapter,
  lbTargetRule,
  {
    id: "lb-target-ownership",
    title:
      "R8: a draft and a purchase naming another customer's instance are refused and write nothing",
    command: [
      "pnpm",
      "test",
      "--filter",
      "@tc/core",
      "orders/lb-target-ownership",
      "--no-passWithNoTests",
    ],
  },
  aws,
  repo,
];

TASKS["WP4-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  db,
  ordersDoubleSubmit,
  ordersFailedCreate,
  ordersKycGate,
  core,
  repo,
];

// WP5-T5: notifications. The two sentences of the backlog row, each on its own line: "every trigger
// of 16.14 sends once" (the delivery loop over all 22 messages and the 16.14 table as data) and "no
// secret in any message" (the scan, the strict data and every rendered message). Both need no
// database. Each filter names files, `--no-passWithNoTests` makes an empty selection fail, and
// tests/repo/verify-cli.test.mjs asserts that the files exist.
const notifyAll = {
  id: "notify",
  title: "packages/notify: templates, providers, queue, delivery loop, OTP",
  command: ["pnpm", "test", "--filter", "@tc/notify", "--no-passWithNoTests"],
};
const notifyTriggers = {
  id: "triggers-send-once",
  title: "16.14: every trigger sends once per channel, a second run sends nothing",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/notify",
    "test/run.test",
    "test/trigger-map",
    "--no-passWithNoTests",
  ],
};
const notifyNoSecret = {
  id: "no-secret",
  title: "R14 and 16.14: no secret, OTP, password, full phone or email in any message",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/notify",
    "test/guards",
    "test/templates",
    "test/notify.test",
    "--no-passWithNoTests",
  ],
};
const notifierFn = {
  id: "notifier-fn",
  title: "functions/notifier: the handler",
  command: ["pnpm", "test", "--filter", "@tc/fn-notifier", "--no-passWithNoTests"],
};
TASKS["WP5-T5"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  notifyAll,
  notifyTriggers,
  notifyNoSecret,
  notifierFn,
  repo,
];

// WP5-T6: the server tabs Backups, Storage, Metrics, Billing and Destroy, /dashboard, /notifications
// and the bell. The backlog proof, "Destroy needs the typed name and a fresh sign-in", is on its own
// line (the action cores), next to the tenant proof of the new repositories (R8), the screens in bn
// and en, the cross-check against the shared mockup and the messages. Each filter names files and
// `--no-passWithNoTests` makes an empty selection fail; tests/repo/verify-cli.test.mjs asserts that
// the files exist.
const extrasCores = {
  id: "extras-cores",
  title:
    "U10, R9, R13: Destroy needs the typed name and a fresh sign-in; order of checks; cross-tenant answers",
  command: ["pnpm", "test", "--filter", "@tc/web", "server/extras-actions", "--no-passWithNoTests"],
};
const extrasViews = {
  id: "extras-views",
  title:
    "R4, R16: price lines, metrics through the reader port, notifications rendered without payload",
  command: ["pnpm", "test", "--filter", "@tc/web", "server/extras-view", "--no-passWithNoTests"],
};
const extrasRepos = {
  id: "extras-repos",
  title:
    "R8, R13: notifications, subscriptions, backup rows, recent operations; a final backup is never deleted (database)",
  command: ["pnpm", "test", "--filter", "@tc/db", "extras-repos", "--no-passWithNoTests"],
};
const extrasGuard = {
  id: "extras-guard",
  title: "R13: the destroy guard and delete_backup (a final backup is refused)",
  command: ["pnpm", "test", "--filter", "@tc/core", "lifecycle/guard", "--no-passWithNoTests"],
};
const extrasPages = {
  id: "extras-pages",
  title:
    "16.10: the tabs, the dashboard and the bell in bn and en; flag off; another customer's server",
  command: ["pnpm", "test", "--filter", "@tc/web", "_extras/pages", "--no-passWithNoTests"],
};
const extrasAnchors = {
  id: "extras-mockup-anchors",
  title: "U1, U11: every state carries the classes of its shared mockup page, bn and en",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "_extras/mockup-anchors",
    "--no-passWithNoTests",
  ],
};
const extrasMessages = {
  id: "extras-messages",
  title: "U5: bn and en have the same keys and no forbidden wording",
  command: ["pnpm", "test", "--filter", "@tc/web", "messages/extras", "--no-passWithNoTests"],
};
TASKS["WP5-T6"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  crossTenant,
  extrasCores,
  extrasGuard,
  extrasRepos,
  extrasViews,
  extrasPages,
  extrasAnchors,
  extrasMessages,
  repo,
];

// WP5-T6b: renewNow, restoreToNewServer (WP5-T6 left them as "coming soon"). addDisk is not built (open
// point in JOURNEY.md). Each proof has its own line; `--no-passWithNoTests` makes an empty selection fail.
const orderKindsRenew = {
  id: "renew-now",
  title:
    "R4, R7, R8: renewNow charges once per period from the wallet, resumes from grace, refuses another customer's server (database)",
  command: ["pnpm", "test", "--filter", "@tc/core", "lifecycle/renew-now", "--no-passWithNoTests"],
};
const orderKindsRestore = {
  id: "restore-order",
  title:
    "R7, R8, R16: a restore is one paid order; own backup, same Region, disk not smaller, create payload names the backup (database)",
  command: ["pnpm", "test", "--filter", "@tc/core", "restore", "--no-passWithNoTests"],
};
const orderKindsCores = {
  id: "order-kinds-cores",
  title: "R9: the Server Action cores of renewNow and the restore draft, public errors only",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "server/extras-actions",
    "server/order-actions",
    "--no-passWithNoTests",
  ],
};
const orderKindsSweep = {
  id: "order-kinds-sweep",
  title: "R8 sweep: every new Server Action is registered with a proof that exists",
  command: ["pnpm", "test", "--filter", "@tc/web", "server/endpoint-sweep", "--no-passWithNoTests"],
};
TASKS["WP5-T6b"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  orderKindsRenew,
  orderKindsRestore,
  orderKindsCores,
  extrasPages,
  extrasAnchors,
  extrasMessages,
  orderKindsSweep,
  repo,
];

// WP5-T6c: addDisk for a Linux server (16.10 Storage). A disk is one paid order: the anchor row of the
// Region priced per GB-month by the pricing engine, the size as the quantity, the customer's own
// server only, behind the flag `disk`. Each proof has its own line; `--no-passWithNoTests` makes an
// empty selection fail; tests/repo/verify-cli.test.mjs asserts that the files exist.
const diskProducts = {
  id: "disk-products",
  title:
    "R4, R11, R16: the disk config is parsed field by field; only the active per-GB anchor of the Region resolves; the server rule",
  command: ["pnpm", "test", "--filter", "@tc/core", "products/disk", "--no-passWithNoTests"],
};
const diskOrder = {
  id: "disk-order",
  title:
    "R4, R7, R8, R12: addDisk is one paid order priced per GB; a second placement charges nothing; another customer's server answers like a missing one (database)",
  command: ["pnpm", "test", "--filter", "@tc/core", "orders/disk-order", "--no-passWithNoTests"],
};
const diskCatalogGuard = {
  id: "disk-catalog-guard",
  title:
    "The seeded disk anchor is never written or deactivated by the catalog sync (plan in core, write in db)",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "products/catalog-sync",
    "--no-passWithNoTests",
  ],
};
const diskCatalogWrite = {
  id: "disk-catalog-write",
  title:
    "The seeded disk anchor: two rows from migration 0008, and applyCatalogScope refuses family disk (database)",
  command: ["pnpm", "test", "--filter", "@tc/db", "test/catalog-sync", "--no-passWithNoTests"],
};
const diskCores = {
  id: "disk-cores",
  title:
    "R9, R11: the addDisk core authenticates, validates, rate limits, then executes; public errors only",
  command: ["pnpm", "test", "--filter", "@tc/web", "server/disk-actions", "--no-passWithNoTests"],
};
const diskViews = {
  id: "disk-views",
  title:
    "R12: the add-disk offer exists only behind the flag, for a live server, from the anchor of its Region",
  command: ["pnpm", "test", "--filter", "@tc/web", "server/extras-view", "--no-passWithNoTests"],
};
const diskLinks = {
  id: "disk-order-links",
  title: "16.11: a disk order goes back to the servers and opens the servers, not a server page",
  command: ["pnpm", "test", "--filter", "@tc/web", "orders/family-links", "--no-passWithNoTests"],
};
TASKS["WP5-T6c"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  diskProducts,
  diskOrder,
  diskCatalogGuard,
  diskCatalogWrite,
  diskCores,
  diskViews,
  diskLinks,
  extrasPages,
  extrasMessages,
  orderKindsSweep,
  repo,
];

// WP4-T7: the server screens (list, configurator, review, order status, detail, SSH keys) with fakes,
// the Server Action cores, and the Playwright smoke that says BLOCKED when it cannot run. The staging
// proof (a server ordered at 360 px in bn, scripts/playwright-servers.mjs) and the database-backed
// catalog reader test are manual VERIFY steps / the db gate (JOURNEY.md).
const serverActionCores = {
  id: "server-action-cores",
  title:
    "R9, R7, R8: draft, placement and SSH key actions: order of checks, public errors, no AWS text",
  command: ["pnpm", "test", "--filter", "@tc/web", "server/order-actions", "--no-passWithNoTests"],
};
const serverKeyActions = {
  id: "server-key-actions",
  title: "U10: SSH key removal needs a fresh sign-in and the typed name; add is idempotent",
  command: ["pnpm", "test", "--filter", "@tc/web", "server/key-actions", "--no-passWithNoTests"],
};
const serverPages = {
  id: "server-pages",
  title: "16.10, 16.11: the pages in bn and en, price_changed, shortfall, cross-tenant answers",
  command: ["pnpm", "test", "--filter", "@tc/web", "servers/pages", "--no-passWithNoTests"],
};
const serverAnchors = {
  id: "server-mockup-anchors",
  title: "U1, U11: every screen state carries the classes of its shared mockup page, bn and en",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "servers/mockup-anchors",
    "--no-passWithNoTests",
  ],
};
const serverSmoke = {
  id: "server-smoke-blocked",
  title: "the Playwright smoke reports BLOCKED, never PASS, without a browser or a staging URL",
  command: ["pnpm", "test", "--filter", "repo", "servers-smoke", "--no-passWithNoTests"],
};
const catalogList = {
  id: "catalog-list",
  title: "the configurator reads active catalog rows of one family as web_rw (database)",
  command: ["pnpm", "test", "--filter", "@tc/db", "catalog-repo", "--no-passWithNoTests"],
};
TASKS["WP4-T7"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  serverActionCores,
  serverKeyActions,
  serverPages,
  serverAnchors,
  serverSmoke,
  catalogList,
  web,
  repo,
];

// WP9-T2: the cross-tenant and isolation sweep. Four lines: every repository method of the customer
// (the existing completeness test of the cross-tenant cases), every admin repository method (reads and
// writes) behind the active-admin and role gate, the admin app source scan (page, route, action, flow)
// and the web register (every Server Action, route handler and id page with a proof that exists).
const sweepCustomerRepos = {
  id: "sweep-customer-repos",
  title:
    "WP9-T2: every method of customerRepos has a cross-tenant case and binds the customer id (R8)",
  command: ["pnpm", "test", "--filter", "@tc/db", "test/cross-tenant", "--no-passWithNoTests"],
};
const sweepAdminRepos = {
  id: "sweep-admin-repos",
  title:
    "WP9-T2: every method of adminRepos refuses a disabled, missing or wrong-role admin (R10, R16)",
  command: ["pnpm", "test", "--filter", "@tc/db", "admin-gates", "--no-passWithNoTests"],
};
const sweepAdminApp = {
  id: "sweep-admin-app",
  title:
    "WP9-T2: every admin page, route, Server Action, flow and data module begins with the admin gate",
  command: ["pnpm", "test", "--filter", "@tc/admin", "admin-sweep", "--no-passWithNoTests"],
};
const sweepWebEndpoints = {
  id: "sweep-web-endpoints",
  title:
    "WP9-T2: every web endpoint is registered with a proof that exists, and the id pages answer like a missing row",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "endpoint-sweep",
    "loaders-tenancy",
    "--no-passWithNoTests",
  ],
};
TASKS["WP9-T2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  sweepCustomerRepos,
  sweepAdminRepos,
  sweepAdminApp,
  sweepWebEndpoints,
  repo,
];

// WP9-T3: 50 parallel orders (no double spend, no over-reservation, clean refusals), 20 parallel
// verifications that credit once, and the restore drill. The drill needs pg_dump and the local database:
// without them it prints BLOCKED and exits 2, which fails this line (a skipped drill is not a pass).
// The point-in-time restore on RDS is a manual VERIFY step (docs/runbooks/restore-drill.md).
const purchaseStorm = {
  id: "purchase-concurrency",
  title: "WP9-T3: 50 parallel orders: no double spend, no over-reservation, losers refused cleanly",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "orders/purchase-concurrency",
    "--no-passWithNoTests",
  ],
};
const topUpStorm = {
  id: "topup-parallel-credit",
  title: "WP9-T3: the same EPS payment verified 20 times in parallel credits exactly once",
  command: ["pnpm", "test", "--filter", "@tc/eps", "proof-parallel-credit", "--no-passWithNoTests"],
};
const restoreDrillUnit = {
  id: "restore-drill-logic",
  title:
    "WP9-T3: the drill refuses staging and remote databases and is BLOCKED, never a pass, without pg_dump",
  command: ["pnpm", "test", "--filter", "repo", "restore-drill", "--no-passWithNoTests"],
};
const restoreDrill = {
  id: "restore-drill",
  title: "WP9-T3: a dump of the local database restores and the copy holds the ledger invariants",
  command: ["node", "scripts/restore-drill.mjs", "--allow-empty"],
};
TASKS["WP9-T3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  purchaseStorm,
  topUpStorm,
  restoreDrillUnit,
  restoreDrill,
  repo,
];

// WPP-T1 to WPP-T4: the public site. Each filter names files; `--no-passWithNoTests` makes an empty
// selection fail, and tests/repo/verify-cli.test.mjs asserts that the files exist.
const wppWeb = (id, title, ...filters) => ({
  id,
  title,
  command: ["pnpm", "test", "--filter", "@tc/web", ...filters, "--no-passWithNoTests"],
});
const wppCatalog = wppWeb(
  "wpp-catalog",
  "R4, R12, R16: every offer is the pricing engine's output; a flag off or an unreadable catalog shows nothing",
  "server/public/catalog",
);
const wppPages = wppWeb(
  "wpp-pages",
  "16.8, 16.13, U6: the pages in bn and en, one h1, landmarks, AWS statements and trademark line, FAQ answers, placeholders",
  "(public)/public-pages",
);
const wppAnchors = wppWeb(
  "wpp-mockup-anchors",
  "U1, U11: every page carries the classes of its shared mockup page, bn and en",
  "(public)/public-anchors",
);
const wppMessages = wppWeb(
  "wpp-messages",
  "U5: bn and en have the same keys and no forbidden wording",
  "messages/public",
);
const wppSeo = wppWeb(
  "wpp-seo",
  "16.8: canonical, hreflang, escaped JSON-LD, sitemap, robots, noindex on every non-public path",
  "server/public/seo",
  "server/public/sitemap",
  "proxy-indexing",
  "pages.test",
);
const wppNotify = wppWeb(
  "wpp-notify-me",
  "R9, R7, R14: notify me in the R9 order, idempotent, rate limited, no address in a log",
  "server/public/notify-me",
  "endpoint-sweep",
);
const wppRepo = {
  id: "wpp-visitor-waitlist",
  title: "R7, R8: the flag-off interest row by e-mail is idempotent and validated (database)",
  command: ["pnpm", "test", "--filter", "@tc/db", "test/visitor-waitlist", "--no-passWithNoTests"],
};
const wppBase = [specSync, baselineSync, lint, typecheck, format];
TASKS["WPP-T1"] = [...wppBase, wppCatalog, wppPages, wppAnchors, wppMessages, repo];
TASKS["WPP-T2"] = [...wppBase, wppPages, wppAnchors, wppMessages, repo];
TASKS["WPP-T3"] = [...wppBase, wppSeo, wppPages, repo];
TASKS["WPP-T4"] = [...wppBase, wppNotify, wppRepo, wppPages, repo];
// WP9-T4: the runbooks of Section M. The repository test checks that every page listed in
// docs/runbooks/README.md exists, every `pnpm` command cited names a script of package.json, and the
// "walked through" column is empty until the owner fills it. The signed-in support form core (R9 order,
// rate limit, audit, single-line text rule) is proven by its own tests in apps/web. That a person walked
// through each runbook is a manual step of the owner.
const runbooksIndex = {
  id: "runbooks",
  title:
    "WP9-T4: every runbook of the README exists, every cited pnpm script exists, nobody is claimed to have walked",
  command: ["pnpm", "test", "--filter", "repo", "runbooks", "--no-passWithNoTests"],
};
const supportFormCore = {
  id: "support-form-core",
  title:
    "WP9-T4: the support form core authenticates, validates, rate limits, writes and audits; one-line text refuses CR, LF, NEL, LS, PS and control characters",
  command: ["pnpm", "test", "--filter", "@tc/web", "support-actions", "--no-passWithNoTests"],
};
TASKS["WP9-T4"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  runbooksIndex,
  supportFormCore,
  repo,
];
// WP9-T4b: the signed-in support form. The repository writes with the columns web_rw may insert and
// derives the row id from the customer and the idempotency key (R7); the cross-tenant case set and the
// repository test prove it; the page states are cross-checked against the shared mockup (U1).
const supportRepoDb = {
  id: "support-repo-db",
  title:
    "WP9-T4b: customerRepos.support inserts only the granted columns, replays by key, and answers a foreign related resource like a missing one",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "support-repo",
    "cross-tenant.test",
    "--no-passWithNoTests",
  ],
};
const supportFormWeb = {
  id: "support-form-web",
  title:
    "WP9-T4b: the support page states follow the mockup in bn and en, its messages match, and the action is in the endpoint register",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/web",
    "support",
    "endpoint-sweep",
    "--no-passWithNoTests",
  ],
};
TASKS["WP9-T4b"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  supportRepoDb,
  supportFormWeb,
  repo,
];

// WP9-T5: the wording pass. One machine check over every message namespace of web, admin and the kit
// in bn and en (same keys and placeholders, no empty or copied English text, no ARN, account id, raw
// AWS error or internal name, the marks of 16.13, trademark line), and the same rules on the notify
// templates. The legal placeholders stay and are listed as Needs decision; the review by a native
// speaker is a manual step of the owner.
const wordingMessages = {
  id: "wording-messages",
  title:
    "WP9-T5: web and admin messages in bn and en: same keys, no empty or copied text, placeholders match, no forbidden wording",
  command: ["pnpm", "test", "--filter", "@tc/web", "messages/wording", "--no-passWithNoTests"],
};
const wordingNotify = {
  id: "wording-notify",
  title: "WP9-T5: the email and SMS templates follow the same wording rules in bn and en",
  command: ["pnpm", "test", "--filter", "@tc/notify", "wording", "--no-passWithNoTests"],
};
TASKS["WP9-T5"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  wordingMessages,
  wordingNotify,
  repo,
];

// WPA-P1: pricing, margin and commission are managed by an admin from the price list (/pricing/book).
// Each proof has its own line; `--no-passWithNoTests` makes an empty selection fail;
// tests/repo/verify-cli.test.mjs asserts that the files exist.
const priceBookEngine = {
  id: "price-book-engine",
  title:
    "R4: margin (percent or fixed paisa), commission and half-up rounding are the engine's, with the section 8 vectors unchanged",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "pricing/book",
    "pricing/quote",
    "--no-passWithNoTests",
  ],
};
const priceBookRates = {
  id: "price-book-rates",
  title:
    "R16: the margin of the family reaches the price of a new order from its start; an order already priced keeps its snapshot; a stored book that does not parse prices nothing; the live preview",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "rates/price-book-in-force",
    "rates/preview-book",
    "--no-passWithNoTests",
  ],
};
const priceBookDb = {
  id: "price-book-db",
  title:
    "R10, R16: the price book and the base cost of the disk anchor are written only by an active finance or superadmin admin, with a reason, audited; the one column grant",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "admin-price-book",
    "admin-gates",
    "admin-repos",
    "--no-passWithNoTests",
  ],
};
const priceBookAdmin = {
  id: "price-book-admin",
  title:
    "R9, R10: the flow authorizes first, the preview comes before the save, the page is bn and en and built from the theme classes, the sweep of the admin app",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/admin",
    "server/price-book-flow",
    "server/price-book-draft",
    "price-book-pages",
    "price-book-messages",
    "server/admin-sweep",
    "--no-passWithNoTests",
  ],
};
TASKS["WPA-P1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  priceBookEngine,
  priceBookRates,
  priceBookDb,
  priceBookAdmin,
  db,
  core,
  admin,
  web,
  repo,
];

// WPA-P2: (1) the admin sees the plan change of a container service or a CDN (applied plan, pending plan,
// failure mark, apply operation) and clears the mark by an audited action that queues an operation (no
// AWS call, no ledger line); (2) the disk and the load balancer orders read the editable config prices
// (the config row wins for new orders when the market has a usable one, else the catalog row stays);
// (3) the daily snapshot charge reads `config_price.snapshot_gb_month` through the pricing engine, with
// the old `metering.snapshot_gb_month_minor` only as a transition fallback. No migration. The core and db
// suites need the local PostgreSQL (pnpm db:up). Each proof has its own line; `--no-passWithNoTests` makes
// an empty selection fail; tests/repo/verify-cli.test.mjs asserts that the files exist.
const planMarkDb = {
  id: "plan-mark-db",
  title:
    "R10, R16: the plan state is read and the failure mark cleared only by an active ops or superadmin admin, with a reason, audited, by a queued operation and no ledger row; the gate of every method",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/db",
    "admin-plan-mark",
    "admin-gates",
    "operation-kinds",
    "--no-passWithNoTests",
  ],
};
const planMarkAws = {
  id: "plan-mark-aws",
  title:
    "R1: the adapters of the container service and the CDN clear the mark by a config patch, with no AWS call",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/aws",
    "container-service",
    "cdn",
    "adapter-types",
    "--no-passWithNoTests",
  ],
};
const planMarkAdmin = {
  id: "plan-mark-admin",
  title:
    "R9, R10: the flow authorizes first, the page is bn and en and built from the theme classes, the admin sweep, the truthful price badge",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/admin",
    "server/plan-mark-flow",
    "plan-change-pages",
    "plan-change-messages",
    "server/admin-sweep",
    "server/wpu-g10-data",
    "--no-passWithNoTests",
  ],
};
const configPriceOrders = {
  id: "config-price-orders",
  title:
    "R4, R16: the disk and the load balancer are priced by the engine from the config price in force, else the catalog row; a row that cannot be a price sells nothing",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "products/config-price-source",
    "orders/config-price-families",
    "orders/disk-order",
    "--no-passWithNoTests",
  ],
};
const snapshotMetering = {
  id: "snapshot-metering",
  title:
    "R4, R5: the daily snapshot charge reads the config price through the engine, with the old key as the transition fallback; the posting is unchanged",
  command: [
    "pnpm",
    "test",
    "--filter",
    "@tc/core",
    "metering",
    "products/snapshot-price",
    "--no-passWithNoTests",
  ],
};
TASKS["WPA-P2"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  planMarkDb,
  planMarkAws,
  planMarkAdmin,
  configPriceOrders,
  snapshotMetering,
  db,
  core,
  aws,
  admin,
  scheduler,
  repo,
];

// WPU-G3: the image (Lightsail blueprint) and the SSH key of the Linux create wizard. GetBlueprints in the
// catalog sync (family `blueprint`, no new table), the admin allow-list (market setting `image_allowlist`,
// audited), the order gate for the image, the provisioner that launches the chosen image, the wizard step
// with ImageTile, the required key, and the login user of the server's own image in the Connect help.
// The db suite needs the local PostgreSQL (pnpm db:up).
TASKS["WPU-G3"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  aws,
  db,
  catalogSyncAll,
  provisioner,
  ui,
  web,
  admin,
  repo,
];

// WPU-G10: the console behaviours of the create wizard and the admin settings behind it. A key made in the
// browser or pasted inside the wizard (web), the minimum plan power of an image (GetBlueprints minPower in
// the catalog sync, the admin override in the allow-list, the plan check of the wizard and of the order
// gate), the tier limits as an audited `settings` row (scope tier) read by the order path, and the dated
// config prices with their admin screen (core, db, admin). No migration. The db and core suites need the
// local PostgreSQL (pnpm db:up).
TASKS["WPU-G10"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  aws,
  db,
  catalogSyncAll,
  ui,
  web,
  admin,
  repo,
];

// WPU-G11: remove and replace a certificate on a container service, a CDN distribution and a load
// balancer (detach, delete, request again; typed domain and a fresh sign-in), and the parameters of a
// database (a whitelist per engine in core, a last-known list kept in the resource config, a reboot).
// New operation kinds (db), adapter actions (aws) and their roles (a repo test ties the allow-list to
// the adapters). No migration. The db and core suites need the local PostgreSQL (pnpm db:up).
TASKS["WPU-G11"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  core,
  db,
  aws,
  web,
  admin,
  repo,
];

// WPU-H1: money safety. The proof test of the ledger at the database: as web_rw, worker_rw and admin_rw
// an unbalanced, single-sided, zero, negative or mixed-currency post is refused by the DATABASE (the
// application check is skipped on purpose), a reversal balances, and UPDATE, DELETE and TRUNCATE of the
// ledger and the audit log are refused. The second part is the time budget of the projects that use the
// shared PostgreSQL (vitest.db-budgets.mjs). The db and core suites need the local PostgreSQL (pnpm db:up).
const ledgerUnbalanced = {
  id: "ledger-unbalanced",
  title:
    "R5 at the database: the ledger refuses what does not balance, as the three application roles",
  command: ["pnpm", "test", "--filter", "@tc/core", "ledger/unbalanced-db", "--no-passWithNoTests"],
};
TASKS["WPU-H1"] = [
  specSync,
  baselineSync,
  lint,
  typecheck,
  format,
  ledgerUnbalanced,
  core,
  db,
  repo,
];

// WPU-I1: the customer invoice is the Bangladesh NBR Mushak 6.3 tax invoice with the seller's legal name,
// BIN and address. The renderer, the seller rules and the amount in words (core), the `invoice_seller`
// setting, its audited admin repository and the refusal to issue without it (db, with the local
// PostgreSQL), the page and the printable document of the customer (web), and /pricing/seller with its
// flow and sweep (admin). No AWS call.
TASKS["WPU-I1"] = [specSync, baselineSync, lint, typecheck, format, core, db, web, admin, repo];

// Items that only a person or AWS can prove (verify/manual-proofs.mjs). The check fails with BLOCKED
// (exit 2) until verify/manual-proofs.json holds a valid record for the id; it is never a pass.
const manual = (proofId) => {
  if (!Object.hasOwn(MANUAL_PROOFS, proofId)) throw new Error(`unknown manual proof ${proofId}`);
  return {
    id: `manual-${proofId}`,
    title: `Manual proof ${proofId} (${MANUAL_PROOFS[proofId].who}): ${MANUAL_PROOFS[proofId].description}`,
    command: ["node", "scripts/manual-proof.mjs", proofId],
  };
};

// A gate is the concatenation of the checks of its tasks, once per check id (the first one stays, so the
// cheap shared checks come first). The same id with another command is a defect and stops the load.
// A part is a task id (its TASKS block), or { checks } for a row without a TASKS block.
function gate(...parts) {
  const checks = parts.flatMap((part) => {
    if (typeof part !== "string") return part.checks;
    if (!Object.hasOwn(TASKS, part)) throw new Error(`gate part ${part} has no TASKS block`);
    return TASKS[part];
  });
  const seen = new Map();
  const out = [];
  for (const check of checks) {
    const command = check.command.join(" ");
    if (seen.has(check.id)) {
      if (seen.get(check.id) !== command) {
        throw new Error(`check ${check.id} has two different commands`);
      }
      continue;
    }
    seen.set(check.id, command);
    out.push(check);
  }
  return out;
}

// The days of docs/spec/I-timeline.md and the rows of docs/spec/E-backlog-and-prompts.md (E.3) and G.
// Deviations from the first plan of this table are written in JOURNEY.md.
// M1 (Wed 11): WP0, WP1, WP2, WPU. WP1-T3 (pricing engine) has no TASKS block: its vectors run in @tc/core.
const M1 = gate(
  "WP0-T1",
  "WP0-T2",
  { checks: [manual("wp0-t2-staging-deploy")] },
  "WP0-T3",
  { checks: [manual("wp0-t3-staging-database")] },
  "WP0-T3b",
  "WP0-T4",
  { checks: [manual("wp0-t4-staging-outputs")] },
  "WP0-T5",
  { checks: [manual("wp0-t5-devops-confirmation")] },
  "WP1-T1",
  "WP1-T2",
  { checks: [core] },
  "WP1-T4",
  "WP1-T5",
  "WP2-T1",
  "WP2-T2",
  "WP2-T3",
  "WP2-T4",
  "WP2-T5",
  { checks: [manual("m1-staging-signup-catalog")] },
  "WPU-T1",
  "WPU-T2",
  "WPU-T3",
  "WPU-T4",
);
// M2 (Thu 12): the money path and the first server.
const M2 = gate(
  "WP3-T1",
  "WP3-T2",
  "WP3-T3",
  "WP3-T4",
  { checks: [manual("wp3-t4-staging-topup")] },
  "WP3-T5",
  "WP4-T1",
  "WP4-T2",
  "WP4-T3",
  "WP4-T4",
  "WP4-T5",
  { checks: [manual("wp4-t5-staging-ssh")] },
  { checks: [manual("m2-ui-review")] },
);
// M3 (Fri 13): WP4 end, WP5. WP4-T6 has no TASKS block: its local part is the two checks of WP4-T5 and the
// isolation test in tc-pool-dev is manual. WP0-T6 ("by Fri 13", E.3) is here, not in M5: the production
// deploy workflow requires M5, so a proof "a tag deploy succeeded" inside M5 could never be recorded.
const M3 = gate(
  { checks: [specSync, baselineSync, lint, typecheck, format, bootstrapFirewall, isolationLocal] },
  { checks: [manual("wp4-t6-isolation-pool-dev")] },
  "WP4-T7",
  { checks: [manual("wp4-t7-staging-playwright")] },
  "WP5-T1",
  "WP5-T2",
  "WP5-T3",
  "WP5-T4",
  "WP5-T5",
  { checks: [manual("m3-staging-notifications")] },
  "WP5-T6",
  "WP5-T6b",
  "WP5-T6c",
  "WP0-T6",
  { checks: [manual("wp0-t6-production-tag-deploy")] },
);
// M4 (Sat 14): Gate A families (WP6), admin (WP8-T1 to T6), public pages (WPP).
const M4 = gate(
  "WP6-T1",
  "WP6-T1b",
  "WP6-T2",
  "WP6-T2s",
  "WP6-T3",
  "WP6-T4",
  "WP6-T4s",
  { checks: [manual("m4-gate-a-staging-cycles")] },
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
  { checks: [manual("m4-public-pages-staging")] },
);
// M5 (Sun 15): Gate B families, metering, reconciliation, the P1 admin screens. The production deploy
// workflow runs this gate before it deploys, so M5 holds no proof that a production deploy exists.
const M5 = gate(
  "WP7-T1",
  "WP7-T2",
  "WP7-T3",
  "WP7-T4",
  { checks: [manual("m5-gate-b-staging-cycles")] },
  "WP7-T5",
  "WP7-T6",
  { checks: [manual("m5-reconciler-staging")] },
  "WP8-T7",
);
// M6 (Mon 16): hardening and beta. WP9-T1 (Section 15 evidence) and the K list are people's proofs.
const M6 = gate(
  { checks: [manual("wp9-t1-section15-evidence")] },
  "WP9-T2",
  "WP9-T3",
  { checks: [manual("wp9-t3-pitr-restore")] },
  "WP9-T4",
  { checks: [manual("wp9-t4-runbooks-walked")] },
  "WP9-T4b",
  "WP9-T5",
  { checks: [manual("wp9-t5-legal-final")] },
  { checks: [manual("wp9-t6-production-tag-deploy")] },
  { checks: [manual("wp9-t6-beta-payments")] },
  { checks: [manual("wp9-go-no-go-list")] },
);
// M7 (Tue 17): everything of M0 to M6, then the launch items of WP10 (all people's proofs).
const M7 = gate(
  { checks: WP0_T1 },
  { checks: M1 },
  { checks: M2 },
  { checks: M3 },
  { checks: M4 },
  { checks: M5 },
  { checks: M6 },
  {
    checks: [
      manual("wp10-t1-flags-as-decided"),
      manual("wp10-t1-alarms-deliver"),
      manual("wp10-t1-on-call-confirmed"),
      manual("wp10-t2-first-day-report"),
    ],
  },
);

export const GATES = { M0: WP0_T1, M1, M2, M3, M4, M5, M6, M7 };

// `packages` holds package names (from changedPackages) or "all".
export function quickChecks(packages) {
  if (packages === "all") return [lint, typecheck, test];
  const folders = Object.entries(readWorkspacePackages(root))
    .filter(([, name]) => packages.includes(name))
    .map(([folder]) => folder);
  return [
    {
      id: "lint",
      title: "ESLint on the changed packages",
      command: ["pnpm", "exec", "eslint", "-c", "eslint.config.mjs", ...folders],
    },
    {
      id: "typecheck",
      title: "TypeScript in the changed packages and what depends on them",
      command: ["pnpm", ...packages.flatMap((name) => ["--filter", `...${name}`]), "typecheck"],
    },
    {
      id: "test",
      title: "Vitest in the changed packages",
      command: ["pnpm", "test", ...packages.flatMap((name) => ["--project", name])],
    },
  ];
}
