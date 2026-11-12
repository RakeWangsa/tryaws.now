// The configuration of the migrator, read from the environment of the Lambda. The master user comes
// from the linked Postgres component (SST_RESOURCE_Postgres, a JSON object with host, port, username,
// password, database) and the five role passwords from the linked secrets (SST_RESOURCE_<Name>, a JSON
// object with `value`). Nothing is read from DATABASE_URL, and a failure has one fixed message that
// holds no value (R3, R14, R16).

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

export interface MigratorConfig {
  readonly masterUrl: string;
  readonly rolePasswords: RolePasswords;
  readonly migrationsDir: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9_]{1,63}$/;

function json(env: Env, name: string): Record<string, unknown> | undefined {
  const raw = env[`SST_RESOURCE_${name}`];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

export function readMigratorConfig(env: Env): MigratorConfig {
  const fail = (): never => {
    throw new Error(MIGRATOR_ERROR);
  };
  // TLS only (R2): the same two modes as packages/db/env.ts.
  const sslmode = env.DB_SSLMODE ?? "verify-full";
  if (sslmode !== "require" && sslmode !== "verify-full") return fail();

  const master = json(env, "Postgres");
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
    const value = text(json(env, secret)?.value);
    if (value === undefined) return fail();
    rolePasswords[role] = value;
  }

  const migrationsDir = text(env.MIGRATIONS_DIR);
  if (migrationsDir === undefined) return fail();

  return {
    masterUrl: `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslmode}`,
    rolePasswords,
    migrationsDir,
  };
}
