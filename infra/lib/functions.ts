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
  | "SmsApiKey";

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
    // daily and on demand (admin invokes it)
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
    // functions/notifier/index.ts exports createNotifierHandler only; the process entry is WP5-T5.
    handlerExport: "handler",
    exportExists: false,
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
    exportExists: false,
    placement: "none",
    dbRole: "none",
    secrets: [],
    poolRoles: [],
    trigger: { kind: "cognito" },
    timeoutSeconds: 5,
    memoryMb: 256,
  },
];

// Only these functions may assume roles in pool or DNS accounts (R1, 3.2). The web tier never does.
export const POOL_ROLE_FUNCTIONS: readonly string[] = FUNCTIONS.filter(
  (f) => f.poolRoles.length > 0,
).map((f) => f.dir);

// Roles assumed by a function, as role names the trust policies of 6.3 refer to.
export function rolesOf(dir: string): readonly PoolRole[] {
  return FUNCTIONS.find((f) => f.dir === dir)?.poolRoles ?? [];
}
