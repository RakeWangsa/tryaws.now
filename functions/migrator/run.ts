import type { Logger } from "@tc/core";
import {
  firstAdminDecision,
  subPrefix,
  type FirstAdminDecision,
  type FirstAdminOutcome,
} from "@tc/db";
import type { MigratorConfig } from "./config";
import { ensureRoles, type Queryable } from "./roles";

export type { Queryable };

// What the migrator does at deploy time (3.3): with the master user, over TLS only, create the five
// roles with the passwords of the linked secrets, then run the forward-only migrations. Both steps
// are idempotent (R7), so the deploy may invoke it every time. The answer holds counts only, the logs
// hold counts and step names, and every thrown error has a fixed message and no cause (R3, R14, R16).

export interface MasterConnection extends Queryable {
  end(): Promise<void>;
}

export interface MigrationFileHash {
  readonly folderMillis: number;
  readonly hash: string;
}

export interface MigratorDeps {
  readonly config: MigratorConfig;
  readonly connect: (url: string) => Promise<MasterConnection>;
  readonly migrate: (url: string, migrationsDir: string) => Promise<void>;
  /** The hash of every migration file of the folder (C.14): compared with the applied rows. */
  readonly fileHashes: (migrationsDir: string) => readonly MigrationFileHash[];
  /** C.10: creates the platform ledger accounts that do not exist yet, as the table owner. Idempotent. */
  readonly ensureSystemAccounts: (url: string) => Promise<{ readonly created: number }>;
  /**
   * WPU-Z18: in one transaction as the table owner, inserts one superadmin for `sub` only when
   * admin_users has no row at all (bootstrapFirstSuperadmin of @tc/db). Idempotent.
   */
  readonly bootstrapFirstAdmin: (url: string, sub: string) => Promise<FirstAdminOutcome>;
  readonly log: Logger;
}

export interface MigratorReport {
  readonly rolesCreated: number;
  readonly rolesEnabled: number;
  readonly rolesUnchanged: number;
  readonly migrationsApplied: number;
  readonly systemAccountsCreated: number;
  /** WPU-Z18: what the first-superadmin bootstrap did; never the sub. */
  readonly firstAdmin: FirstAdminDecision;
}

const APPLIED_MIGRATIONS =
  "select hash, created_at from drizzle.__drizzle_migrations order by created_at";

/**
 * C.14. drizzle stores the sha256 of each migration file it applied and never looks at it again. Here
 * every applied row must match the file of the same journal time, byte for byte; an edited file, or an
 * applied migration that has no file any more, stops the deploy before anything else is touched
 * (R15: migrations are forward-only; R16: fail closed). Returns the count of mismatches (0 = fine).
 */
export async function changedMigrations(
  client: Queryable,
  files: readonly MigrationFileHash[],
): Promise<number> {
  const exists = await client.query(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
  );
  if (exists.rows[0]?.present !== true) return 0;
  const { rows } = await client.query(APPLIED_MIGRATIONS);
  const byTime = new Map(files.map((f) => [f.folderMillis, f.hash]));
  let changed = 0;
  for (const row of rows) {
    if (byTime.get(Number(row.created_at)) !== row.hash) changed += 1;
  }
  return changed;
}

const COUNT_MIGRATIONS =
  "select case when to_regclass('drizzle.__drizzle_migrations') is null then 0 " +
  "else (select count(*) from drizzle.__drizzle_migrations) end::int as n";

async function migrationCount(client: Queryable): Promise<number> {
  const { rows } = await client.query(COUNT_MIGRATIONS);
  return Number(rows[0]?.n ?? 0);
}

export async function runMigrator(deps: MigratorDeps, event: unknown): Promise<MigratorReport> {
  const { config, log } = deps;
  // The deploy sends { action: "migrate" }; anything else is not for this function.
  const action =
    typeof event === "object" && event !== null
      ? (event as { action?: unknown }).action
      : undefined;
  if (action !== "migrate") throw new Error("migrator: unknown action");

  let step: "connect" | "tls" | "roles" | "verify" | "migrate" | "accounts" | "first_admin" =
    "connect";
  let client: MasterConnection | undefined;
  let refused = false;
  let changed = 0;
  try {
    client = await deps.connect(config.masterUrl);

    // Refuse to run on a connection without TLS (R2, R16), before any role or table is touched.
    step = "tls";
    const { rows: ssl } = await client.query(
      "select ssl from pg_stat_ssl where pid = pg_backend_pid()",
    );
    if (ssl[0]?.ssl !== true) {
      refused = true;
      throw new Error("migrator: the connection is not encrypted");
    }

    step = "roles";
    const roles = await ensureRoles(client, config.rolePasswords);

    // C.14: before any migration runs, an applied migration whose file changed stops the deploy.
    step = "verify";
    changed = await changedMigrations(client, deps.fileHashes(config.migrationsDir));
    if (changed > 0) throw new Error("migrator: an applied migration changed");

    step = "migrate";
    const before = await migrationCount(client);
    await deps.migrate(config.masterUrl, config.migrationsDir);
    const after = await migrationCount(client);

    // C.10: the platform ledger accounts (postTransaction never creates one). Runs after the
    // migrations, as the table owner, and is idempotent: a second run creates none.
    step = "accounts";
    const accounts = await deps.ensureSystemAccounts(config.masterUrl);

    // WPU-Z18: the first superadmin, when FirstAdminSub holds a canonical UUID and admin_users has no
    // row at all. An unset, placeholder or malformed value writes nothing. The log holds the decision
    // and at most the first 8 characters of a valid sub (R14), never the new admin id.
    step = "first_admin";
    const plan = firstAdminDecision(config.firstAdminSub);
    let firstAdmin: FirstAdminDecision;
    if (plan.kind === "skip") {
      firstAdmin = plan.decision;
      log({ event: "migrator_first_admin", decision: firstAdmin });
    } else {
      const done = await deps.bootstrapFirstAdmin(config.masterUrl, plan.sub);
      firstAdmin = done.outcome === "inserted" ? "inserted" : "skipped: admins exist";
      log({ event: "migrator_first_admin", decision: firstAdmin, subPrefix: subPrefix(plan.sub) });
    }

    const report: MigratorReport = {
      rolesCreated: roles.created,
      rolesEnabled: roles.enabled,
      rolesUnchanged: roles.unchanged,
      migrationsApplied: after - before,
      systemAccountsCreated: accounts.created,
      firstAdmin,
    };
    log({ event: "migrator_done", ...report });
    return report;
  } catch {
    // The cause is dropped on purpose: a driver message can carry the URL or a statement (R14).
    if (refused) {
      log({ event: "migrator_refused", reason: "no_tls" });
      throw new Error("migrator: the connection is not encrypted");
    }
    if (step === "verify" && changed > 0) {
      log({ event: "migrator_refused", reason: "migration_changed", count: changed });
      throw new Error("migrator: an applied migration changed");
    }
    log({ event: "migrator_failed", step });
    if (step === "connect") throw new Error("migrator: could not connect");
    if (step === "tls") throw new Error("migrator: could not check the connection");
    if (step === "roles") throw new Error("migrator: could not prepare the roles");
    if (step === "verify") throw new Error("migrator: could not check the applied migrations");
    if (step === "accounts") throw new Error("migrator: could not prepare the ledger accounts");
    if (step === "first_admin") throw new Error("migrator: could not bootstrap the first admin");
    throw new Error("migrator: the migrations failed");
  } finally {
    await client?.end().catch(() => undefined);
  }
}
