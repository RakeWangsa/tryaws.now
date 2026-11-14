import { secretValue, sstLinks, type LinkSource } from "@tc/db/links";

// The configuration of the migrator, read from the environment of the Lambda and its links. The master
// user comes from the linked Postgres component (host, port, username, password, database) and the
// five role passwords from the linked secrets (`value`). Nothing is read from DATABASE_URL, and a
// failure has one fixed message that holds no value (R3, R14, R16).
//
// WPU-Z15: at run time the links are read through the SST SDK. SST 4.17.2 hands a deployed function
// its links only in an encrypted file (SST_KEY_FILE, SST_KEY), which the SDK's Resource decrypts; only
// `sst dev` sets the variables SST_RESOURCE_<Name>. The links are read through @tc/db/links, the one
// reader of linked values.

export const MIGRATOR_ERROR = "migrator: the configuration is not valid";

// The five roles of migration 0006 and grants.expected.json, and the sst.Secret of each one's
// password. A test compares this table with DB_PASSWORD_SECRET of infra/lib/functions.ts.
export const DB_PASSWORD_SECRETS = {
  web_rw: "DbPasswordWebRw",
  admin_rw: "DbPasswordAdminRw",
  worker_rw: "DbPasswordWorkerRw",
  migrator: "DbPasswordMigrator",
  report_ro: "DbPasswordReportRo",
} as const;
export type RoleName = keyof typeof DB_PASSWORD_SECRETS;
export type RolePasswords = Readonly<Record<RoleName, string>>;

// WPU-Z18: the optional sst.Secret with the Cognito `sub` of the first superadmin. A test compares it
// with FIRST_ADMIN_SUB_SECRET of infra/lib/functions.ts. Its raw value is handed on unchecked; runMigrator
// decides (firstAdminDecision of @tc/db) and never logs it.
export const FIRST_ADMIN_SUB_SECRET = "FirstAdminSub";

export interface MigratorConfig {
  readonly masterUrl: string;
  readonly rolePasswords: RolePasswords;
  readonly migrationsDir: string;
  /** The raw value of FirstAdminSub; undefined when it is not linked, not a string or empty. */
  readonly firstAdminSub?: string | undefined;
  /**
   * WPU-X4: plain environment values of the pool account bootstrap, raw (poolAccountDecision of @tc/db
   * decides): TC_STAGE, TC_POOL_ACCOUNT_IDS and TC_POOL_EXTERNAL_ID (an ExternalId is not a secret, 6.3).
   * Undefined when unset or empty; never a failure of the configuration.
   */
  readonly stage?: string | undefined;
  readonly poolAccountIds?: string | undefined;
  readonly poolExternalId?: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9_]{1,63}$/;

function linked(links: LinkSource, name: string): Record<string, unknown> | undefined {
  const link = links(name);
  return typeof link === "object" && link !== null ? (link as Record<string, unknown>) : undefined;
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

export function readMigratorConfig(env: Env, links: LinkSource = sstLinks): MigratorConfig {
  const fail = (): never => {
    throw new Error(MIGRATOR_ERROR);
  };
  // TLS only (R2): the same two modes as packages/db/env.ts.
  const sslmode = env.DB_SSLMODE ?? "verify-full";
  if (sslmode !== "require" && sslmode !== "verify-full") return fail();

  const master = linked(links, "Postgres");
  const host = text(master?.host);
  const username = text(master?.username);
  const password = text(master?.password);
  const database = text(master?.database);
  const port = typeof master?.port === "number" ? master.port : Number(master?.port);
  if (
    host === undefined ||
    !HOST.test(host) ||
    username === undefined ||
    password === undefined ||
    database === undefined ||
    !NAME.test(database) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return fail();
  }

  const rolePasswords = {} as Record<RoleName, string>;
  for (const [role, secret] of Object.entries(DB_PASSWORD_SECRETS) as [RoleName, string][]) {
    const value = secretValue(links(secret));
    if (value === undefined) return fail();
    rolePasswords[role] = value;
  }

  const migrationsDir = text(env.MIGRATIONS_DIR);
  if (migrationsDir === undefined) return fail();

  return {
    masterUrl: `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslmode}`,
    rolePasswords,
    migrationsDir,
    // Optional: a missing or unreadable link is "no secret", never a failure of the migrations.
    firstAdminSub: secretValue(links(FIRST_ADMIN_SUB_SECRET)),
    stage: text(env.TC_STAGE),
    poolAccountIds: text(env.TC_POOL_ACCOUNT_IDS),
    poolExternalId: text(env.TC_POOL_EXTERNAL_ID),
  };
}
