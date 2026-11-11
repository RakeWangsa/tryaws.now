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
