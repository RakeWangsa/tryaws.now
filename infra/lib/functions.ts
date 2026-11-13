// The function table: which function of functions/ becomes which SST function, with its trigger,
// its linked secrets and the roles it may assume (3.2, 6.3). Pure data. The SST declarations in
// infra/stacks/workers.ts read this table, and tests/repo/infra-lib.test.mjs compares it with the
// folders of functions/ and with the spec.

export type PoolRole =
  | "TcProvisioner"
  | "TcDnsProvisioner"
  | "TcReader"
  | "TcDnsReader"
  | "TcAccessDetails"
  | "TcBillingReader";

// The database user of the function. Functions never get the master user, except migrator (3.3).
export type DbRole = "worker_rw" | "migrator" | "none";

export type SecretName =
  | "EpsMerchantId"
  | "EpsStoreId"
  | "EpsUsername"
  | "EpsPassword"
  | "EpsHashKey"
  | "EpsLimitKey"
  | "OrderDraftSecret"
  | "AuthLimitKey"
  | "OtpHashKey"
  | "SmsApiKey"
  | "AdminIpLimitKey";

export const ALL_SECRETS: readonly SecretName[] = [
  "EpsMerchantId",
  "EpsStoreId",
  "EpsUsername",
  "EpsPassword",
  "EpsHashKey",
  "EpsLimitKey",
  "OrderDraftSecret",
  "AuthLimitKey",
  "OtpHashKey",
  "SmsApiKey",
  "AdminIpLimitKey",
];

// The nine names of apps/web/server/secrets.ts (SecretName) are the web's. SmsApiKey belongs to the
// notifier (3.2).
export const WEB_SECRETS: readonly SecretName[] = [
  "EpsMerchantId",
  "EpsStoreId",
  "EpsUsername",
  "EpsPassword",
  "EpsHashKey",
  "EpsLimitKey",
  "OrderDraftSecret",
  "AuthLimitKey",
  "OtpHashKey",
];

// The admin app's own secret (WPU-X1): the HMAC key of its IP rate-limit subject. Linked to the admin
// app only.
export const ADMIN_SECRETS: readonly SecretName[] = ["AdminIpLimitKey"];

// Per-role database password secrets (sst.Secret). Each function gets only the secret of its own
// role. The migrator reads all five to create the roles; nothing else holds them.
export const DB_ROLES = ["web_rw", "admin_rw", "worker_rw", "migrator", "report_ro"] as const;
export type DbRoleName = (typeof DB_ROLES)[number];
export const DB_PASSWORD_SECRET: Readonly<Record<DbRoleName, string>> = {
  web_rw: "DbPasswordWebRw",
  admin_rw: "DbPasswordAdminRw",
  worker_rw: "DbPasswordWorkerRw",
  migrator: "DbPasswordMigrator",
  report_ro: "DbPasswordReportRo",
};
// 3.3: these four are listed in the proxy credentials; migrator uses the master user to create roles.
export const PROXY_ROLES: readonly DbRoleName[] = ["web_rw", "admin_rw", "worker_rw", "report_ro"];

export type Placement = "app" | "isolated" | "none";

export interface FunctionSpec {
  // folder of functions/
  readonly dir: string;
  // IAM role name part when it must differ from `dir` (a second function built from the same folder)
  readonly name?: string;
  // SST component name
  readonly component: string;
  // name of the export in functions/<dir>/index.ts
  readonly handlerExport: string;
  // false while the export does not exist yet (JOURNEY.md hand-off); the stack still wires the path
  readonly exportExists: boolean;
  readonly placement: Placement;
  readonly dbRole: DbRole;
  readonly secrets: readonly SecretName[];
  readonly poolRoles: readonly PoolRole[];
  readonly trigger:
    | { readonly kind: "queue"; readonly queue: "provisioning" }
    | { readonly kind: "cron"; readonly schedule: string }
    | { readonly kind: "invoke"; readonly by: readonly ("web" | "admin")[] }
    | { readonly kind: "cognito" }
    | { readonly kind: "deploy" };
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
}

const EPS_FIVE: readonly SecretName[] = [
  "EpsMerchantId",
  "EpsStoreId",
  "EpsUsername",
  "EpsPassword",
  "EpsHashKey",
];

export const FUNCTIONS: readonly FunctionSpec[] = [
  {
    dir: "provisioner",
    component: "Provisioner",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: [],
    poolRoles: ["TcProvisioner", "TcDnsProvisioner"],
    trigger: { kind: "queue", queue: "provisioning" },
    // PROVISIONING_QUEUE.functionTimeoutSeconds of @tc/core
    timeoutSeconds: 60,
    memoryMb: 512,
  },
  {
    dir: "reader",
    component: "Reader",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: [],
    poolRoles: ["TcReader", "TcDnsReader"],
    trigger: { kind: "invoke", by: ["web", "admin"] },
    timeoutSeconds: 30,
    memoryMb: 512,
  },
  {
    dir: "access-details",
    component: "AccessDetails",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: [],
    poolRoles: ["TcAccessDetails"],
    trigger: { kind: "invoke", by: ["web"] },
    timeoutSeconds: 30,
    memoryMb: 512,
  },
  {
    dir: "invoice-renderer",
    component: "InvoiceRenderer",
    handlerExport: "handler",
    exportExists: true,
    placement: "isolated",
    dbRole: "none",
    secrets: [],
    poolRoles: [],
    trigger: { kind: "invoke", by: ["web", "admin"] },
    timeoutSeconds: 60,
    // 3.2: about 2 GB for headless Chromium, x86_64
    memoryMb: 2048,
  },
  {
    dir: "scheduler",
    component: "Scheduler",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: [],
    poolRoles: [],
    trigger: { kind: "cron", schedule: "rate(1 minute)" },
    timeoutSeconds: 55,
    memoryMb: 512,
  },
  {
    dir: "payments-sweeper",
    component: "PaymentsSweeper",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: EPS_FIVE,
    poolRoles: [],
    trigger: { kind: "cron", schedule: "rate(5 minutes)" },
    timeoutSeconds: 120,
    memoryMb: 512,
  },
  {
    dir: "catalog-sync",
    component: "CatalogSync",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: [],
    poolRoles: ["TcReader", "TcDnsReader"],
    // daily; no app role may invoke it (WPU-Z9: no admin grant until an admin invoker exists)
    trigger: { kind: "cron", schedule: "rate(1 day)" },
    timeoutSeconds: 300,
    memoryMb: 512,
  },
  {
    dir: "reconciler",
    component: "Reconciler",
    handlerExport: "reconcilerHandler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: [],
    poolRoles: ["TcReader", "TcDnsReader", "TcBillingReader"],
    trigger: { kind: "cron", schedule: "rate(1 hour)" },
    timeoutSeconds: 300,
    memoryMb: 512,
  },
  {
    dir: "notifier",
    component: "Notifier",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "worker_rw",
    secrets: ["SmsApiKey"],
    poolRoles: [],
    trigger: { kind: "cron", schedule: "rate(1 minute)" },
    timeoutSeconds: 55,
    memoryMb: 512,
  },
  {
    dir: "migrator",
    component: "Migrator",
    handlerExport: "handler",
    exportExists: true,
    placement: "app",
    dbRole: "migrator",
    secrets: [],
    poolRoles: [],
    trigger: { kind: "deploy" },
    timeoutSeconds: 300,
    memoryMb: 512,
  },
  {
    dir: "cognito-messages",
    component: "CognitoMessages",
    handlerExport: "handler",
    exportExists: true,
    placement: "none",
    dbRole: "none",
    secrets: [],
    poolRoles: [],
    trigger: { kind: "cognito" },
    timeoutSeconds: 5,
    memoryMb: 256,
  },
];

// C.13: the ledger check at 02:00 Asia/Dhaka. Dhaka is UTC+6 with no daylight saving, so the schedule is
// 20:00 UTC every day. The reconciler (rate(1 hour)) also runs the ledger check at the end of each run
// (functions/reconciler/handler.ts); this schedule is the guaranteed daily one, with its own function
// and its own role (no pool role: the check reads only the database). Not in FUNCTIONS: it reuses the
// folder of the reconciler, so the one-folder-one-row comparison of the table stays true.
export const LEDGER_CHECK_SCHEDULE = "cron(0 20 * * ? *)";
export const LEDGER_CHECK_FUNCTION: FunctionSpec = {
  dir: "reconciler",
  name: "ledger-check",
  component: "LedgerCheck",
  handlerExport: "ledgerCheckHandler",
  exportExists: true,
  placement: "app",
  dbRole: "worker_rw",
  secrets: [],
  poolRoles: [],
  trigger: { kind: "cron", schedule: LEDGER_CHECK_SCHEDULE },
  timeoutSeconds: 300,
  memoryMb: 512,
};

// The log messages of functions/reconciler/ledger-check.ts that the alarms match (structured JSON logs,
// R14). `ledger_check_ok` is the healthy line: its silence is an alarm too.
export const LEDGER_LOG_MESSAGES = {
  mismatch: "ledger_mismatch",
  failed: "ledger_check_failed",
  ok: "ledger_check_ok",
} as const;
export const LEDGER_METRIC_NAMESPACE = "TiconCloud/Ledger";

// WPU-B3 (audit items 14, 15 and 36): the structured log lines (field `event`, R14) that the alerts match.
// Each one is written by the code named beside it; tests/repo/infra-alerts.test.mjs checks that the text
// is really in that file, so a rename cannot silence an alarm. `severity: "alert"` lines are for a person.
export const ALERT_LOG_EVENTS = {
  // packages/core/capacity/release.ts (log by the provisioner): the units of a failed or destroyed
  // resource could not be given back (row_missing, malformed_record).
  capacityReleaseProblem: "capacity_release_problem",
  // packages/core/invoices/credit-note.ts (log by the scheduler): a credit note refused for 24 hours.
  creditNoteStuck: "credit_note_stuck",
  // packages/core/rates/fx-watch.ts (log by the scheduler): WPU-Y1, the hand-set USD to BDT rate is older than
  // 6 days or missing; written once a day. After 7 days purchases are refused (R16).
  fxRateStaleWarning: "fx_rate_stale_warning",
  // functions/reconciler/reconcile.ts (the hourly run): a run that found orphans or missing resources,
  // could not read something, found stale operations, or could not write usage.
  reconcileFindings: "reconcile_findings",
  reconcileIncomplete: "reconcile_incomplete",
  reconcileStaleOperations: "reconcile_stale_operations",
  reconcileUsageFailed: "reconcile_usage_failed",
  // The healthy line of a run: its silence is an alarm too.
  reconcileOk: "reconcile_ok",
} as const;
export const ALERT_METRIC_NAMESPACE = "TiconCloud/Alerts";
// The reconciler runs every hour and logs reconcile_ok or reconcile_incomplete every time it finishes.
export const RECONCILE_SILENCE_HOURS = 3;
// 24 hours between runs of the daily check plus two hours of slack; the hourly reconciler also logs it.
export const LEDGER_SILENCE_HOURS = 26;

// C.2 and R12: the twelve product-family flags of FEATURE_FLAG_KEYS (packages/db), all off by default.
// A copy, because infra must not import @tc/db at synth time; a repo test compares the two lists. The
// stack output `featureFlagDefaults` is read by scripts/post-deploy-check.mjs after a production deploy.
export const FEATURE_FLAG_KEYS_OF_INFRA = [
  "linux_instance",
  "static_ip",
  "backup",
  "disk",
  "windows_instance",
  "database",
  "load_balancer",
  "bucket",
  "container_service",
  "cdn",
  "dns_zone",
  "domain",
] as const;

export function featureFlagDefaults(): Record<string, boolean> {
  return Object.fromEntries(FEATURE_FLAG_KEYS_OF_INFRA.map((key) => [key, false]));
}

// C.5: the environment of the provisioner that opens the bootstrap beacon port of a new Linux server to
// the NAT addresses only (functions/provisioner/index.ts reads both). The values are required stack
// configuration on staging and production (readStageConfig refuses a deploy without them); a personal
// stage without them sets neither variable, and every Linux create then stops before the static IP (R16).
export const PROVISIONER_NETWORK_ENV = ["TC_PROBE_SOURCES", "TC_VPC_CIDR"] as const;

export function provisionerNetworkEnvironment(config: {
  readonly probeSources: readonly string[];
  readonly vpcCidr: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.probeSources.length > 0) env["TC_PROBE_SOURCES"] = config.probeSources.join(",");
  if (config.vpcCidr !== null) env["TC_VPC_CIDR"] = config.vpcCidr;
  return env;
}

// Only these functions may assume roles in pool or DNS accounts (R1, 3.2). The web tier never does.
export const POOL_ROLE_FUNCTIONS: readonly string[] = FUNCTIONS.filter(
  (f) => f.poolRoles.length > 0,
).map((f) => f.dir);

// Roles assumed by a function, as role names the trust policies of 6.3 refer to.
export function rolesOf(dir: string): readonly PoolRole[] {
  return FUNCTIONS.find((f) => f.dir === dir)?.poolRoles ?? [];
}
