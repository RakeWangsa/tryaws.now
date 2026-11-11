// What `pnpm verify` runs. A gate or task that is not listed here has no proof and fails (R16).
import { resolve } from "node:path";
import { readWorkspacePackages } from "../scripts/lib/changed-packages.mjs";

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

export const GATES = {
  M0: WP0_T1,
  M1: [],
  M2: [],
  M3: [],
  M4: [],
  M5: [],
  M6: [],
  M7: [],
};

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
